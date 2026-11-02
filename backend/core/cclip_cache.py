"""Discardable workspaces, isolated from source media and completed exports.

Only roots registered by this profile and bearing its ownership marker are
eligible. An OS lock protects a root for the entire worker lifetime, including
across backend processes. Unrecognised files and filesystem links are retained.
"""
import os
import re
import shutil
import stat
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from backend.core import cclip_storage as storage

_REGISTRY = 'cclip-cache.json'
_JOB = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _plain(path):
    return path.is_absolute() and all(not _linked(part) for part in (path, *path.parents))


def _registry():
    value = storage._read(_REGISTRY, {'owner': uuid4().hex, 'roots': []})
    if (not isinstance(value, dict) or not isinstance(value.get('owner'), str)
            or not re.fullmatch(r'[a-f0-9]{32}', value['owner']) or not isinstance(value.get('roots'), list)
            or any(not isinstance(root, str) or not Path(root).is_absolute() for root in value['roots'])):
        raise ValueError('invalid_cache_registry')
    return value


@contextmanager
def _lease(root, *, blocking):
    # Keep the lock outside job folders, so Windows can remove an orphan folder
    # while holding this lock. Never unlink the lock file (inode reuse race).
    path = root / '.lock'
    if path.exists() and _linked(path):
        raise ValueError('linked_cache_lock')
    with path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        acquired = False
        try:
            if os.name == 'nt':
                import msvcrt
                # LK_LOCK has a finite retry budget; workers normally have a
                # single executor and do not compete for this profile's root.
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            acquired = True
            yield
        finally:
            if acquired:
                stream.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream, fcntl.LOCK_UN)


def location():
    with storage._lock:
        record = _registry()
        root = storage.folder(storage.settings()['generated']) / '.cclip-cache' / record['owner']
        root.mkdir(parents=True, exist_ok=True)
        if not _plain(root):
            raise ValueError('linked_cache_root')
        marker = root / '.owner'
        if marker.exists():
            if _linked(marker) or marker.read_text(encoding='utf-8') != record['owner']:
                raise ValueError('invalid_cache_owner')
        else:
            # An existing, unmarked directory is never adopted for deletion.
            if any(root.iterdir()):
                raise ValueError('unowned_cache_root')
            marker.write_text(record['owner'], encoding='utf-8')
        if str(root) not in record['roots']:
            record['roots'].append(str(root))
            storage._write(_REGISTRY, record)
        return root


def _size(folder):
    total = count = 0
    for path in folder.rglob('*'):
        if _linked(path):
            raise ValueError('linked_cache_entry')
        if path.is_file():
            total += path.stat().st_size
            count += 1
    return total, count


@contextmanager
def workspace(legacy, identifier):
    if not _JOB.fullmatch(identifier):
        raise ValueError('invalid_cache_job')
    if not storage._file('cclip-storage.json').exists():
        folder = legacy / identifier
        folder.mkdir()
        try:
            yield folder
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        return
    root = location()
    with _lease(root, blocking=True):
        folder = root / identifier
        folder.mkdir()
        (folder / '.scratch').write_text('cclip-scratch-v1', encoding='utf-8')
        try:
            yield folder
        finally:
            # Retain unexpected links; the cleanup action applies the same rule.
            try:
                _size(folder)
                shutil.rmtree(folder)
            except (OSError, ValueError):
                pass


def inspect(*, clear=False):
    with storage._lock:
        record = _registry()
    result = {'paths': [], 'bytes': 0, 'files': 0, 'busy': 0, 'retained': 0}
    for value in record['roots']:
        root = Path(value)
        try:
            if not root.exists():
                continue
            marker = root / '.owner'
            if (root.name != record['owner'] or root.parent.name != '.cclip-cache' or not _plain(root)
                    or _linked(marker) or marker.read_text(encoding='utf-8') != record['owner']):
                result['retained'] += 1
                continue
            result['paths'].append(str(root))
            with _lease(root, blocking=False):
                for folder in root.iterdir():
                    if folder.name in ('.owner', '.lock'):
                        continue
                    marker = folder / '.scratch'
                    if (not _JOB.fullmatch(folder.name) or _linked(folder) or not folder.is_dir()
                            or not marker.is_file() or _linked(marker)
                            or marker.read_text(encoding='utf-8') != 'cclip-scratch-v1'):
                        result['retained'] += 1
                        continue
                    try:
                        size, count = _size(folder)
                        if clear:
                            shutil.rmtree(folder)
                        result['bytes'] += size
                        result['files'] += count
                    except (OSError, ValueError):
                        result['retained'] += 1
        except BlockingIOError:
            result['busy'] += 1
        except OSError as error:
            # msvcrt uses EACCES for an occupied non-blocking byte lock.
            if getattr(error, 'winerror', None) in (33, 36) or (os.name == 'nt' and error.errno == 13):
                result['busy'] += 1
            else:
                result['retained'] += 1
        except ValueError:
            result['retained'] += 1
    return result
