"""Isolated editor API contracts and actual synthetic FFmpeg delivery."""
import copy
import json
import os
import subprocess
import sys
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import numpy as np
import pytest

from backend.workbench.app import create_app
from backend.workbench import adapters, media
from backend.workbench.models import Project
from backend.workbench.store import Conflict, Store
from backend.workbench.runtime import AlreadyRunning, data_lease, prepare_bundled_runtime

pytestmark = pytest.mark.stdlib_only


def project():
    return {'schemaVersion': 1, 'title': 'Synthetic only', 'source': {'name': 'fixture.mp4', 'kind': 'demo', 'duration': 6},
            'clips': [{'id': 'a', 'name': 'Blue then red', 'start': 4, 'end': 5.5, 'color': 0},
                      {'id': 'b', 'name': 'Red', 'start': .5, 'end': 2.5, 'color': 1}],
            'cues': [{'id': 'red', 'start': 0, 'end': 3, 'text': '红色 synthetic'}, {'id': 'blue', 'start': 3, 'end': 6, 'text': '蓝色 fixture'}],
            'bookmarks': [{'id': 'mark', 'time': 4.2, 'label': 'Review here'}]}


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as value:
        token = value.get('/api/workbench/session').json()['session']
        value.headers['x-workbench-session'] = token
        yield value


def test_service_rejects_cross_origin_and_missing_session(client):
    assert client.post('/api/workbench/projects', json=project(), headers={'origin': 'https://other.invalid'}).status_code == 403
    assert client.post('/api/workbench/projects', json=project(), headers={'x-workbench-session': 'wrong'}).status_code == 403
    client.cookies.clear()
    assert client.get('/api/workbench/projects').status_code == 401


def test_draft_roundtrip_and_stale_save_preserve_current_work(client):
    record = client.post('/api/workbench/projects', json=project()).json()
    updated = {**record['project'], 'title': 'Saved name'}
    response = client.put('/api/workbench/projects/' + record['id'], json={'project': updated, 'revision': 1})
    assert response.status_code == 200
    assert response.json()['revision'] == 2
    assert client.put('/api/workbench/projects/' + record['id'], json={'project': record['project'], 'revision': 1}).status_code == 409
    loaded = client.get('/api/workbench/projects/' + record['id']).json()
    assert loaded['project']['title'] == 'Saved name'
    assert loaded['project']['bookmarks'] == project()['bookmarks']
    assert client.get('/api/workbench/projects').json()[0]['id'] == record['id']


@pytest.mark.parametrize('change', [
    lambda p: p['clips'][0].update(end=7),
    lambda p: p['bookmarks'][0].update(time=7),
    lambda p: p.update(bookmarks=p['bookmarks'] * 2),
    lambda p: p['source'].update(assetId='../escape'),
    lambda p: p.update(schemaVersion=2),
])
def test_invalid_inputs_never_enter_database(client, change):
    p = project()
    change(p)
    response = client.post('/api/workbench/projects', json=p)
    assert response.status_code == 422
    assert response.json() == {'error': 'invalid_request'}
    assert client.get('/api/workbench/projects').json() == []


def test_restart_marks_running_task_failed_and_keeps_projects(tmp_path):
    store = Store(tmp_path)
    record = store.create(Project.model_validate(project()).document())
    job = store.add_job(record['id'], 'export')
    store.update_job(job['id'], status='running')
    reopened = Store(tmp_path)
    assert reopened.job(job['id'])['error'] == 'interrupted'
    assert reopened.get(record['id'])['project']['bookmarks'] == project()['bookmarks']
    with pytest.raises(Conflict):
        reopened.save(record['id'], record['project'], 2)


def test_service_data_lease_prevents_second_instance_and_releases_on_exit(tmp_path):
    with data_lease(tmp_path):
        with pytest.raises(AlreadyRunning):
            with data_lease(tmp_path):
                pytest.fail('second instance acquired live directory')
    with data_lease(tmp_path):
        assert (tmp_path / '.service.lock').is_file()


