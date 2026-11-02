"""Cleanup must stop at ownership, active-worker and filesystem boundaries."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest

from backend.core import cclip_cache as cache
from backend.core import cclip_storage as storage
from backend.tests.test_cclip import full  # noqa: F401


def orphan(root):
    folder = root / str(uuid4())
    folder.mkdir()
    (folder / '.scratch').write_text('cclip-scratch-v1')
    (folder / 'temporary.wav').write_bytes(b'x' * 128)
    return folder


def test_cleanup_preserves_user_files_and_old_unowned_cache(full, tmp_path):
    client, _, _, _ = full
    generated = Path(client.get('/api/cclip/storage').json()['generated'])
    root = cache.location()
    leftover = orphan(root)
    protected = [generated / 'finished.mp4', generated / '.render-cache' / 'old.wav',
                 tmp_path / 'captions.srt', tmp_path / 'model.bin', root / 'unrecognised' / 'keep.txt']
    for path in protected:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'keep')
    unknown = root / str(uuid4())
    unknown.mkdir()
    (unknown / 'user.txt').write_text('keep')
    before = client.get('/api/cclip/storage/cache').json()
    assert before['files'] == 2 and before['bytes'] > 128 and before['retained'] == 2
    result = client.post('/api/cclip/storage/cache/clear')
    assert result.status_code == 200 and result.json()['bytes'] == before['bytes']
    assert not leftover.exists() and all(path.read_bytes() == b'keep' for path in protected)
    assert unknown.exists() and client.get('/api/cclip/storage/cache').json()['files'] == 0
    # A path supplied by the client cannot change the cleanup scope.
    assert client.post('/api/cclip/storage/cache/clear', json={'path': str(tmp_path)}).status_code == 200
    assert all(path.exists() for path in protected)


def test_active_workspace_cannot_be_cleaned_and_normal_exit_removes_scratch(full):
    client, wb, *_ = full
    with cache.workspace(wb.root / 'jobs', str(uuid4())) as folder:
        (folder / 'render.wav').write_bytes(b'active')
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(lambda: client.post('/api/cclip/storage/cache/clear').json()).result(timeout=5)
        assert result['busy'] == 1 and result['files'] == 0
        assert (folder / 'render.wav').read_bytes() == b'active'
    assert not folder.exists()


def test_older_registered_cache_after_folder_change_is_cleanable(full, tmp_path):
    client, *_ = full
    first = cache.location()
    before = orphan(first)
    saved = client.get('/api/cclip/storage').json()
    assert client.put('/api/cclip/storage', json={'generated': str(tmp_path / 'another-drive'), 'downloads': saved['downloads']}).status_code == 200
    second = cache.location()
    after = orphan(second)
    assert first != second
    result = client.post('/api/cclip/storage/cache/clear').json()
    assert result['files'] == 4 and len(result['paths']) == 2
    assert not before.exists() and not after.exists()


@pytest.mark.parametrize('damage', ['owner', 'registry', 'root', 'entry'])
def test_corrupt_ownership_and_links_fail_closed(full, tmp_path, monkeypatch, damage):
    client, *_ = full
    root = cache.location()
    folder = orphan(root)
    if damage == 'owner':
        (root / '.owner').write_text('someone-else')
    elif damage == 'registry':
        storage._file('cclip-cache.json').write_text('{invalid')
    else:
        linked = root if damage == 'root' else folder / 'temporary.wav'
        original = cache._linked
        monkeypatch.setattr(cache, '_linked', lambda path: path == linked or original(path))
    result = client.post('/api/cclip/storage/cache/clear')
    assert result.status_code == (503 if damage == 'registry' else 200)
    assert (folder / 'temporary.wav').read_bytes() == b'x' * 128


def test_registry_cannot_designate_an_unrelated_folder(full, tmp_path):
    client, *_ = full
    root = cache.location()
    record = json.loads(storage._file('cclip-cache.json').read_text())
    unrelated = tmp_path / 'unrelated'
    unrelated.mkdir()
    marker = unrelated / '.owner'
    marker.write_text(record['owner'])
    folder = orphan(unrelated)
    record['roots'] = [str(unrelated)]
    storage._write('cclip-cache.json', record)
    assert client.post('/api/cclip/storage/cache/clear').json()['retained'] == 1
    assert folder.exists() and root.exists()


def test_standalone_upstream_workspace_still_uses_legacy_path(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTOCLIP_DATA_DIR', str(tmp_path))
    legacy = tmp_path / 'jobs'
    legacy.mkdir()
    with cache.workspace(legacy, str(uuid4())) as folder:
        assert folder.parent == legacy
    assert not folder.exists() and not (tmp_path / 'cclip-cache.json').exists()
