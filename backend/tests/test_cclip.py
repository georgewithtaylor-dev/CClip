"""Full product routes and real timeline/Studio handoff; no provider calls."""
import hashlib
import subprocess

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from backend.workbench.app import create_app as standalone


@pytest.fixture
def full(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTOCLIP_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUTOCLIP_APP_DIR', str(tmp_path))
    monkeypatch.setenv('AUTOCLIP_CCLIP_FULL_APP', '1')
    from backend.core import database
    from backend import app_factory
    from backend.models.base import Base
    engine = database.create_database_engine(f'sqlite:///{tmp_path / "classic.sqlite3"}')
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(database, 'SessionLocal', sessions)
    monkeypatch.setattr(app_factory, 'engine', engine)
    from backend.cclip.app import create_app
    frontend = tmp_path / 'frontend'
    frontend.mkdir()
    (frontend / 'cclip.html').write_text('<html><title>CClip</title><main>home</main></html>')
    (frontend / 'workbench.html').write_text('<meta name="workbench-service" content="disabled">')
    app = create_app(tmp_path, frontend)

    def dependency():
        with sessions() as db:
            yield db

    app.dependency_overrides[database.get_db] = dependency
    with TestClient(app) as client:
        token = client.get('/api/workbench/session').json()['session']
        client.headers['x-workbench-session'] = token
        yield client, app.state.store, sessions, tmp_path
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture
def video(tmp_path):
    from backend.utils.ffmpeg_utils import get_ffmpeg_path
    source = tmp_path / 'synthetic.mp4'
    subprocess.run([get_ffmpeg_path(), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x240:r=30:d=5',
                    '-f', 'lavfi', '-i', 'sine=frequency=510:duration=5', '-c:v', 'libx264', '-threads', '1',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(source)], check=True, timeout=30)
    return source


def saved_timeline(client, video):
    with video.open('rb') as stream:
        response = client.post('/api/workbench/assets', files={'video': ('sample.mp4', stream, 'video/mp4')})
    assert response.status_code == 200
    asset = response.json()
    document = {'schemaVersion': 1, 'title': 'Synthetic edit',
                'source': {key: asset[key] for key in ('assetId', 'name', 'bytes', 'duration', 'kind', 'width', 'height')},
                'clips': [{'id': 'one', 'name': 'One', 'start': .5, 'end': 2, 'color': 0, 'origin': 'manual'},
                          {'id': 'two', 'name': 'Two', 'start': 3, 'end': 4.5, 'color': 1, 'origin': 'manual'}],
                'cues': [{'id': 'cue', 'start': .5, 'end': 1.5, 'text': 'Edited local caption'}],
                'bookmarks': [{'id': 'mark', 'time': 1, 'label': 'Revisit'}], 'highlights': []}
    result = client.post('/api/workbench/projects', json=document)
    assert result.status_code == 200
    return result.json()


def handoff(client, record):
    result = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision']})
    assert result.status_code == 200, result.text
    return result.json()


def test_catalog_hides_unsaved_and_deduplicates_linked_edits(full, video):
    client, _, _, _ = full
    record = saved_timeline(client, video)
    assert client.get('/api/cclip/projects').json() == []
    assert client.post(f'/api/cclip/workbench/{record["id"]}/saved', json={'revision': record['revision']}).status_code == 200
    items = client.get('/api/cclip/projects').json()
    assert len(items) == 1 and items[0]['route'] == f'/workbench/{record["id"]}'
    linked = handoff(client, record)
    items = client.get('/api/cclip/projects').json()
    assert len(items) == 1 and items[0]['route'] == f'/project/{linked["projectId"]}'
    assert items[0]['saved_edits'] == 1


@pytest.mark.parametrize('mixed', [False, True])
def test_master_timeline_preserves_manual_and_ai_provenance(full, video, mixed):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    if mixed:
        document = record['project']
        document['clips'][1]['origin'] = 'ai'
        record = wb.save(record['id'], document, record['revision'])
    linked = handoff(client, record)
    response = client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={})
    assert response.status_code == 200
    master = response.json()['project']
    assert [clip['origin'] for clip in master['clips']] == ['manual', 'ai' if mixed else 'manual']
    assert len(master['highlights']) == int(mixed)


