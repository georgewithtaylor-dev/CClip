"""The current source catalogue, edited versions, cover jobs and publish kit agree."""
from io import BytesIO

from PIL import Image

from backend.tests.test_cclip import full, video  # noqa: F401


def project(full, video):
    client, wb, _, _ = full
    with video.open('rb') as stream:
        asset = client.post('/api/workbench/assets', files={'video': ('video.mp4', stream, 'video/mp4')}).json()
    record = wb.create({'schemaVersion': 1, 'title': 'Synthetic', 'source': {key: asset[key] for key in ('assetId', 'name', 'bytes', 'duration', 'kind', 'width', 'height')},
                        'clips': [{'id': 'first', 'name': 'First', 'start': .2, 'end': 2, 'origin': 'ai', 'color': 0},
                                  {'id': 'second', 'name': 'Second', 'start': 2, 'end': 4, 'origin': 'manual', 'color': 1}],
                        'cues': [], 'highlights': [], 'bookmarks': []})
    return client, wb, record


def test_catalog_prepares_all_clips_once_and_keeps_trimmed_split_version(full, video):
    client, wb, record = project(full, video)
    url = f'/api/cclip/workbench/{record["id"]}/platform-drafts'
    body = {'revision': record['revision'], 'clipId': 'second'}
    opened = client.post(url, json=body)
    assert opened.status_code == 200, opened.text
    result = opened.json()
    from backend.services.studio import store
    state = store.read(result['projectId'])
    assert len(state['drafts']) == 2
    assert {item['sourceId'] for item in result['drafts']} == {'first', 'second'}
    def edit(data):
        draft = next(item for item in data['drafts'] if item['id'] == result['draftId'])
        draft['title'] = 'My edit'; draft['revision'] += 1
        scene = draft['scenes'][0]
        draft['scenes'] = [{**scene, 'start': 2.2, 'end': 2.8}, {**scene, 'id': 'split-scene', 'start': 3, 'end': 3.8}]
    store.change(result['projectId'], edit)
    repeated = client.post(url, json=body).json()
    assert repeated['draftId'] == result['draftId']
    current = store.read(result['projectId'])
    assert len(current['drafts']) == 2
    assert next(item for item in current['drafts'] if item['id'] == result['draftId'])['title'] == 'My edit'
    # A newly added source clip appears beside the existing two, without a new combined draft.
    document = record['project']; document['clips'].append({'id': 'third', 'name': 'Third', 'start': 4, 'end': 4.7, 'origin': 'manual', 'color': 2})
    updated = wb.save(record['id'], document, record['revision'])
    assert len(client.post(url, json={'revision': updated['revision']}).json()['drafts']) == 3
    # Changing the master range creates a matching version, while the existing
    # split/trimmed platform version is still available in the same clip group.
    document = updated['project']; document['clips'][1].update(start=2.1, end=4.2)
    resized = wb.save(updated['id'], document, updated['revision'])
    reopened = client.post(url, json={'revision': resized['revision'], 'clipId': 'second'}).json()
    assert reopened['draftId'] != result['draftId']
    state = store.read(result['projectId'])
    version = next(item for item in state['drafts'] if item['id'] == reopened['draftId'])
    assert version['parent_draft_id'] == result['draftId']
    assert len(version['scenes']) == 1 and version['scenes'][0]['start'] == 2.1 and version['scenes'][0]['end'] == 4.2
    assert next(item for item in state['drafts'] if item['id'] == result['draftId'])['title'] == 'My edit'
    repeated = client.post(url, json={'revision': resized['revision'], 'clipId': 'second'}).json()
    assert repeated['draftId'] == reopened['draftId']


def test_output_deletion_survives_catalog_reopen_and_can_be_restored(full, video):
    client, _, record = project(full, video)
    url = f'/api/cclip/workbench/{record["id"]}/platform-drafts'
    result = client.post(url, json={'revision': record['revision']}).json()
    first = result['drafts'][0]
    removed = client.post(f'/api/cclip/projects/{result["projectId"]}/outputs/remove', json={'drafts': [{'id': first['draftId'], 'revision': 1}]}).json()
    assert len(client.post(url, json={'revision': record['revision']}).json()['drafts']) == 1
    assert client.post(f'/api/cclip/projects/{result["projectId"]}/outputs/restore', json=removed).status_code == 422
    restored = client.post(f'/api/cclip/projects/{result["projectId"]}/outputs/restore', json={'undoId': removed['undoId']})
    assert restored.status_code == 200
    assert len(client.post(url, json={'revision': record['revision']}).json()['drafts']) == 2


