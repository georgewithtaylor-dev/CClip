"""Explicit cover choices must reach pixels, metadata and failed-job recovery."""
import io
import json

import pytest
from PIL import Image, ImageDraw

from backend.services import cover
from backend.tests.test_cover import _jpeg, _project, data_dir, fake_frame  # noqa: F401


def test_explicit_ai_without_configuration_keeps_existing_cover(data_dir, fake_frame, monkeypatch):
    _project(data_dir)
    old = cover.generate_cover(project_id='p1', clip_id='1', title='Previous', force_local=True)
    image = cover.cover_path('p1', '1', 'bilibili').read_bytes()
    meta = cover.meta_path('p1', '1', 'bilibili').read_bytes()
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig())
    with pytest.raises(cover.CoverError, match='图像模型'):
        cover.generate_cover(project_id='p1', clip_id='1', title='New', require_ai=True)
    assert cover.cover_path('p1', '1', 'bilibili').read_bytes() == image
    assert cover.meta_path('p1', '1', 'bilibili').read_bytes() == meta
    assert cover.get_cover('p1', '1')['title'] == old['title']


@pytest.mark.parametrize('failure', ['provider', 'title'])
def test_explicit_ai_failure_is_failed_and_preserves_old_image(data_dir, fake_frame, monkeypatch, failure):
    _project(data_dir)
    cover.generate_cover(project_id='p1', clip_id='1', title='Previous', force_local=True)
    before = cover.cover_path('p1', '1', 'bilibili').read_bytes()
    meta = cover.meta_path('p1', '1', 'bilibili').read_bytes()
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig(enabled=True, model='fixture', api_key='fixture'))
    def generate(**kwargs):
        calls.append(kwargs['request'])
        if failure == 'provider':
            raise cover.ImageError('synthetic provider error')
        return _jpeg()
    monkeypatch.setattr(cover, 'generate_image', generate)
    calls = []
    monkeypatch.setattr(cover, 'read_image_text', lambda **_kwargs: 'Unrelated title')
    cover._run_job('strict-cover-fixture', {'project_id': 'p1', 'clip_id': '1', 'title': 'New title', 'require_ai': True})
    job = cover.get_job('strict-cover-fixture')
    assert job['status'] == 'failed'
    assert len(calls) == (1 if failure == 'provider' else 2)
    assert 'result' not in job
    assert cover.cover_path('p1', '1', 'bilibili').read_bytes() == before
    assert cover.meta_path('p1', '1', 'bilibili').read_bytes() == meta


def test_reference_opt_out_overrides_global_consent_and_is_recorded(data_dir, fake_frame, monkeypatch):
    _project(data_dir)
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig(enabled=True, api_key='fixture', allow_send_frame=True))
    requests = []
    monkeypatch.setattr(cover, 'generate_image', lambda **kw: requests.append(kw['request']) or _jpeg())
    monkeypatch.setattr(cover, 'read_image_text', lambda **kw: 'Title')
    result = cover.generate_cover(project_id='p1', clip_id='1', title='Title', require_ai=True, send_reference=False)
    assert len(requests) == 1 and requests[0].reference is None
    assert result['method'] == 'model_bg' and result['reference_sent'] is False
    assert cover.get_cover('p1', '1')['reference_sent'] is False


def test_reference_requires_global_permission_before_any_request(data_dir, fake_frame, monkeypatch):
    _project(data_dir)
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig(enabled=True, api_key='fixture', allow_send_frame=False))
    monkeypatch.setattr(cover, 'generate_image', lambda **_kw: pytest.fail('No request without consent'))
    with pytest.raises(cover.CoverError, match='参考'):
        cover.generate_cover(project_id='p1', clip_id='1', require_ai=True, send_reference=True)


def test_cover_consent_identifies_separate_verification_service_without_credentials(data_dir, monkeypatch):
    cfg = cover.CoverConfig(enabled=True, provider='openai', api_key='synthetic-image-secret', base_url='http://127.0.0.1:9/v1')
    monkeypatch.setattr(cover, 'verify_endpoint', lambda _cfg: {'provider': 'openai', 'base_url': 'http://127.0.0.1:10/v1', 'model': 'fixture-vision', 'api_key': 'synthetic-vision-secret'})
    value = cfg.public()
    assert value['verification'] == {'provider': 'openai', 'base_url': 'http://127.0.0.1:10/v1', 'model': 'fixture-vision'}
    assert 'synthetic' not in json.dumps(value)


