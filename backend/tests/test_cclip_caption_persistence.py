"""Edited output captions and bookmarks survive save, duplicate and reload."""
from backend.tests.test_cclip import full, video  # noqa: F401
from backend.tests.test_cclip_catalog_cover import project


def test_caption_edits_bookmarks_and_cover_choices_reach_persistence(full, video, monkeypatch):
    client, _, record = project(full, video)
    opened = client.post(f'/api/cclip/workbench/{record["id"]}/platform-drafts', json={'revision': record['revision'], 'clipId': 'second'}).json()
    pid, did = opened['projectId'], opened['draftId']
    from backend.services.studio import store
    draft = next(item for item in store.read(pid)['drafts'] if item['id'] == did)
    draft['subtitle_cues'] = [{'start': 2.1, 'end': 3.5, 'text': 'Edited locally', 'original': ''}]
    draft['caption_bookmarks'] = [{'id': 'bookmark-one', 'time': 2.5, 'label': 'Keep this detail'}]
    url = f'/api/v1/studio/{pid}/drafts/{did}'
    saved = client.put(url, json=draft)
    assert saved.status_code == 200, saved.text
    current = saved.json()
    reloaded = client.get(f'/api/v1/studio/{pid}').json()
    assert next(item for item in reloaded['drafts'] if item['id'] == did)['caption_bookmarks'] == draft['caption_bookmarks']
    copied = client.post(url + '/duplicate', json={'draft': current, 'title': 'Copy', 'language': current['language']})
    assert copied.status_code == 200, copied.text
    assert copied.json()['caption_bookmarks'] == draft['caption_bookmarks']
    assert copied.json()['subtitle_cues'] == current['subtitle_cues']
    from backend.services import cover
    monkeypatch.setattr(cover, 'generate_image', lambda **_k: (_ for _ in ()).throw(AssertionError('No cloud calls')))
    endpoint = f'/api/v1/publish/covers/{pid}/clips/draft-{did}'
    local = client.post(endpoint, json={'platform': 'xiaohongshu', 'title': 'Current frame', 'force_local': True, 'sync': True,
                                      'frame_time': 3.5, 'image_layout': 'fit', 'title_position': 'top', 'send_reference': False})
    assert local.status_code == 200, local.text
    value = client.get(endpoint + '?platform=xiaohongshu').json()
    assert value['frame_time'] == 3.5 and value['image_layout'] == 'fit' and value['title_position'] == 'top'
    assert value['reference_sent'] is False
    assert client.post(endpoint, json={'sync': True, 'force_local': True, 'frame_time': 0}).status_code == 400
    assert client.post(endpoint, json={'sync': True, 'frame_time': -1}).status_code == 422
    assert client.post(endpoint, json={'sync': True, 'image_layout': 'arbitrary'}).status_code == 422
    assert client.post(endpoint, json={'sync': True, 'title_position': 'arbitrary'}).status_code == 422
    for marks in [[{'id': 'same', 'time': 2, 'label': ''}] * 2, [{'id': 'beyond', 'time': 900, 'label': ''}], [{'id': '', 'time': 2, 'label': ''}]]:
        assert client.put(url, json={**current, 'caption_bookmarks': marks}).status_code == 422
    assert next(item for item in client.get(f'/api/v1/studio/{pid}').json()['drafts'] if item['id'] == did)['caption_bookmarks'] == draft['caption_bookmarks']
