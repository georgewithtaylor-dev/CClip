"""Exclusive data-directory ownership and recoverable bundled-runtime setup."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil


class AlreadyRunning(Exception):
    pass


@contextmanager
def data_lease(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.service.lock').open('a+b') as stream:
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise AlreadyRunning() from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def prepare_bundled_runtime(resources: Path, root: Path):
    root.mkdir(parents=True, exist_ok=True)
    for name in ('whisper-runtime', 'whisper-models'):
        original, destination = resources / name, root / name
        if not original.is_dir() or destination.exists():
            continue
        pending = root / (name + '.preparing')
        if pending.exists():
            if pending.is_symlink() or getattr(pending, 'is_junction', lambda: False)() or pending.resolve().parent != root.resolve():
                raise RuntimeError('invalid_runtime_target')
            shutil.rmtree(pending)
        shutil.copytree(original, pending)
        pending.replace(destination)
