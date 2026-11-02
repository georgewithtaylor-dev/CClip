"""Settings must reach rendering and file delivery, including historical outputs."""
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from backend.core import cclip_storage as storage
from backend.tests.test_cclip import full, video, saved_timeline, handoff  # noqa: F401


def test_settings_streamed_download_and_old_locations(full, video, tmp_path):
    client, wb, _, _ = full
    record = saved_timeline(client, video)
    old = client.get('/api/cclip/storage').json()
    assert Path(old['generated']).is_absolute() and old['legacyGenerated']
    target = {'generated': str(tmp_path / 'other-drive' / 'videos'), 'downloads': str(tmp_path / 'other-drive' / 'saved')}
    assert client.put('/api/cclip/storage', json=target).json() == target
    job = wb.add_job(record['id'], 'export')
    legacy = wb.root / 'exports' / f"{job['id']}.mp4"
    output = storage.output('workbench', record['id'], job['id'], legacy, create=True)
    output.write_bytes(b'local immutable video' * 1_000_000)
    wb.update_job(job['id'], status='completed', progress=100, result={})
    saved = client.post('/api/cclip/storage/save-file', json={'path': f"/api/workbench/jobs/{job['id']}/download"})
    assert saved.status_code == 200, saved.text
    path = Path(saved.json()['path'])
    assert path.parent == Path(target['downloads']) and path.read_bytes() == output.read_bytes()
    assert not legacy.exists()
    assert json.loads(storage._file('cclip-storage.json').read_text()) == target
    second = client.post('/api/cclip/storage/save-file', json={'path': f"/api/workbench/jobs/{job['id']}/download"}).json()
    assert Path(second['path']) != path and path.is_file()
    changed = {**target, 'generated': str(tmp_path / 'third-drive')}
    assert client.put('/api/cclip/storage', json=changed).status_code == 200
    assert storage.output('workbench', record['id'], job['id'], legacy) == output
    assert client.get(f"/api/workbench/jobs/{job['id']}/download").content == output.read_bytes()
    newer = storage.studio_output('sample-project', 'next-render', create=True)
    assert newer.is_relative_to(Path(changed['generated']))
    assert storage.scratch(wb.root / 'jobs').is_relative_to(Path(changed['generated']))


@pytest.mark.parametrize('path', ['https://example.com/video', '/api/cclip/storage/save-file', '/api/v1/settings',
                                 '/api/v1/studio/p/exports/%2e%2e/video', '/api/workbench/assets/private/video'])
def test_save_only_artifact_routes(full, path):
    client, *_ = full
    assert client.post('/api/cclip/storage/save-file', json={'path': path}).status_code == 422


def test_invalid_folder_retains_preferences_and_failed_download_leaves_no_partial(full, tmp_path):
    client, *_ = full
    target = {'generated': str(tmp_path / 'videos'), 'downloads': str(tmp_path / 'saved')}
    assert client.put('/api/cclip/storage', json=target).status_code == 200
    assert client.put('/api/cclip/storage', json={**target, 'downloads': 'relative/path'}).status_code == 422
    assert client.get('/api/cclip/storage').json()['downloads'] == target['downloads']
    assert client.post('/api/cclip/storage/save-file', json={'path': '/api/workbench/jobs/00000000-0000-0000-0000-000000000000/download'}).status_code == 404
    assert not list(Path(target['downloads']).iterdir())
    response = client.post('/api/cclip/storage/save-text', json={'name': 'captions.srt', 'text': '1\n00:00:00,000 --> 00:00:01,000\n字幕\n'})
    assert response.status_code == 200
    assert Path(response.json()['path']).parent == Path(target['downloads'])
    assert client.post('/api/cclip/storage/save-text', json={'name': 'bad.exe', 'text': 'hello'}).status_code == 422


