"""Manual cover creation is local, revision-bound and usable in publish kits."""
from io import BytesIO

import pytest
from PIL import Image

from backend.tests.test_cclip import full, video  # noqa: F401
from backend.tests.test_cclip_catalog_cover import project


def setup_cover(full, video, monkeypatch):
    client, _, record = project(full, video)
    opened = client.post(f'/api/cclip/workbench/{record["id"]}/platform-drafts', json={'revision': record['revision'], 'clipId': 'second'}).json()
    pid, did = opened['projectId'], opened['draftId']
    from backend.services import cover
    def forbidden(*_a, **_kw):
        pytest.fail('Manual cover tools must never read model configuration or call a provider')
    for name in ('generate_image', 'read_image_text', 'load_config'):
        monkeypatch.setattr(cover, name, forbidden)
    return client, pid, did, f'/api/v1/publish/covers/{pid}/clips/draft-{did}'


def test_manual_prompt_and_one_exact_source_frame_without_ai(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    body = {'revision': 1, 'platform': 'xiaohongshu', 'title': '专业内容的核心观点', 'subtitle': '简洁而准确', 'badge': '01', 'content_type': 'knowledge', 'frame_time': 3.5}
    response = client.post(endpoint + '/manual', json=body)
    assert response.status_code == 200, response.text
    kit = response.json()
    assert kit['frame_time'] == 3.5 and kit['width'] == 1080 and kit['height'] == 1440
    assert body['title'] in kit['prompt'] and body['subtitle'] in kit['prompt'] and '参考图' in kit['prompt']
    text = client.get(kit['prompt_url'])
    assert text.status_code == 200 and text.content.decode('utf-8-sig') == kit['prompt']
    assert '.txt' in text.headers['content-disposition']
    frame = client.get(kit['frame_url'])
    assert frame.status_code == 200 and Image.open(BytesIO(frame.content)).size == (160, 240)
    assert '.jpg' in frame.headers['content-disposition']
    assert client.post(endpoint + '/manual', json={**body, 'frame_time': 1}).status_code == 400
    assert client.post(endpoint + '/manual', json={**body, 'revision': 2}).status_code == 409
    assert client.get(endpoint + '/manual/' + 'a' * 32 + '/frame').status_code == 404
    assert client.get(endpoint + '/manual/not-a-kit/frame').status_code == 404
    wide = client.post(endpoint + '/manual', json={**body, 'platform': 'bilibili'}).json()
    assert '1146×717' in wide['prompt'] and '输出约 1280×720' not in wide['prompt']


def test_uploaded_cover_preserves_artwork_reopens_and_enters_exact_revision_kit(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    source = Image.new('RGB', (800, 400), 'red')
    source.paste('blue', (700, 0, 800, 400))
    image = BytesIO(); source.save(image, 'PNG')
    data = {'revision': '1', 'platform': 'xiaohongshu', 'title': '自制封面'}
    response = client.post(endpoint + '/upload', data=data, files={'image': ('my-cover.png', image.getvalue(), 'image/png')})
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['method'] == 'uploaded' and value['reference_sent'] is False
    content = client.get(value['url']).content
    output = Image.open(BytesIO(content))
    assert output.size == (1080, 1440)
    assert output.getpixel((20, 720))[0] > 200 and output.getpixel((1060, 720))[2] > 200
    assert client.get(endpoint + '?platform=xiaohongshu').json()['method'] == 'uploaded'
    from backend.services.studio import store
    from backend.services import cover
    state = store.read(pid)
    assert state['cclip_draft_covers'][did]['draft_revision'] == 1
    store.change(pid, lambda state: state['jobs'].append({'job_id': 'e' * 32, 'draft_id': did, 'revision': 1, 'status': 'completed'}))
    from backend.services.studio.publish_kit import cover_file
    assert cover_file(pid, 'e' * 32, 'xiaohongshu')[0].read_bytes() == content
    assert cover.get_cover(pid, 'studio-' + 'e' * 32, 'xiaohongshu')['method'] == 'uploaded'
    assert client.post(endpoint + '/upload', data={**data, 'revision': '2'}, files={'image': ('new.png', image.getvalue(), 'image/png')}).status_code == 409
    assert client.get(value['url']).content == content


@pytest.mark.parametrize('payload,mime', [(b'not an image', 'image/png'), (b'<svg/>', 'image/svg+xml'), (b'', 'image/jpeg')])
def test_invalid_upload_does_not_replace_previous_cover(full, video, monkeypatch, payload, mime):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    original = BytesIO(); Image.new('RGB', (40, 40), 'green').save(original, 'JPEG')
    data = {'revision': '1', 'platform': 'douyin'}
    prior = client.post(endpoint + '/upload', data=data, files={'image': ('good.jpg', original.getvalue(), 'image/jpeg')})
    assert prior.status_code == 200, prior.text
    before = client.get(prior.json()['url']).content
    response = client.post(endpoint + '/upload', data=data, files={'image': ('bad.file', payload, mime)})
    assert response.status_code == 400, response.text
    assert client.get(prior.json()['url']).content == before


def test_upload_size_limit_and_metadata_stripping(full, video, monkeypatch):
    client, pid, did, endpoint = setup_cover(full, video, monkeypatch)
    from backend.services import cover_manual
    image = Image.new('RGB', (80, 40), 'green')
    exif = Image.Exif(); exif[270] = 'fixture private metadata'
    content = BytesIO(); image.save(content, 'JPEG', exif=exif)
    data = {'revision': '1', 'platform': 'douyin'}
    saved = client.post(endpoint + '/upload', data=data, files={'image': ('photo.jpg', content.getvalue(), 'image/jpeg')})
    assert saved.status_code == 200, saved.text
    before = client.get(saved.json()['url']).content
    assert not Image.open(BytesIO(before)).getexif()
    monkeypatch.setattr(cover_manual, 'MAX_UPLOAD_BYTES', 100)
    rejected = client.post(endpoint + '/upload', data=data, files={'image': ('large.jpg', b'x' * 101, 'image/jpeg')})
    assert rejected.status_code == 413
    assert client.get(saved.json()['url']).content == before
