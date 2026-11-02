"""Local audio envelopes and durable editor controls across API/runtime boundaries."""
import json
import subprocess

from fastapi.testclient import TestClient
import pytest

from backend.workbench.app import create_app
from backend.workbench import editor_preferences, waveform
from backend.utils.ffmpeg_utils import get_ffmpeg_path

pytestmark = pytest.mark.stdlib_only


def test_editor_preferences_survive_service_restart_and_invalid_writes(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        client.headers['x-workbench-session'] = client.get('/api/workbench/session').json()['session']
        value = client.get('/api/workbench/editor-preferences').json()
        value.update(split='x', snapping=False)
        assert client.put('/api/workbench/editor-preferences', json=value).status_code == 200
        assert client.put('/api/workbench/editor-preferences', json={**value, 'snap': 'x'}).status_code == 422
        assert client.put('/api/workbench/editor-preferences', json={**value, 'secret': 'never_saved'}).status_code == 422
        assert client.put('/api/workbench/editor-preferences', json=value, headers={'x-workbench-session': 'wrong'}).status_code == 403
    with TestClient(create_app(tmp_path)) as client:
        client.get('/api/workbench/session')
        assert client.get('/api/workbench/editor-preferences').json() == value
    saved = json.loads((tmp_path / 'editor-preferences.json').read_text())
    assert saved == value
    (tmp_path / 'editor-preferences.json').write_text('broken')
    assert editor_preferences.load(tmp_path).split == 's'


def test_audio_waveform_real_pcm_cache_invalidation_and_silent_source(tmp_path, monkeypatch):
    source, cache = tmp_path / 'synthetic.wav', tmp_path / 'cache'
    subprocess.run([get_ffmpeg_path(), '-v', 'error', '-f', 'lavfi', '-i',
                    'sine=frequency=220:duration=1', '-y', str(source)], check=True, capture_output=True)
    result = waveform.waveform(source, cache, 1.0, True)
    assert result['hasAudio'] and len(result['peaks']) == 20
    assert max(result['peaks']) == 255 and result['step'] == .05
    real_popen = waveform.subprocess.Popen
    monkeypatch.setattr(waveform.subprocess, 'Popen', lambda *a, **k: pytest.fail('cached audio decoded again'))
    assert waveform.waveform(source, cache, 1.0, True) == result
    monkeypatch.setattr(waveform.subprocess, 'Popen', real_popen)
    (cache / 'peaks-v1.json').write_text('damaged')
    assert waveform.waveform(source, cache, 1.0, True) == result
    silent = waveform.waveform(source, tmp_path / 'silent', 1.0, False)
    assert silent['peaks'] == [] and silent['hasAudio'] is False


def test_template_preview_uses_renderer_output_clock_and_serves_only_bundled_assets(tmp_path):
    from backend.services.studio.models import Draft
    from backend.services.studio.overlay_fill import output_packaging
    value = Draft(id='preview', title='Local only', scenes=[{'id': 'a', 'start': 10, 'end': 12}, {'id': 'b', 'start': 11, 'end': 13}],
                  packaging={'version': 2, 'template': 'editorial', 'audience_language': 'zh', 'title_lines': ['Edited'],
                             'cues': [{'start': 10.5, 'end': 11.5, 'text': 'Words'}], 'emphasis': [{'at': 11.2, 'text': 'Words'}]})
    moved = output_packaging(value)
    assert [(cue.start, cue.end) for cue in moved.cues] == [(.5, 1.5), (2, 2.5)]
    assert len(moved.emphasis) == 2
    assert value.packaging.cues[0].start == 10.5
    assert output_packaging(value.model_copy(update={'subtitles': False})).cues == []
    with TestClient(create_app(tmp_path)) as client:
        client.headers['x-workbench-session'] = client.get('/api/workbench/session').json()['session']
        fill = client.post('/api/workbench/template-preview', json=value.model_dump()).json()
        assert fill['words'][0]['start_frame'] == 15 and fill['words'][1]['start_frame'] == 60
        assert fill['hook']['text'] == 'Edited'
        assert client.get('/api/workbench/template-assets/editorial/index.html').status_code == 200
        assert client.get('/api/workbench/template-assets/street/template.js').status_code == 200
        assert client.get('/api/workbench/template-assets/editorial/template.yaml').status_code == 404
        assert client.get('/api/workbench/template-assets/unknown/index.html').status_code == 404