def test_broken_index_does_not_fall_back_to_old_drive(full, tmp_path):
    storage._file('cclip-media-index.json').write_text('{broken', encoding='utf-8')
    with pytest.raises(ValueError):
        storage.studio_output('p', 'job', create=True)


def test_local_delivery_zip_uses_selected_folder_and_keeps_the_video(full, video, tmp_path, monkeypatch):
    import zipfile
    from backend.services.studio import store, publish_kit
    client, *_ = full
    locations = {'generated': str(tmp_path / 'other-drive' / 'generated'), 'downloads': str(tmp_path / 'other-drive' / 'saved')}
    assert client.put('/api/cclip/storage', json=locations).status_code == 200
    linked = handoff(client, saved_timeline(client, video))
    pid = linked['projectId']
    output = storage.studio_output(pid, 'kit-job', create=True)
    output.write_bytes(video.read_bytes())
    def completed(data):
        data['jobs'] = [{'job_id': 'kit-job', 'status': 'completed', 'result': {'title': 'Local clip'}}]
        data['output_variants'] = [{'id': 'local-kit', 'strategy_id': 'youtube_long', 'status': 'completed',
                                   'render_job_id': 'kit-job', 'draft_id': linked['draftId'],
                                   'post': {'title': 'Local clip', 'description': 'Synthetic only', 'tags': ['test']}}]
    store.change(pid, completed)
    monkeypatch.setattr(publish_kit, 'cover_file', lambda *_: (None, None))
    body = {'path': f'/api/v1/studio/{pid}/output-variants/local-kit/kit'}
    result = client.post('/api/cclip/storage/save-file', json=body)
    assert result.status_code == 200, result.text
    saved = Path(result.json()['path'])
    assert saved.parent == Path(locations['downloads']) and saved.suffix == '.zip'
    with zipfile.ZipFile(saved) as archive:
        assert archive.read('Local clip.mp4') == video.read_bytes()
        assert 'Synthetic only' in archive.read('Local clip post.txt').decode()
    assert output.read_bytes() == video.read_bytes()
    assert not list(output.parent.glob('autoclip-kit-*.zip'))
    second = client.post('/api/cclip/storage/save-file', json=body)
    assert second.status_code == 200 and Path(second.json()['path']) != saved and saved.is_file()


def test_cclip_has_no_account_posting_cookie_or_scheduling_routes(full):
    client, *_ = full
    paths = list(client.app.openapi()['paths'])
    assert any(path.startswith('/api/v1/publish/covers/') for path in paths)
    assert not any(path.startswith('/api/v1/publish/') and not path.startswith('/api/v1/publish/covers') for path in paths)
    assert not any('upload-queue' in path or 'refresh-cookie' in path or 'schedule-check' in path for path in paths)
    assert client.get('/api/v1/publish/upload-post/config').status_code == 404
    assert client.get('/api/v1/publish/bilibili/config').status_code == 404
    assert client.get('/api/v1/publish/covers/config').status_code == 200
    assert client.get('/api/cclip/build').json()['product'] == 'CClip'


def test_terminal_worker_cleanup_does_not_block_next_pipeline_stage(full, video, monkeypatch):
    from backend.workbench.jobs import Jobs
    from backend.workbench.store import Conflict
    client, wb, *_ = full
    record = saved_timeline(client, video)
    jobs = Jobs(wb)
    submitted = []
    monkeypatch.setattr(jobs.pool, 'submit', lambda *args: submitted.append(args))
    try:
        previous = wb.add_job(record['id'], 'transcribe')
        jobs.events[previous['id']] = threading.Event()
        wb.update_job(previous['id'], status='completed', progress=100)
        next_job = jobs.start(record, SimpleNamespace(kind='analyze'))
        assert next_job['status'] == 'queued' and len(submitted) == 1
        assert previous['id'] not in jobs.events
        with pytest.raises(Conflict):
            jobs.start(record, SimpleNamespace(kind='cleanup'))
    finally:
        jobs.close()
