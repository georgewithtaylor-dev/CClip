"""Local template previews never replace a cover or consult external models."""
from io import BytesIO
import hashlib

from PIL import Image

from backend.tests.test_cclip_manual_cover import setup_cover
from backend.tests.test_cclip import full, video  # noqa: F401


def test_template_preview_is_local_non_mutating_and_matches_applied_cover(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    from backend.services import cover
    from backend.services.studio import store
    before = store.read(pid)
    body = {'platform': 'xiaohongshu', 'title': '把握核心观点 做出专业表达', 'subtitle': '清晰而有分寸', 'badge': '内容创作',
            'frame_time': 3.5, 'local_template': 'autoclip', 'palette': 'coral'}
    preview = client.post(endpoint + '/preview', json=body)
    assert preview.status_code == 200, preview.text
    assert preview.headers['content-type'] == 'image/jpeg'
    assert preview.headers['cache-control'] == 'no-store'
    assert Image.open(BytesIO(preview.content)).size == (1080, 1440)
    assert store.read(pid) == before
    assert not cover.cover_path(pid, f'draft-{did}', 'xiaohongshu').exists()
    monkeypatch.setattr(cover, 'load_config', lambda: cover.CoverConfig())
    applied = client.post(endpoint, json={**body, 'force_local': True, 'sync': True})
    assert applied.status_code == 200, applied.text
    assert applied.json()['method'] == 'design'
    assert applied.json()['local_template'] == 'autoclip'
    assert applied.json()['palette'] == 'coral'
    assert cover.cover_path(pid, f'draft-{did}', 'xiaohongshu').read_bytes() == preview.content
    loaded = client.get(endpoint + '?platform=xiaohongshu').json()
    assert loaded['local_template'] == 'autoclip' and loaded['palette'] == 'coral'
    old = cover.cover_path(pid, f'draft-{did}', 'xiaohongshu').read_bytes()
    assert client.post(endpoint + '/preview', json={**body, 'frame_time': 30}).status_code == 400
    assert cover.cover_path(pid, f'draft-{did}', 'xiaohongshu').read_bytes() == old
    blank = {**body, 'title': '  ', 'subtitle': '  ', 'badge': ''}
    blank_preview = client.post(endpoint + '/preview', json=blank)
    blank_applied = client.post(endpoint, json={**blank, 'force_local': True, 'sync': True})
    assert blank_preview.status_code == blank_applied.status_code == 200
    assert cover.cover_path(pid, f'draft-{did}', 'xiaohongshu').read_bytes() == blank_preview.content
    assert client.post(endpoint + '/preview', json={**body, 'title': '长' * 201}).status_code == 422


def test_template_palette_and_aspect_change_pixels_without_writing_artifacts(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    from backend.services import cover
    body = {'platform': 'douyin', 'title': '清晰准确的专业表达', 'frame_time': 3.5, 'local_template': 'autoclip'}
    hashes = set()
    for palette in ('azure', 'amber', 'coral', 'mint', 'lemon', 'rose', 'lilac'):
        response = client.post(endpoint + '/preview', json={**body, 'palette': palette})
        assert response.status_code == 200, response.text
        hashes.add(hashlib.sha256(response.content).hexdigest())
    assert len(hashes) == 7
    for platform, size in (('bilibili', (1146, 717)), ('youtube_long', (1280, 720))):
        response = client.post(endpoint + '/preview', json={**body, 'platform': platform})
        assert response.status_code == 200
        assert Image.open(BytesIO(response.content)).size == size
    overlay = client.post(endpoint + '/preview', json={**body, 'local_template': 'overlay', 'image_layout': 'fit'})
    assert overlay.status_code == 200
    assert hashlib.sha256(overlay.content).hexdigest() not in hashes
    assert not cover.cover_path(pid, f'draft-{did}', 'douyin').exists()
    assert client.post(endpoint + '/preview', json={**body, 'local_template': 'unknown'}).status_code == 422