def test_bundled_runtime_recovers_interrupted_copy_without_touching_user_data(tmp_path):
    resources, data = tmp_path / 'bundle', tmp_path / 'user'
    (resources / 'whisper-runtime').mkdir(parents=True)
    (resources / 'whisper-runtime/version.txt').write_text('bundled')
    (data / 'whisper-runtime.preparing').mkdir(parents=True)
    (data / 'whisper-runtime.preparing/partial.txt').write_text('incomplete')
    (data / 'projects.sqlite').write_text('preserve')
    prepare_bundled_runtime(resources, data)
    assert (data / 'whisper-runtime/version.txt').read_text() == 'bundled'
    assert not (data / 'whisper-runtime/partial.txt').exists()
    (data / 'whisper-runtime/version.txt').write_text('user-prepared')
    prepare_bundled_runtime(resources, data)
    assert (data / 'whisper-runtime/version.txt').read_text() == 'user-prepared'
    assert (data / 'projects.sqlite').read_text() == 'preserve'


def test_analysis_needs_current_specific_single_use_consent(client, monkeypatch):
    store = client.app.state.store
    asset_id = str(uuid4())
    store.add_asset(asset_id, {'duration': 6, 'bytes': 1}, 'synthetic')
    p = project()
    p['source'].update(kind='local', assetId=asset_id, bytes=1)
    record = client.post('/api/workbench/projects', json=p).json()
    path = '/api/workbench/projects/' + record['id']
    config = {'baseUrl': 'https://example.invalid/v1', 'model': 'fixture', 'apiKey': 'synthetic-secret'}
    assert client.post('/api/workbench/analysis-settings', json=config).status_code == 200
    assert 'synthetic-secret' not in client.get('/api/workbench/analysis-settings').text
    assert client.post(path + '/jobs', json={'kind': 'analyze', 'revision': 1}).status_code == 403
    preview = client.get(path + '/analysis-preview').json()
    assert preview['scope'] == 'transcript_only'
    assert preview['sentences'] == 2
    consent = client.post(path + '/analysis-consent', json={'revision': 1, 'approved': True}).json()['consentId']
    client.post('/api/workbench/analysis-settings', json={**config, 'model': 'changed'})
    assert client.post(path + '/jobs', json={'kind': 'analyze', 'revision': 1, 'consentId': consent}).status_code == 403
    captured = []
    monkeypatch.setattr(client.app.state.jobs, 'start', lambda record, body, settings: captured.append(body.kind) or {'id': 'fixture'})
    consent = client.post(path + '/analysis-consent', json={'revision': 1, 'approved': True}).json()['consentId']
    assert client.post(path + '/jobs', json={'kind': 'analyze', 'revision': 1, 'consentId': consent}).status_code == 200
    assert captured == ['analyze']
    assert client.post(path + '/jobs', json={'kind': 'analyze', 'revision': 1, 'consentId': consent}).status_code == 403
    assert 'synthetic-secret' not in json.dumps(store.projects())
    assert 'synthetic-secret' not in store.database.read_bytes().decode('latin-1')


def test_offline_worker_blocks_network_before_socket_connect():
    code = "import sys,socket; from backend.workbench.worker import deny_network; sys.addaudithook(deny_network); socket.getaddrinfo('example.invalid',443)"
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=15)
    assert result.returncode != 0
    assert b'workbench_offline_worker' in result.stderr


def test_cleanup_is_advisory_and_does_not_remove_nonidentical_speech():
    cues = [{'id': 'a', 'start': 0, 'end': 1, 'text': '嗯'}, {'id': 'b', 'start': 1, 'end': 3, 'text': '这是一次测试。'},
            {'id': 'c', 'start': 3, 'end': 5, 'text': '这是一次测试'}, {'id': 'd', 'start': 5, 'end': 7, 'text': '这是另一次测试'}]
    before = copy.deepcopy(cues)
    assert [item['kind'] for item in adapters.speech_cleanup(cues)] == ['filler', 'repeat']
    assert cues == before


