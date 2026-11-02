"""Clip removal changes the selected versions atomically and leaves media/history intact."""
import hashlib
import json

from backend.tests.test_cclip import full, video, saved_timeline  # noqa: F401 - pytest fixtures


def prepared_outputs(full, video):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    first = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft',
                        json={'revision': record['revision'], 'clipId': 'one'}).json()
    second = client.post(f'/api/cclip/workbench/{record["id"]}/platform-draft',
                         json={'revision': record['revision'], 'clipId': 'two'}).json()
    from backend.services.studio import store
    project_id = first['projectId']
    draft = next(d for d in store.read(project_id)['drafts'] if d['id'] == first['draftId'])
    duplicate = client.post(f'/api/v1/studio/{project_id}/drafts/{draft["id"]}/duplicate',
                            json={'draft': draft, 'title': 'Other platform', 'language': draft['language']}).json()
    history = store.directory(project_id) / 'exports' / 'history.mp4'
    history.parent.mkdir(exist_ok=True)
    history.write_bytes(b'previous immutable export')
    def seed(data):
        data['jobs'] = [{'job_id': 'historical', 'draft_id': draft['id'], 'revision': 1,
                         'status': 'completed', 'created_at': store.now(), 'percent': 100,
                         'result': {'path': str(history)}}]
        data['output_variants'] = [{'id': 'first-output', 'draft_id': draft['id'], 'draft_revision': 1,
                                   'strategy_id': 'bilibili', 'status': 'completed'},
                                  {'id': 'second-output', 'draft_id': duplicate['id'], 'draft_revision': 1,
                                   'strategy_id': 'douyin', 'status': 'completed'}]
    store.change(project_id, seed)
    refs = [{'id': d['id'], 'revision': d['revision']} for d in (draft, duplicate)]
    return client, wb, record, project_id, refs, second['draftId'], history


def test_remove_and_restore_group_preserves_other_clip_original_and_exports(full, video):
    client, wb, record, pid, refs, other, history = prepared_outputs(full, video)
    from backend.services.studio import store
    original_hash = hashlib.sha256(wb.asset_path(record['project']['source']['assetId']).read_bytes()).hexdigest()
    before = store.read(pid)
    result = client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': refs})
    assert result.status_code == 200
    removal = result.json()
    assert removal['removed'] == 2
    current = store.read(pid)
    assert [d['id'] for d in current['drafts']] == [other]
    assert current['output_variants'] == []
    assert current['jobs'] == before['jobs'] and history.read_bytes() == b'previous immutable export'
    assert wb.get(record['id'])['project'] == record['project']
    # Re-read persisted state, rather than relying on an in-memory undo object.
    document = json.loads((store.directory(pid) / 'metadata/studio.json').read_text(encoding='utf-8'))
    assert document['cclip_removed_output_group']['undoId'] == removal['undoId']
    restored = client.post(f'/api/cclip/projects/{pid}/outputs/restore', json={'undoId': removal['undoId']})
    assert restored.status_code == 200 and restored.json()['restored'] == 2
    after = store.read(pid)
    assert sorted(after['drafts'], key=lambda d: d['id']) == sorted(before['drafts'], key=lambda d: d['id'])
    assert after['output_variants'] == before['output_variants']
    assert hashlib.sha256(wb.asset_path(record['project']['source']['assetId']).read_bytes()).hexdigest() == original_hash
    assert client.post(f'/api/cclip/projects/{pid}/outputs/restore', json={'undoId': removal['undoId']}).status_code == 404


def test_remove_rejects_stale_missing_duplicate_and_unauthorized_requests(full, video):
    client, _, _, pid, refs, _, _ = prepared_outputs(full, video)
    from backend.services.studio import store
    before = store.read(pid)['drafts']
    stale = [refs[0], {**refs[1], 'revision': refs[1]['revision'] + 1}]
    assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': stale}).status_code == 409
    assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': [refs[0], refs[0]]}).status_code == 422
    assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': [refs[0], {'id': 'missing', 'revision': 1}]}).status_code == 404
    assert store.read(pid)['drafts'] == before
    client.cookies.clear()
    assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': refs}).status_code == 401
    assert store.read(pid)['drafts'] == before


def test_busy_and_failed_storage_cannot_partially_remove_outputs(full, video, monkeypatch):
    client, _, _, pid, refs, _, history = prepared_outputs(full, video)
    from backend.services.studio import store
    before = store.read(pid)['drafts']
    store.change(pid, lambda data: data['jobs'].append({'job_id': 'active', 'draft_id': refs[0]['id'],
                 'revision': 1, 'status': 'running', 'instance': store.INSTANCE, 'created_at': store.now(), 'percent': 0}))
    assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': refs}).status_code == 409
    store.change(pid, lambda data: data.update(jobs=[j for j in data['jobs'] if j['job_id'] != 'active']))
    def denied(*args, **kwargs):
        raise OSError('synthetic disk failure')
    with monkeypatch.context() as context:
        context.setattr(store, '_replace_state', denied)
        assert client.post(f'/api/cclip/projects/{pid}/outputs/remove', json={'drafts': refs}).status_code == 503
    assert store.read(pid)['drafts'] == before
    assert history.read_bytes() == b'previous immutable export'