def test_unexported_draft_cover_uses_source_and_survives_reopen_without_cloud(full, video, monkeypatch):
    client, _, record = project(full, video)
    result = client.post(f'/api/cclip/workbench/{record["id"]}/platform-drafts', json={'revision': record['revision'], 'clipId': 'second'}).json()
    pid, did = result['projectId'], result['draftId']
    from backend.services import cover
    from backend.services.studio import store
    monkeypatch.setattr(cover, 'generate_image', lambda *_a, **_k: (_ for _ in ()).throw(AssertionError('no cloud')))
    clip = cover.load_cover_clip(pid, 'draft-' + did)
    assert cover.to_seconds(clip['start_time']) == 2 and cover.to_seconds(clip['end_time']) == 4
    path, at = cover.resolve_clip_frame(pid, 'draft-' + did)
    assert path.is_file() and 2 <= at < 4
    endpoint = f'/api/v1/publish/covers/{pid}/clips/draft-{did}'
    response = client.post(endpoint, json={'platform': 'xiaohongshu', 'title': 'My cover', 'subtitle': 'Subtitle', 'badge': '01', 'force_local': True, 'sync': True})
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['method'] == 'local_overlay'
    image = client.get(value['url'])
    assert Image.open(BytesIO(image.content)).size == (1080, 1440)
    assert client.get(endpoint + '?platform=xiaohongshu').json()['title'] == 'My cover'
    state = store.read(pid)
    assert not state['jobs']
    assert state['cclip_draft_covers'][did]['url'] == value['url']
    # The corresponding export kit uses the cover for the exact saved revision.
    store.change(pid, lambda data: data['jobs'].append({'job_id': 'c' * 32, 'draft_id': did, 'revision': 1, 'status': 'completed'}))
    from backend.services.studio.publish_kit import cover_file
    assert cover_file(pid, 'c' * 32, 'xiaohongshu')[0] == cover.cover_path(pid, 'draft-' + did, 'xiaohongshu')
    assert cover.get_cover(pid, 'studio-' + 'c' * 32, 'xiaohongshu')['title'] == 'My cover'
    assert cover.ensure_publish_cover_jpeg(pid, 'studio-' + 'c' * 32, platform='xiaohongshu') == image.content
    assert cover.draft_cover_for_export(pid, 'studio-' + 'c' * 32, 'douyin') is None
    store.change(pid, lambda data: data['jobs'][0].update(revision=2))
    assert cover.draft_cover_for_export(pid, 'studio-' + 'c' * 32, 'xiaohongshu') is None
    # A draft reference cannot be used to upload an unrendered source video.
    from backend.services.publish_export import load_clip_meta
    import pytest
    with pytest.raises(FileNotFoundError):
        load_clip_meta(pid, 'draft-' + did)


def test_cover_task_mirror_and_restart_recovery(full, video, monkeypatch):
    client, _, record = project(full, video)
    result = client.post(f'/api/cclip/workbench/{record["id"]}/platform-drafts', json={'revision': record['revision']}).json()
    from backend.services import cover
    from backend.services.studio import store
    pid = result['projectId']
    cover._remember_job({'job_id': 'isolated-cover', 'clip_id': 'draft-' + result['draftId'], 'project_id': pid, 'platform': 'douyin', 'status': 'running'})
    assert client.get(f'/api/v1/studio/{pid}').json()['cclip_cover_jobs']['isolated-cover']['status'] == 'running'
    monkeypatch.setattr(store, 'INSTANCE', 'restarted-test-instance')
    assert client.get(f'/api/v1/studio/{pid}').json()['cclip_cover_jobs']['isolated-cover']['status'] == 'failed'
    assert cover.get_job('isolated-cover')['status'] == 'failed'


def test_entering_outputs_after_local_analysis_never_reuses_an_older_shorter_pick(full, video):
    from backend.tests.test_cclip_source_sync import original_project, complete, local_analysis
    client, wb, sessions, pid, raw = original_project(full, video)
    complete(sessions, pid, raw)
    initial = client.post(f'/api/cclip/projects/{pid}/timeline', json={}).json()
    url = f'/api/cclip/workbench/{initial["id"]}/platform-drafts'
    first = client.post(url, json={'revision': initial['revision']}).json()
    from backend.services.studio import store
    old_mapping = dict(store.read(pid)['cclip_source_clips'])
    broad = {'id': 'new-broad-pick', 'name': 'New complete range', 'start': 0, 'end': 4.5, 'origin': 'ai', 'color': 0}
    latest = local_analysis(wb, wb.get(initial['id']), [broad])
    # No intervening timeline refresh: this is the actual local-analysis -> edit button boundary.
    opened = client.post(url, json={'revision': latest['revision'], 'clipId': broad['id']})
    assert opened.status_code == 200, opened.text
    result = opened.json()
    assert result['draftId'] != first['draftId']
    state = store.read(pid)
    selected = next(item for item in state['drafts'] if item['id'] == result['draftId'])
    assert selected['scenes'][0]['start'] == 0 and selected['scenes'][0]['end'] == 4.5
    assert len(state['drafts']) == 3
    assert all(state['cclip_source_clips'][key] == value for key, value in old_mapping.items())