def test_selected_clip_handoff_keeps_master_and_other_outputs(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    first = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision'], 'clipId': 'two'})
    assert first.status_code == 200
    linked = first.json()
    from backend.services.studio import store as studio
    draft = studio.read(linked['projectId'])['drafts'][0]
    assert len(draft['scenes']) == 1 and draft['scenes'][0]['start'] == 3
    assert draft['subtitle_cues'] == []
    assert wb.get(record['id'])['project'] == record['project']
    repeated = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision'], 'clipId': 'two'})
    assert repeated.json()['draftId'] == linked['draftId']
    second = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision'], 'clipId': 'one'})
    assert second.status_code == 200 and second.json()['projectId'] == linked['projectId']
    assert second.json()['draftId'] != linked['draftId']
    assert len(studio.read(linked['projectId'])['drafts']) == 2
    assert len(client.get('/api/cclip/projects').json()) == 1
    assert client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision'], 'clipId': 'missing'}).status_code == 404


def test_thumbnail_is_cached_local_image_and_rejects_invalid_positions(full, video):
    import concurrent.futures
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    asset = record['project']['source']['assetId']
    source_hash = hashlib.sha256(wb.asset_path(asset).read_bytes()).hexdigest()
    url = f'/api/workbench/assets/{asset}/thumbnail?time=1'
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: client.get(url), range(2)))
    assert all(result.status_code == 200 and result.content.startswith(b'\xff\xd8') for result in results)
    assert results[0].content == results[1].content
    assert hashlib.sha256(wb.asset_path(asset).read_bytes()).hexdigest() == source_hash
    for position in ['-1', '6', 'nan', 'inf']:
        assert client.get(f'/api/workbench/assets/{asset}/thumbnail?time={position}').status_code == 422


