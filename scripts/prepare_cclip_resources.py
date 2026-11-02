#!/usr/bin/env python3
"""Build a clean desktop resource tree from explicit runtime inputs, never user projects."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def ignore_runtime(_folder, names):
    return [name for name in names if name in {'__pycache__', 'test', 'tests', 'idlelib', 'ensurepip', '.cache', '.git'}
            or name.endswith(('.pyc', '.pyo', '.log')) or name == 'direct_url.json']


def copy_tree(source, destination, *, ignore=ignore_runtime):
    if source.is_dir():
        shutil.copytree(source, destination, ignore=ignore, symlinks=False)


def copy_backend_source(destination, *, full_app=False):
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'backend'], cwd=ROOT).decode('utf-8').split('\0')
    if 'backend/workbench/app.py' not in tracked:
        raise RuntimeError('Track the CClip source before packaging')
    if full_app and 'backend/cclip/app.py' not in tracked:
        raise RuntimeError('Track the full CClip source before packaging')
    for name in filter(None, tracked):
        relative = Path(name)
        if any(part in {'tests', '__pycache__'} for part in relative.parts):
            continue
        if ('data' in relative.parts or relative.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.rdb', '.log'}
                or relative.name.startswith('.env') or relative.name in {'settings.json', 'credentials.json', 'cookies.json'}):
            raise RuntimeError('Private backend data must not be bundled: ' + name)
        source = ROOT / relative
        if not source.is_file():
            continue
        if not source.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError('Source path escapes checkout')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def verify_runtime(destination, *, full_app=False):
    python = destination / ('python/python.exe' if sys.platform == 'win32' else 'python/bin/python3')
    code = '''import sys
def offline(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        address = args[0] if event == "socket.getaddrinfo" else args[2] if event == "socket.sendto" else args[1]
        host = address[0] if isinstance(address, tuple) else address
        # Windows' asyncio self-pipe uses a loopback socket pair. Permit only
        # local communication so the real API lifespan can be probed offline.
        if host in {"127.0.0.1", "::1", "localhost"}:
            return
        raise PermissionError("offline_probe")
sys.addaudithook(offline)
sys.path.insert(0, sys.argv[1])
import fastapi, uvicorn, psutil, sqlalchemy, faster_whisper
from backend.workbench.app import create_app
from backend.services import whisper_runtime
from backend.utils.speech_recognizer import SpeechRecognizer
from backend.pipeline.clip_finder import find_clips
print("bundled_dependencies_ok")
'''
    if full_app:
        code += '''
from pathlib import Path
from fastapi.testclient import TestClient
from backend.cclip.app import create_app
app = create_app(Path(__import__('os').environ['AUTOCLIP_DATA_DIR']))
with TestClient(app) as client:
    client.get('/api/workbench/session')
    assert client.get('/api/v1/studio/platform-strategies').status_code == 200
    assert client.get('/api/v1/studio/readiness').status_code == 200
    assert client.get('/api/v1/publish/covers/config').status_code == 200
print('bundled_full_product_ok')
'''
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG'}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    with tempfile.TemporaryDirectory(prefix='cclip-probe-', dir=destination.parent) as data:
        logs = Path(data) / 'logs'
        logs.mkdir()
        environment.update(AUTOCLIP_DATA_DIR=data, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        if full_app:
            environment.update(AUTOCLIP_CCLIP_FULL_APP='1', AUTOCLIP_DESKTOP_MODE='true', AUTOCLIP_MODE='desktop',
                               AUTOCLIP_APP_DIR=data, DATABASE_URL=f'sqlite:///{Path(data).as_posix()}/classic.sqlite3',
                               LOG_FILE=str(logs / 'backend.log'))
        result = subprocess.run([str(python), '-c', code, str(destination / 'whisper-runtime')], cwd=destination,
                                env=environment, capture_output=True, timeout=90,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or b'bundled_dependencies_ok' not in result.stdout or (full_app and b'bundled_full_product_ok' not in result.stdout):
        sys.stderr.write(result.stderr.decode('utf-8', errors='replace'))
        raise RuntimeError('bundled_runtime_dependency_check_failed')
    if (destination / 'backend.log').exists():
        raise RuntimeError('runtime_probe_wrote_installation_log')


def prepare(destination, python_root, packages, ffmpeg, runtime_data, *, full_app=False, webview2=None):
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError('Use a new empty resource directory; existing resources are not overwritten')
    destination.mkdir(parents=True)
    python_target = destination / 'python'
    python_target.mkdir()
    if sys.platform == 'win32':
        allowed = ['python.exe', 'pythonw.exe', 'python3.dll', 'python313.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']
        for name in allowed:
            source = python_root / name
            if source.is_file():
                shutil.copyfile(source, python_target / name)
        def standard_ignore(folder, names):
            return ignore_runtime(folder, names) + (['site-packages'] if Path(folder) == python_root / 'Lib' else [])
        copy_tree(python_root / 'Lib', python_target / 'Lib', ignore=standard_ignore)
        copy_tree(python_root / 'DLLs', python_target / 'DLLs')
        copy_tree(packages, python_target / 'Lib' / 'site-packages')
        # Ignore system Python, registry and environment import paths in the shipped runtime.
        (python_target / 'python313._pth').write_text('Lib\nDLLs\nLib/site-packages\n..\nimport site\n', encoding='utf-8')
    else:
        python_target.rmdir()
        copy_tree(python_root, python_target)
        version = f'python{sys.version_info.major}.{sys.version_info.minor}'
        packaged_site = python_target / 'lib' / version / 'site-packages'
        if packaged_site.exists():
            raise RuntimeError('Portable Python input must be clean, without site-packages')
        copy_tree(packages, packaged_site)
    copy_backend_source(destination, full_app=full_app)
    frontend = ROOT / 'frontend' / ('dist-cclip' if full_app else 'dist-workbench')
    if not (frontend / ('cclip.html' if full_app else 'workbench.html')).is_file():
        raise RuntimeError('Build the matching CClip frontend before packaging')
    copy_tree(frontend, destination / 'frontend')
    if full_app:
        shutil.copyfile(ROOT / 'docs/analytics/event_catalog.json', destination / 'backend/core/event_catalog.json')
    copy_tree(runtime_data / 'whisper-runtime', destination / 'whisper-runtime')
    cache_name = 'models--Systran--faster-whisper-base'
    cache = runtime_data / 'whisper-models' / 'hub' / cache_name
    revision = (cache / 'refs/main').read_text(encoding='utf-8').strip()
    if not revision or any(char not in '0123456789abcdef' for char in revision):
        raise RuntimeError('Invalid model snapshot')
    target_cache = destination / 'whisper-models' / 'hub' / cache_name
    copy_tree(cache / 'snapshots' / revision, target_cache / 'snapshots' / revision)
    (target_cache / 'refs').mkdir()
    (target_cache / 'refs/main').write_text(revision, encoding='utf-8')
    tools = destination / 'ffmpeg'
    tools.mkdir()
    for name in ('ffmpeg', 'ffprobe'):
        filename = name + ('.exe' if sys.platform == 'win32' else '')
        shutil.copy2(ffmpeg / filename, tools / filename)
    for name in ('LICENSE', 'LICENSE.txt', 'COPYING.GPLv3'):
        if (ffmpeg / name).is_file():
            shutil.copyfile(ffmpeg / name, tools / name)
    shutil.copyfile(ROOT / 'LICENSE', destination / 'AutoClip-LICENSE.txt')
    (destination / '第三方组件.txt').write_text(
        'CClip 基于 AutoClip，保留其 MIT 许可。\n'
        'FFmpeg 独立可执行程序及对应许可保存在 ffmpeg/。源码与构建来源：https://www.gyan.dev/ffmpeg/builds/ 或 https://ffmpeg.org/\n'
        'Whisper / faster-whisper-base 模型来源：https://huggingface.co/Systran/faster-whisper-base ，上游 Whisper：https://github.com/openai/whisper\n'
        'Python 及各依赖的许可随对应运行目录保留。\n', encoding='utf-8')
    if sys.platform == 'win32' and full_app:
        # Match the available PowerShell installation: a legacy 5.1 process can
        # fail to load Security when launched from a PowerShell 7 build host.
        powershell = shutil.which('pwsh') or shutil.which('powershell') or 'powershell'
        subprocess.run([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                        str(ROOT / 'scripts/prepare_windows_python_crt.ps1'), '-PythonDir', str(python_target)], check=True)
        sys.path.insert(0, str(ROOT / 'scripts'))
        from windows_python_crt import verify
        verify(python_target)
    verify_runtime(destination, full_app=full_app)
    if webview2 is not None:
        if sys.platform != 'win32' or not (webview2 / 'msedgewebview2.exe').is_file():
            raise ValueError('An extracted Windows fixed WebView2 runtime is required')
        copy_tree(webview2, destination / 'webview2', ignore=None)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT))
    (destination / '构建身份.json').write_text(json.dumps({'sourceCommit': commit, 'trackedChanges': dirty,
        'product': 'CClip', 'kind': 'local-full-product' if full_app else 'local-workbench'}, ensure_ascii=False), encoding='utf-8')
    # Inventory contains package-relative paths and hashes only; no personal source paths.
    manifest = {}
    for path in destination.rglob('*'):
        if path.is_file():
            with path.open('rb') as stream:
                manifest[path.relative_to(destination).as_posix()] = {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
    (destination / '资源清单.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'files': len(manifest), 'bytes': sum(item['bytes'] for item in manifest.values()), 'modelRevision': revision}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--python-root', type=Path, default=Path(sys.base_prefix))
    parser.add_argument('--packages', type=Path, required=True)
    parser.add_argument('--ffmpeg', type=Path, required=True)
    parser.add_argument('--runtime-data', type=Path, required=True)
    parser.add_argument('--full-app', action='store_true', help='Bundle all original AutoClip product routes and dependencies')
    parser.add_argument('--webview2', type=Path, help='Extracted official fixed runtime for Windows portable distribution')
    args = parser.parse_args()
    prepare(args.destination, args.python_root, args.packages, args.ffmpeg, args.runtime_data, full_app=args.full_app, webview2=args.webview2)


if __name__ == '__main__':
    main()