def test_endpoint_selection_reading_local_configuration_never_opens_connection(data_dir, monkeypatch):
    import socket
    attempts = []
    def forbidden(*args, **kwargs):
        attempts.append(True)
        raise AssertionError('Configuration lookup must never open a socket')
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    (data_dir / 'vision-settings.json').write_text(json.dumps({'mode': 'custom', 'base_url': 'https://fixture.invalid/v1', 'model': 'fixture-vision', 'api_key': 'fixture-only'}))
    cfg = cover.CoverConfig(enabled=True, api_key='fixture-only', base_url='https://fixture.invalid/image')
    endpoint = cover.verify_endpoint(cfg)
    assert endpoint['model'] == 'fixture-vision' and endpoint['base_url'] == 'https://fixture.invalid/v1'
    assert cfg.public()['verification']['model'] == 'fixture-vision'
    assert attempts == []


def test_local_layout_preserves_full_frame_and_fits_long_text(data_dir, monkeypatch):
    _project(data_dir)
    image = Image.new('RGB', (900, 300), (20, 100, 30))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 120, 299), fill=(230, 20, 20))
    draw.rectangle((780, 0, 899, 299), fill=(20, 20, 230))
    buf = io.BytesIO(); image.save(buf, 'JPEG')
    captured = []
    monkeypatch.setattr(cover, 'extract_frame_jpeg', lambda _path, at_sec: captured.append(at_sec) or buf.getvalue())
    widths = []
    original = cover._pil_font
    monkeypatch.setattr(cover, '_pil_font', lambda size: original(size))
    original_text = ImageDraw.ImageDraw.text
    def text(self, xy, value, *args, **kwargs):
        if value.strip():
            widths.append((xy[0], self.textlength(value, font=kwargs.get('font'))))
        return original_text(self, xy, value, *args, **kwargs)
    monkeypatch.setattr(ImageDraw.ImageDraw, 'text', text)
    title = 'A precise complete title about developing a professional video workflow without losing meaning'
    result = cover.generate_cover(project_id='p1', clip_id='1', platform='douyin', title=title,
                                  subtitle='A readable subtitle', force_local=True, frame_time=8.25,
                                  image_layout='fit', title_position='top')
    assert captured == [8.25]
    output = Image.open(result['path'])
    assert output.size == (1080, 1920)
    assert output.getpixel((45, 960))[0] > 180  # Left and right source edges remain.
    assert output.getpixel((1035, 960))[2] > 180
    assert widths and all(x >= 0 and x + length <= 1080 * .95 for x, length in widths)
    value = cover.get_cover('p1', '1', 'douyin')
    assert value['frame_time'] == 8.25 and value['image_layout'] == 'fit' and value['title_position'] == 'top'
    assert value['title'] == title and result['method'] == 'local_overlay'
    assert json.loads(cover.meta_path('p1', '1', 'douyin').read_text())['title_lines'] == cover.split_title(title, preserve_full=True)


def test_draft_frame_selection_rejects_deleted_gap_and_nonfinite(data_dir, fake_frame, monkeypatch):
    clip = {'start_time': '00:00:01,000', 'end_time': '00:00:04,000',
            'scenes': [{'start': 1, 'end': 4}, {'start': 8, 'end': 10}]}
    monkeypatch.setattr(cover, 'load_cover_clip', lambda *_a: clip)
    monkeypatch.setattr(cover, 'find_source_video', lambda *_a: data_dir / 'video.mp4')
    for at in [0, 4, 6, 10, float('nan'), float('inf')]:
        with pytest.raises(cover.CoverError):
            cover.generate_cover(project_id='p1', clip_id='draft-' + 'a' * 32, force_local=True, frame_time=at)
    for at in [1, 3.99, 8.5]:
        result = cover.generate_cover(project_id='p1', clip_id='1', force_local=True, frame_time=at)
        assert result['frame_time'] == at