def test_discard_only_removes_unsaved_edits_and_unshared_asset(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    asset_id = record['project']['source']['assetId']
    assert client.delete(f'/api/cclip/workbench/{record["id"]}/unsaved').status_code == 200
    with pytest.raises(KeyError):
        wb.get(record['id'])
    assert not (wb.root / 'assets' / asset_id).exists()
    saved = saved_timeline(client, video)
    assert client.post(f'/api/cclip/workbench/{saved["id"]}/saved', json={'revision': saved['revision']}).status_code == 200
    assert client.delete(f'/api/cclip/workbench/{saved["id"]}/unsaved').status_code == 200
    assert wb.get(saved['id'])['project'] == saved['project']


def test_saving_stale_revision_and_discarding_running_project_are_blocked(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    assert client.post(f'/api/cclip/workbench/{record["id"]}/saved', json={'revision': record['revision'] + 1}).status_code == 409
    job = wb.add_job(record['id'], 'export')
    assert client.delete(f'/api/cclip/workbench/{record["id"]}/unsaved').status_code == 409
    assert wb.get(record['id'])
    wb.update_job(job['id'], status='failed')
    assert client.delete('/api/cclip/unsaved').status_code == 200
    with pytest.raises(KeyError):
        wb.get(record['id'])


def test_edited_platform_export_keeps_original_template_and_updates_output_link(full, video, monkeypatch):
    client, _, _, _ = full
    linked = handoff(client, saved_timeline(client, video))
    from backend.services.studio import jobs, store
    from backend.services.studio.models import Draft
    state = store.read(linked['projectId'])
    draft = state['drafts'][0]
    old_job = {'job_id': '1' * 32, 'draft_id': draft['id'], 'revision': draft['revision'], 'status': 'completed', 'percent': 100, 'created_at': store.now(), 'title': draft['title']}
    state['jobs'] = [old_job]
    state['output_variants'] = [{'id': 'original-variant', 'draft_id': draft['id'], 'draft_revision': draft['revision'], 'strategy_id': 'douyin', 'html_template': 'editorial', 'branding': {'outro_enabled': True, 'outro_version': 'v1'}, 'render_job_id': old_job['job_id'], 'status': 'completed', 'post': {'title': 'Keep my copy', 'description': '', 'tags': []}}]
    store.write(linked['projectId'], state)
    draft['title'] = 'Edited platform title'
    current = store.save_draft(linked['projectId'], Draft.model_validate(draft))
    captured = {}
    def exported(project_id, value, **kwargs):
        captured.update(kwargs)
        job = {**old_job, 'job_id': '2' * 32, 'revision': value.revision, 'title': value.title}
        store.change(project_id, lambda data: data['jobs'].insert(0, job))
        return job
    monkeypatch.setattr(jobs, 'export', exported)
    response = client.post(f'/api/cclip/projects/{linked["projectId"]}/drafts/{current["id"]}/export', json={'revision': current['revision']})
    assert response.status_code == 200
    assert captured['html_template'] == 'editorial'
    assert captured['brand_outro'] is True
    updated = store.read(linked['projectId'])
    assert updated['output_variants'][0]['render_job_id'] == '2' * 32
    assert updated['output_variants'][0]['draft_revision'] == current['revision']
    assert updated['output_variants'][0]['post']['title'] == 'Keep my copy'
    assert any(job['job_id'] == old_job['job_id'] for job in updated['jobs'])
    # An explicit editor choice wins over the old automatic platform snapshot.
    explicit = store.save_draft(linked['projectId'], Draft.model_validate({**current, 'template_override': 'classic'}))
    captured.clear()
    response = client.post(f'/api/cclip/projects/{linked["projectId"]}/drafts/{explicit["id"]}/export', json={'revision': explicit['revision']})
    assert response.status_code == 200
    assert 'html_template' not in captured


def test_discard_preserves_shared_asset_and_retries_locked_file_cleanup(full, video, monkeypatch):
    client, wb, _, _ = full
    first = saved_timeline(client, video)
    second = client.post('/api/workbench/projects', json=first['project']).json()
    assert client.post(f'/api/cclip/workbench/{second["id"]}/saved', json={'revision': second['revision']}).status_code == 200
    assert client.delete(f'/api/cclip/workbench/{first["id"]}/unsaved').status_code == 200
    asset_id = second['project']['source']['assetId']
    assert wb.asset_path(asset_id).is_file()
    transient = saved_timeline(client, video)
    import backend.cclip.projects as catalogue
    original = catalogue.shutil.rmtree
    monkeypatch.setattr(catalogue.shutil, 'rmtree', lambda *_args, **_kwargs: (_ for _ in ()).throw(PermissionError('locked synthetic file')))
    assert client.delete(f'/api/cclip/workbench/{transient["id"]}/unsaved').status_code == 200
    with wb.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM cclip_cleanup_paths').fetchone()[0] > 0
    monkeypatch.setattr(catalogue.shutil, 'rmtree', original)
    assert client.delete('/api/cclip/unsaved').status_code == 200
    with wb.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM cclip_cleanup_paths').fetchone()[0] == 0
    assert wb.get(second['id'])['project'] == second['project']


def test_discard_restores_explicit_save_after_task_persisted_unsaved_edits(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    assert client.post(f'/api/cclip/workbench/{record["id"]}/saved', json={'revision': record['revision']}).status_code == 200
    edited = {**record['project'], 'title': 'Unsaved task working copy'}
    wb.save(record['id'], edited, record['revision'])
    job = wb.add_job(record['id'], 'cleanup')
    assert client.delete(f'/api/cclip/workbench/{record["id"]}/unsaved').status_code == 409
    wb.update_job(job['id'], status='completed')
    assert client.delete(f'/api/cclip/workbench/{record["id"]}/unsaved').status_code == 200
    restored = wb.get(record['id'])['project']
    assert restored['title'] == record['project']['title']
    assert restored['clips'] == record['project']['clips']
    assert restored['cues'] == record['project']['cues']
    assert len(client.get('/api/cclip/projects').json()) == 1


def test_source_not_ready_is_recoverable_and_project_remains_in_catalog(full):
    client, _, sessions, _ = full
    from backend.models.project import Project, ProjectStatus
    with sessions() as db:
        project = Project(name='Waiting for local source', status=ProjectStatus.FAILED)
        db.add(project); db.commit(); project_id = project.id
    response = client.post(f'/api/cclip/projects/{project_id}/timeline', json={'draftId': None})
    assert response.status_code == 409
    row = client.get('/api/cclip/projects').json()[0]
    assert row['project_id'] == project_id
    assert row['updated'].endswith('+00:00')


def test_delete_linked_project_removes_all_edits_but_preserves_another_saved_edit(full, video):
    client, wb, sessions, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    other = client.post('/api/workbench/projects', json=record['project']).json()
    client.post(f'/api/cclip/workbench/{other["id"]}/saved', json={'revision': other['revision']})
    checksum = hashlib.sha256(video.read_bytes()).hexdigest()
    response = client.delete(f'/api/cclip/projects/project/{linked["projectId"]}')
    assert response.status_code == 200
    with pytest.raises(KeyError):
        wb.get(record['id'])
    assert wb.asset_path(other['project']['source']['assetId']).is_file()
    assert wb.get(other['id'])['project'] == other['project']
    from backend.models.project import Project
    with sessions() as db:
        assert db.get(Project, linked['projectId']) is None
    assert len(client.get('/api/cclip/projects').json()) == 1
    assert hashlib.sha256(video.read_bytes()).hexdigest() == checksum


def test_previous_workbench_entry_cannot_reach_full_product(tmp_path):
    with TestClient(standalone(tmp_path)) as client:
        assert client.get('/cclip.html').status_code == 404
        assert client.get('/api/v1/studio/platform-strategies').status_code == 404


def test_full_home_settings_and_platforms_are_served_from_same_session(full):
    client, _, _, _ = full
    assert '<title>CClip</title>' in client.get('/cclip.html').text
    platforms = client.get('/api/v1/studio/platform-strategies')
    assert platforms.status_code == 200
    assert {'douyin', 'xiaohongshu', 'bilibili'} <= {item['id'] for item in platforms.json()['strategies']}
    assert client.get('/api/v1/studio/readiness').status_code == 200
    assert 'content="enabled"' in client.get('/workbench.html').text
    client.cookies.clear()
    assert client.get('/api/v1/studio/platform-strategies').status_code == 401


def test_original_routes_reject_foreign_origin_and_missing_write_session(full):
    client, _, _, _ = full
    assert client.get('/api/v1/studio/readiness', headers={'origin': 'https://foreign.invalid'}).status_code == 403
    assert client.post('/api/v1/studio/analysis-preferences', json={}, headers={'x-workbench-session': ''}).status_code == 403


def test_real_timeline_handoff_preserves_edits_and_source(full, video):
    client, wb, _, _ = full
    checksum = hashlib.sha256(video.read_bytes()).hexdigest()
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    from backend.services.studio import store
    from backend.services.studio.models import Draft
    from backend.services.studio.render import draft_subtitle_entries
    draft = store.read(linked['projectId'])['drafts'][0]
    assert [(item['start'], item['end']) for item in draft['scenes']] == [(.5, 2), (3, 4.5)]
    assert draft['subtitle_cues'][0]['text'] == 'Edited local caption'
    assert draft_subtitle_entries(linked['projectId'], Draft.model_validate(draft))[0]['text'] == 'Edited local caption'
    reopened = client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={'draftId': linked['draftId']})
    assert reopened.status_code == 200
    assert reopened.json()['id'] == record['id']
    assert reopened.json()['project']['bookmarks'] == record['project']['bookmarks']
    assert hashlib.sha256(video.read_bytes()).hexdigest() == checksum
    assert wb.get(record['id'])['project']['cues'] == record['project']['cues']


def test_studio_changes_refresh_an_unchanged_timeline_without_new_asset(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    from backend.services.studio import store
    from backend.services.studio.models import Draft
    draft = store.read(linked['projectId'])['drafts'][0]
    draft['scenes'][0]['start'] = .75
    store.save_draft(linked['projectId'], Draft.model_validate(draft))
    response = client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={'draftId': linked['draftId']})
    assert response.status_code == 200
    assert response.json()['project']['clips'][0]['start'] == .75
    assert len(list((wb.root / 'assets').iterdir())) == 1
    assert response.json()['project']['bookmarks'] == record['project']['bookmarks']


def test_conflicting_studio_and_timeline_changes_preserve_both_versions(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    from backend.services.studio import store
    from backend.services.studio.models import Draft
    draft = store.read(linked['projectId'])['drafts'][0]
    draft['title'] = 'Other edit'
    store.save_draft(linked['projectId'], Draft.model_validate(draft))
    edited = {**record['project'], 'title': 'Timeline edit'}
    saved = wb.save(record['id'], edited, record['revision'])
    assert client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={'draftId': linked['draftId']}).status_code == 409
    assert client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': saved['revision']}).status_code == 409
    assert wb.get(record['id'])['project']['title'] == 'Timeline edit'
    assert store.read(linked['projectId'])['drafts'][0]['title'] == 'Other edit'


def test_noop_saves_reopen_newer_packaging_without_false_conflict(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    from backend.services.studio import store
    from backend.services.studio.models import Draft
    draft = store.read(linked['projectId'])['drafts'][0]
    draft['title'] = 'New packaging title'
    draft['aspect'] = 'landscape'
    draft['scenes'][0]['end'] = 2.4
    newest = store.save_draft(linked['projectId'], Draft.model_validate(draft))
    # The UI saves before a handoff; the save revision changes even without edits.
    for _ in range(2):
        record = wb.save(record['id'], record['project'], record['revision'])
    reopened = handoff(client, record)
    assert reopened['draftId'] == linked['draftId']
    assert store.read(linked['projectId'])['drafts'][0] == newest
    refreshed = client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={'draftId': linked['draftId']})
    assert refreshed.status_code == 200
    assert refreshed.json()['project']['clips'][0]['end'] == 2.4
    assert refreshed.json()['project']['bookmarks'] == record['project']['bookmarks']


@pytest.mark.parametrize('diverged', [False, True])
def test_old_link_migration_backfills_only_known_baselines(full, video, diverged):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    with wb.connect() as connection:
        connection.execute('DROP TABLE cclip_links')
        connection.execute('''CREATE TABLE cclip_links (
          wb_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, draft_id TEXT NOT NULL DEFAULT '',
          draft_revision INTEGER NOT NULL DEFAULT 0, wb_revision INTEGER NOT NULL,
          UNIQUE(project_id,draft_id))''')
        connection.execute('INSERT INTO cclip_links VALUES(?,?,?,?,?)',
                           (record['id'], linked['projectId'], linked['draftId'], linked['revision'], record['revision']))
    if diverged:
        record = wb.save(record['id'], {**record['project'], 'title': 'A real timeline edit'}, record['revision'])
    before = wb.get(record['id'])
    from backend.cclip.bridge import initialize_links, project_fingerprint
    initialize_links(wb)
    initialize_links(wb)  # Restarting must not change or reset the baseline.
    with wb.connect() as connection:
        rows = connection.execute('SELECT * FROM cclip_links').fetchall()
    assert len(rows) == 1
    assert rows[0]['project_id'] == linked['projectId']
    assert rows[0]['draft_id'] == linked['draftId']
    assert rows[0]['wb_fingerprint'] == ('' if diverged else project_fingerprint(record['project']))
    assert wb.get(record['id']) == before


def test_cclip_never_reuses_upstream_telemetry_keys(monkeypatch):
    from backend.services.studio.qa import telemetry
    monkeypatch.setenv('AUTOCLIP_POSTHOG_KEY', 'synthetic-key')
    monkeypatch.setenv('AUTOCLIP_CCLIP_FULL_APP', '1')
    assert telemetry._key() == ''


def test_platform_presets_reuse_upstream_without_changing_edits_or_language(full, video, monkeypatch):
    client, _, _, _ = full
    linked = handoff(client, saved_timeline(client, video))
    from backend.services.studio import store
    from backend.services.platform_strategy import PLATFORM_STRATEGIES
    from backend.services.studio.models import Draft
    draft = store.read(linked['projectId'])['drafts'][0]
    def forbidden(*args, **kwargs):
        pytest.fail('Choosing an output preset must not call a provider')
    monkeypatch.setattr('backend.services.studio.intelligence.text_json', forbidden)
    for strategy in PLATFORM_STRATEGIES.values():
        result = client.post('/api/cclip/platform-preset', json={'draft': draft, 'strategyId': strategy.id})
        assert result.status_code == 200
        changes = result.json()['changes']
        combined = Draft.model_validate({**draft, **changes})
        assert combined.aspect == strategy.aspect
        assert combined.subtitle_style == strategy.subtitle_style
        assert combined.platform_preset == strategy.id
        assert combined.language == draft['language']
        assert combined.scenes[0].start == draft['scenes'][0]['start']
        assert combined.subtitle_cues[0].text == draft['subtitle_cues'][0]['text']
    assert client.post('/api/cclip/platform-preset', json={'draft': draft, 'strategyId': 'missing'}).status_code == 422
    assert store.read(linked['projectId'])['drafts'][0] == draft


def test_bad_caption_intervals_and_out_of_source_captions_are_rejected(full, video):
    client, _, _, _ = full
    linked = handoff(client, saved_timeline(client, video))
    from backend.services.studio import store
    draft = store.read(linked['projectId'])['drafts'][0]
    endpoint = f'/api/v1/studio/{linked["projectId"]}/drafts/{linked["draftId"]}'
    for cues in [[{'start': 2, 'end': 1, 'text': 'Invalid'}], [{'start': 4, 'end': 6, 'text': 'Outside source'}]]:
        response = client.put(endpoint, json={**draft, 'subtitle_cues': cues})
        assert response.status_code in (400, 422)
        assert store.read(linked['projectId'])['drafts'][0] == draft


def test_trim_discards_stale_relative_crop_track_and_keeps_settings(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    linked = handoff(client, record)
    from backend.services.studio import store
    from backend.services.studio.models import Draft
    draft = store.read(linked['projectId'])['drafts'][0]
    draft['aspect'] = 'portrait'
    draft['scenes'][0]['crop_track'] = [{'start': 0, 'crop_x': .3}, {'start': 1, 'crop_x': .7}]
    draft['scenes'][0]['framing_source'] = 'auto'
    store.save_draft(linked['projectId'], Draft.model_validate(draft))
    refreshed = client.post(f'/api/cclip/projects/{linked["projectId"]}/timeline', json={'draftId': linked['draftId']}).json()
    refreshed['project']['clips'][0]['start'] = 1
    changed = wb.save(record['id'], refreshed['project'], refreshed['revision'])
    handoff(client, changed)
    after = store.read(linked['projectId'])['drafts'][0]
    assert after['aspect'] == 'portrait'
    assert after['scenes'][0]['crop_track'] is None
    assert after['scenes'][0]['framing_adjusted'] is True
    assert after['scenes'][0]['start'] == 1


def test_active_workbench_job_is_reported_and_blocks_handoff(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    assert client.get('/api/cclip/activity').json() == {'active': False}
    wb.add_job(record['id'], 'export')
    assert client.get('/api/cclip/activity').json() == {'active': True}
    assert client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft', json={'revision': record['revision']}).status_code == 409


def test_global_model_settings_feed_timeline_and_changes_revoke_old_consent(full, video):
    client, _, _, _ = full
    record = saved_timeline(client, video)
    from backend.services import ai_model_settings as ai
    configuration = ai.ModelSettings(connections=[ai.Connection(id='local', name='Synthetic local model', provider='compatible', base_url='http://127.0.0.1:13999/v1')],
                                    analysis=ai.Assignment(connection_id='local', model='fixture-model', capability='text'))
    ai.path().write_text(configuration.model_dump_json(), encoding='utf-8')
    settings = client.get('/api/workbench/analysis-settings')
    assert settings.json() == {'configured': True, 'baseUrl': 'http://127.0.0.1:13999/v1', 'model': 'fixture-model'}
    consent = client.post(f'/api/workbench/projects/{record["id"]}/analysis-consent', json={'approved': True, 'revision': record['revision']}).json()
    configuration.analysis.model = 'changed-model'
    ai.path().write_text(configuration.model_dump_json(), encoding='utf-8')
    response = client.post(f'/api/workbench/projects/{record["id"]}/jobs', json={'kind': 'analyze', 'revision': record['revision'], 'consentId': consent['consentId']})
    assert response.status_code == 403
    assert 'apiKey' not in client.get('/api/workbench/analysis-settings').text


def test_cclip_outro_is_own_asset_and_leaves_original_mode_intact(full, monkeypatch):
    from backend.services import output_branding as branding
    class Resolved(Exception):
        pass
    def source_only(command, **kwargs):
        selected.append(command[command.index('-i') + 1])
        raise Resolved()
    selected = []
    monkeypatch.setattr(branding.subprocess, 'run', source_only)
    params = {'fps': '30', 'channels': 2, 'sample_rate': '48000', 'timescale': '15360'}
    with pytest.raises(Resolved):
        branding._designed_outro(1080, 1920, params)
    assert selected[-1].replace('\\', '/').endswith('/cclip-outro/outro-vertical.mp4')
    monkeypatch.delenv('AUTOCLIP_CCLIP_FULL_APP')
    with pytest.raises(Resolved):
        branding._designed_outro(1920, 1080, params)
    assert selected[-1].replace('\\', '/').endswith('/outro/outro-horizontal.mp4')
