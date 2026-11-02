"""A master opened before analysis must receive results without losing edits."""
import shutil

from backend.tests.test_cclip import full, video  # noqa: F401


def original_project(full, video):
    client, wb, sessions, _ = full
    from backend.models.project import Project, ProjectStatus
    from backend.services.studio import store
    with sessions() as db:
        project = Project(name='Async synthetic', status=ProjectStatus.COMPLETED)
        db.add(project); db.commit(); pid = project.id
    raw = store.directory(pid) / 'raw'; raw.mkdir(parents=True)
    shutil.copyfile(video, raw / 'input.mp4')
    return client, wb, sessions, pid, raw


def complete(sessions, pid, raw):
    from backend.models.clip import Clip
    with sessions() as db:
        db.add_all([Clip(project_id=pid, title='AI one', start_time=0, end_time=2, duration=2),
                    Clip(project_id=pid, title='AI two', start_time=3, end_time=5, duration=2)])
        db.commit()
    (raw / 'input.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n', encoding='utf-8')


def test_results_arriving_after_first_open_merge_with_manual_edits(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    early = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert not early['project']['clips'] and not early['project']['cues']
    project = early['project']
    project['clips'].append({'id': 'manual', 'name': 'My cut', 'start': 2, 'end': 2.8, 'color': 1, 'origin': 'manual'})
    project['bookmarks'] = [{'id': 'mark', 'time': 2, 'label': 'Keep'}]
    wb.save(early['id'], project, early['revision'])
    complete(sessions, pid, raw)
    result = client.post(f'/api/cclip/projects/{pid}/timeline', json={})
    assert result.status_code == 200
    current = result.json()
    assert len(current['project']['clips']) == 3
    assert len(current['project']['cues']) == 2
    assert current['project']['clips'][-1]['id'] == 'manual'
    assert current['project']['bookmarks'] == project['bookmarks']
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json() == current
    assert client.delete(f'/api/cclip/workbench/{early["id"]}/unsaved').status_code == 200
    discarded = wb.get(early['id'])['project']
    assert len(discarded['clips']) == 2 and all(clip['origin'] == 'ai' for clip in discarded['clips'])
    assert len(discarded['cues']) == 2


def test_refresh_preserves_deleted_ai_and_corrected_or_deleted_subtitles(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    complete(sessions, pid, raw)
    initial = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    project = initial['project']; project['clips'].pop(0)
    project['cues'][0]['text'] = 'My correction'; project['cues'].pop(1)
    edited = wb.save(initial['id'], project, initial['revision'])
    result = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert result == edited


def test_old_empty_master_gets_results_once_without_resetting_manual_cut(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    early = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    document = early['project']
    document['clips'] = [{'id': 'manual-legacy', 'name': 'My cut', 'start': 2, 'end': 2.8, 'color': 1, 'origin': 'manual'}]
    wb.save(early['id'], document, early['revision'])
    # This is the c1c1627 shape: an already linked empty master has no source snapshot.
    with wb.connect() as db:
        if 'source_snapshot' in {r['name'] for r in db.execute('pragma table_info(cclip_links)')}:
            db.execute("update cclip_links set source_snapshot='' where wb_id=?", (early['id'],))
    complete(sessions, pid, raw)
    result = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert len(result['project']['clips']) == 3 and len(result['project']['cues']) == 2
    assert result['project']['clips'][-1]['id'] == 'manual-legacy'
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json() == result


def test_draft_source_identity_survives_platform_trim_and_new_version():
    from backend.cclip.source_sync import draft_sources
    source = {'id': 'source', 'start': 0, 'end': 10}
    data = {'drafts': [{'id': 'platform', 'scenes': [{'id': 'scene', 'start': 0, 'end': 10}]}]}
    draft_sources(data, [source])
    data['drafts'][0]['scenes'][0].update(start=2, end=4)
    data['drafts'].append({'id': 'new-version', 'parent_draft_id': 'platform',
                           'scenes': [{'id': 'another', 'start': 2, 'end': 4}]})
    draft_sources(data, [source, {'id': 'manual-overlap', 'start': 2, 'end': 4}])
    assert data['cclip_source_clips'] == {'platform': 'source', 'new-version': 'source'}


def test_running_export_allows_read_and_defers_only_new_source_import(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    early = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    job = wb.add_job(early['id'], 'export')
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).status_code == 200
    complete(sessions, pid, raw)
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).status_code == 409
    assert not wb.get(early['id'])['project']['clips']
    wb.update_job(job['id'], status='completed')
    assert len(client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()['project']['clips']) == 2


def local_analysis(wb, record, clips):
    from backend.workbench.adapters import refresh_ai_sequence
    from backend.workbench.models import Project
    document = record['project']
    result = wb.save(record['id'], Project.model_validate({**document, 'highlights': clips,
                     'clips': refresh_ai_sequence(document, clips)}).document(), record['revision'])
    job = wb.add_job(record['id'], 'analyze')
    wb.update_job(job['id'], status='completed', result={'record': result})
    return result


def test_repeated_local_analysis_owns_recommendations_and_does_not_duplicate(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    complete(sessions, pid, raw)
    record = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    one = {'id': 'local-one', 'name': 'New pick', 'start': 1, 'end': 3, 'origin': 'ai', 'color': 0}
    local_analysis(wb, record, [one])
    synced = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert synced['project']['highlights'] == [one]
    two = {**one, 'id': 'local-two', 'start': 2, 'end': 4}
    local_analysis(wb, synced, [two])
    final = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert final['project']['clips'] == final['project']['highlights'] == [two]
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json() == final
    # A genuinely newer original pipeline result takes ownership once, without
    # being replaced again by the already-consumed local job on the next refresh.
    from backend.models.clip import Clip
    with sessions() as db:
        db.query(Clip).filter(Clip.project_id == pid).delete()
        db.add(Clip(project_id=pid, title='Later upstream', start_time=0, end_time=4, duration=4)); db.commit()
    upstream = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    assert len(upstream['project']['clips']) == 1 and upstream['project']['clips'][0]['name'] == 'Later upstream'
    assert client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json() == upstream


def test_legacy_duplicate_repair_preserves_real_manual_edits(full, video):
    client, wb, sessions, pid, raw = original_project(full, video)
    complete(sessions, pid, raw)
    record = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    picks = [{'id': f'old-{index}', 'name': f'Pick {index}', 'start': index, 'end': index + 1, 'origin': 'ai', 'color': index} for index in range(3)]
    first = local_analysis(wb, record, picks)
    # Reproduce the old corruption, including one renamed and one trimmed pick.
    wrong = first['project']; wrong['highlights'] = record['project']['highlights']
    wrong['clips'][1]['name'] = 'My title'; wrong['clips'][2]['end'] -= .2
    wrong['clips'].append({**picks[0], 'id': 'manual-unique', 'origin': 'manual'})
    broken = wb.save(first['id'], wrong, first['revision'])
    # The affected installed version had no one-time repair marker.
    import json
    with wb.connect() as db:
        row = db.execute('SELECT source_snapshot FROM cclip_links WHERE wb_id=?', (first['id'],)).fetchone()
        snapshot = json.loads(row['source_snapshot']); snapshot.pop('legacy_ai_repair_done', None)
        db.execute('UPDATE cclip_links SET source_snapshot=? WHERE wb_id=?', (json.dumps(snapshot), first['id']))
    latest = {**picks[0], 'id': 'latest'}
    local_analysis(wb, broken, [latest])
    result = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()['project']
    assert {clip['id'] for clip in result['clips']} == {'old-1', 'old-2', 'manual-unique', 'latest'}
    assert result['highlights'] == [latest]
    from backend.services.studio import store
    assert 'old-0' in store.read(pid)['cclip_retired_source_ids']
    # A later explicit import/restore of an old pick is user work, not another
    # legacy corruption. The migration must never delete it repeatedly.
    current = wb.get(first['id'])
    current['project']['clips'].append({**picks[0], 'origin': 'manual'})
    wb.save(current['id'], current['project'], current['revision'])
    restored = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()['project']
    assert any(clip['id'] == 'old-0' and clip['origin'] == 'manual' for clip in restored['clips'])