def test_reanalysis_refreshes_only_untouched_ai_clips_and_preserves_human_edits(client, monkeypatch):
    asset_id = str(uuid4())
    client.app.state.store.add_asset(asset_id, {'duration': 6, 'bytes': 1}, 'synthetic')
    p = project()
    p['source'].update(kind='local', assetId=asset_id, bytes=1)
    untouched = {'id': 'old-ai', 'name': 'Old pick', 'start': 0, 'end': 1, 'color': 0, 'origin': 'ai'}
    edited = {'id': 'edited-ai', 'name': 'Edited pick', 'start': 3, 'end': 5, 'color': 1, 'origin': 'ai'}
    manual = {'id': 'manual', 'name': 'Keep manual edit', 'start': 1, 'end': 2, 'color': 2, 'origin': 'manual'}
    p.update(clips=[untouched, manual, edited], highlights=[untouched, {**edited, 'end': 4}])
    record = client.post('/api/workbench/projects', json=p).json()
    route = '/api/workbench/projects/' + record['id']
    fresh = [{'id': 'fresh-ai', 'name': 'Fresh pick', 'start': 2, 'end': 3, 'color': 0, 'origin': 'ai'}]
    monkeypatch.setattr(adapters, 'find_clips', lambda *_args: fresh)
    assert client.post('/api/workbench/analysis-settings', json={'baseUrl': 'https://example.invalid', 'model': 'fixture', 'apiKey': 'synthetic-only'}).status_code == 200
    for _ in range(2):
        latest = client.get(route).json()
        consent = client.post(route + '/analysis-consent', json={'revision': latest['revision'], 'approved': True}).json()['consentId']
        response = client.post(route + '/jobs', json={'kind': 'analyze', 'revision': latest['revision'], 'consentId': consent})
        assert response.status_code == 200
        job = response.json()
        for _ in range(100):
            state = client.get('/api/workbench/jobs/' + job['id']).json()
            if state['status'] not in {'queued', 'running'}:
                break
            time.sleep(.05)
        assert state['status'] == 'completed'
        selected = state['result']['record']['project']
        assert [clip['id'] for clip in selected['clips']] == ['manual', 'edited-ai', 'fresh-ai']
        assert selected['clips'][1] == {**edited, 'origin': 'manual'}
        assert selected['highlights'] == fresh


