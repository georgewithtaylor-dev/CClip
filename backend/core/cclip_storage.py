"""CClip media locations. Old outputs remain addressable after a location change.

Only CClip creates this preference file; the upstream application keeps its paths.
The private index is never returned to a provider or included in a project export.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
import threading

from backend.core.path_utils import get_data_directory

_lock = threading.RLock()
_ID = re.compile(r'^[a-zA-Z0-9_-]{1,100}$')


def _file(name: str) -> Path:
    return get_data_directory() / name


def _read(name: str, default):
    path = _file(name)
    if not path.exists():
        return default
    # A broken preference/index must never silently redirect a render to C:.
    return json.loads(path.read_text(encoding='utf-8'))


def _write(name: str, value):
    path = _file(name)
    descriptor, temporary = tempfile.mkstemp(prefix=path.stem, suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def settings():
    return _read('cclip-storage.json', {
        'generated': str(get_data_directory() / 'generated'),
        'downloads': str(Path.home() / 'Downloads'),
    })


def initialize():
    with _lock:
        if not _file('cclip-storage.json').exists():
            _write('cclip-storage.json', settings())


def folder(value: str, *, probe: bool = True) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute() or not str(value).strip() or '\x00' in value:
        raise ValueError('storage_absolute_path_required')
    if os.name == 'nt' and (str(path).startswith('\\\\') or len(path.parts) < 2):
        raise ValueError('storage_local_folder_required')
    # Reject a missing drive/mount instead of creating a replacement mount folder.
    if os.sys.platform == 'darwin' and path.parts[1:2] == ('Volumes',) and len(path.parts) > 2 and not Path(*path.parts[:3]).is_dir():
        raise OSError('storage_drive_unavailable')
    if not Path(path.anchor).is_dir():
        raise OSError('storage_drive_unavailable')
    if probe:
        path.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=path) as stream:
            stream.write(b'CClip storage check')
            stream.flush()
    return path.resolve()


def update(values):
    with _lock:
        checked = {key: str(folder(values[key])) for key in ('generated', 'downloads')}
        _write('cclip-storage.json', checked)
        return checked


def _key(kind: str, project: str, identifier: str) -> str:
    if not all(_ID.fullmatch(value) for value in (kind, project, identifier)):
        raise ValueError('invalid_output_identifier')
    return ':'.join((kind, project, identifier))


def output(kind: str, project: str, identifier: str, legacy: Path, *, create: bool = False) -> Path:
    if not _file('cclip-storage.json').exists():
        return legacy
    key = _key(kind, project, identifier)
    with _lock:
        index = _read('cclip-media-index.json', {})
        if key in index:
            return Path(index[key])
        if not create:
            return legacy
        root = folder(settings()['generated'])
        target = root / kind / project / legacy.name
        target.parent.mkdir(parents=True, exist_ok=True)
        index[key] = str(target)
        _write('cclip-media-index.json', index)
        return target


def studio_output(project: str, job: str, *, create: bool = False) -> Path:
    from backend.services.studio.store import directory
    return output('studio', project, job, directory(project) / 'output' / 'studio' / f'{job}.mp4', create=create)


def scratch(legacy: Path) -> Path:
    if not _file('cclip-storage.json').exists():
        return legacy
    from backend.core.cclip_cache import location
    return location()


def media_index():
    with _lock:
        return dict(_read('cclip-media-index.json', {}))


def remember_output(key: str, path: Path):
    with _lock:
        index = _read('cclip-media-index.json', {})
        index[key] = str(path)
        _write('cclip-media-index.json', index)