@pytest.fixture
def synthetic_video(tmp_path):
    target = tmp_path / 'synthetic.mp4'
    command = [media.get_ffmpeg_path(), '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=144x256:r=30:d=3',
               '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-f', 'lavfi', '-i', 'color=blue:s=144x256:r=30:d=3',
               '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-filter_complex', '[0:v][1:a][2:v][3:a]concat=n=2:v=1:a=1[v][a]',
               '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(target)]
    subprocess.run(command, check=True, capture_output=True, timeout=30)
    return target


def test_actual_export_keeps_reordered_audio_video_and_subtitle_times(tmp_path, synthetic_video):
    folder = tmp_path / 'render'
    folder.mkdir()
    target = tmp_path / 'output.mp4'
    original = synthetic_video.read_bytes()
    result = media.render(synthetic_video, project(), folder, target, threading.Event(), lambda _: None, burn=True)
    assert abs(result['duration'] - 3.5) < .12
    assert target.stat().st_size > 1000
    assert synthetic_video.read_bytes() == original
    subtitle = target.with_suffix('.srt').read_text(encoding='utf-8')
    assert '00:00:00,000 --> 00:00:01,500\n蓝色 fixture' in subtitle
    assert '00:00:01,500 --> 00:00:03,500\n红色 synthetic' in subtitle
    for position, expected in [(.4, 880), (2, 440)]:
        audio = subprocess.run([media.get_ffmpeg_path(), '-v', 'error', '-ss', str(position), '-i', str(target), '-t', '0.3', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], capture_output=True, check=True, timeout=15).stdout
        samples = np.frombuffer(audio, dtype=np.float32)
        frequency = np.fft.rfftfreq(len(samples), 1 / 8000)[np.argmax(abs(np.fft.rfft(samples)))]
        assert abs(frequency - expected) < 15


def test_upload_range_read_and_source_identity(client, synthetic_video):
    with synthetic_video.open('rb') as stream:
        response = client.post('/api/workbench/assets', files={'video': ('sample.mp4', stream, 'video/mp4')})
    assert response.status_code == 200
    info = response.json()
    response = client.get('/api/workbench/assets/' + info['assetId'] + '/video', headers={'range': 'bytes=0-31'})
    assert response.status_code == 206
    assert len(response.content) == 32
    p = project()
    p['source'].update(kind='local', assetId=info['assetId'], bytes=info['bytes'], duration=info['duration'])
    assert client.post('/api/workbench/projects', json=p).status_code == 200
    p['source']['duration'] = 7
    assert client.post('/api/workbench/projects', json=p).status_code == 422


def test_selected_clip_export_has_its_own_zero_based_subtitles(client, synthetic_video):
    with synthetic_video.open('rb') as stream:
        info = client.post('/api/workbench/assets', files={'video': ('sample.mp4', stream, 'video/mp4')}).json()
    p = project()
    p['source'].update(kind='local', assetId=info['assetId'], bytes=info['bytes'], duration=info['duration'])
    record = client.post('/api/workbench/projects', json=p).json()
    route = '/api/workbench/projects/' + record['id'] + '/jobs'
    assert client.post(route, json={'kind': 'export', 'revision': 1, 'clipId': 'missing'}).status_code == 422
    job = client.post(route, json={'kind': 'export', 'revision': 1, 'clipId': 'a'}).json()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        completed = client.get('/api/workbench/jobs/' + job['id']).json()
        if completed['status'] not in {'queued', 'running'}:
            break
        time.sleep(.1)
    assert completed['status'] == 'completed'
    assert abs(completed['result']['duration'] - 1.5) < .12
    subtitle = client.get(completed['result']['subtitles']).text
    assert '00:00:00,000 --> 00:00:01,500\n蓝色 fixture' in subtitle
    assert '红色 synthetic' not in subtitle
    assert client.get('/api/workbench/projects/' + record['id']).json()['revision'] == 1


def test_actual_media_process_cancellation_is_bounded(tmp_path):
    cancelled = threading.Event()
    outcomes = []
    def work():
        try:
            media.run_ffmpeg(['-re', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=10:d=10', '-f', 'null', '-'], tmp_path, cancelled)
        except media.Cancelled:
            outcomes.append('cancelled')
    thread = threading.Thread(target=work)
    thread.start()
    time.sleep(.4)
    cancelled.set()
    thread.join(timeout=4)
    assert not thread.is_alive()
    assert outcomes == ['cancelled']


def test_desktop_port_notification_means_http_is_ready_and_second_start_is_rejected(tmp_path):
    import queue
    import httpx
    environment = os.environ.copy()
    environment.pop('CCLIP_BUNDLED_RESOURCES', None)
    environment.pop('AUTOCLIP_PARENT_PID', None)
    environment['PYTHONUTF8'] = '1'
    command = [sys.executable, '-m', 'backend.workbench', '--port', '0', '--data-dir', str(tmp_path / 'data')]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=environment)
    lines = queue.Queue()
    reader = threading.Thread(target=lambda: [lines.put(line.strip()) for line in process.stdout], daemon=True)
    reader.start()
    try:
        line = lines.get(timeout=25)
        assert line.startswith('WORKBENCH_PORT=')
        port = int(line.split('=', 1)[1])
        response = httpx.get(f'http://127.0.0.1:{port}/api/workbench/session', trust_env=False, timeout=3)
        assert response.status_code == 200
        assert response.json()['localOnly'] is True
        duplicate = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=environment, timeout=15)
        assert duplicate.returncode == 0
        assert duplicate.stdout.strip() == 'WORKBENCH_ALREADY_RUNNING'
    finally:
        process.terminate()
        process.wait(timeout=10)
        reader.join(timeout=2)
        process.stdout.close()
