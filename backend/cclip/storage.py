"""Authenticated local storage preferences and streaming saves; no network hop."""
from __future__ import annotations

import os
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from backend.core import cclip_storage as storage
from backend.core import cclip_cache as cache


class Locations(BaseModel):
    model_config = ConfigDict(extra='forbid')
    generated: str = Field(min_length=1, max_length=1024)
    downloads: str = Field(min_length=1, max_length=1024)


class SaveFile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1, max_length=2048)


class TextFile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=180)
    text: str = Field(min_length=1, max_length=5_000_000)


def _filename(value):
    match = re.search(r"filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)", value or '', re.I)
    name = unquote(next((part for part in match.groups() if part), '')) if match else 'CClip.mp4'
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', name).strip(' .')[:180]
    if not name or name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *{f'COM{i}' for i in range(1, 10)}, *{f'LPT{i}' for i in range(1, 10)}}:
        name = f'CClip-{uuid4().hex[:8]}.bin'
    return name


def _new_file(directory, name):
    stem, suffix = Path(name).stem, Path(name).suffix
    for number in range(10000):
        path = directory / (name if number == 0 else f'{stem} ({number}){suffix}')
        try:
            return path, path.open('xb')
        except FileExistsError:
            continue
    raise OSError('storage_name_limit')


def _allowed(path):
    identifier = r'[a-zA-Z0-9_-]{1,100}'
    return any(re.fullmatch(pattern, path) for pattern in (
        rf'/api/workbench/jobs/{identifier}/(?:download|subtitles)',
        rf'/api/v1/studio/{identifier}/exports/{identifier}/video',
        rf'/api/v1/studio/{identifier}/output-variants/{identifier}/(?:cover|kit)',
        rf'/api/v1/publish/covers/{identifier}/clips/{identifier}/file',
        rf'/api/v1/publish/covers/{identifier}/clips/{identifier}/manual/{identifier}/(?:frame|prompt)',
    ))


def register(app):
    storage.initialize()
    router = APIRouter(prefix='/api/cclip/storage')

    @app.get('/api/cclip/build')
    def build_identity():
        root = os.getenv('CCLIP_BUNDLED_RESOURCES')
        try:
            identity = json.loads((Path(root) / '构建身份.json').read_text(encoding='utf-8')) if root else {}
        except (OSError, ValueError):
            identity = {}
        source = identity.get('sourceCommit', '')
        return {'product': 'CClip', 'channel': 'local-preview',
                'sourceCommit': source if re.fullmatch(r'[a-f0-9]{40}', source) else None}

    @router.get('')
    def get_locations():
        try:
            values = storage.settings()
            return {**values, 'legacyGenerated': [str(storage._file('projects')), str(app.state.store.root / 'exports')],
                    'data': str(storage._file('cclip-storage.json').parent)}
        except (OSError, ValueError):
            raise HTTPException(503, 'storage_read_failed') from None

    @router.put('')
    def set_locations(body: Locations):
        try:
            return storage.update(body.model_dump())
        except (ValueError, OSError):
            raise HTTPException(422, 'storage_folder_unavailable') from None

    @router.get('/cache')
    def cache_status():
        try:
            return cache.inspect()
        except (OSError, ValueError):
            raise HTTPException(503, 'cache_unavailable') from None

    @router.post('/cache/clear')
    def clear_cache():
        try:
            return cache.inspect(clear=True)
        except (OSError, ValueError):
            raise HTTPException(503, 'cache_unavailable') from None

    @router.post('/choose')
    def choose_folder():
        try:
            if os.name == 'nt':
                script = ('Add-Type -AssemblyName System.Windows.Forms; '
                          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; '
                          'if ($dialog.ShowDialog() -eq "OK") { [Console]::OutputEncoding = '
                          '[System.Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }; $dialog.Dispose()')
                result = subprocess.run(['powershell.exe', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
                                        capture_output=True, timeout=180, creationflags=subprocess.CREATE_NO_WINDOW)
                if result.returncode:
                    raise OSError('picker_failed')
                return {'path': result.stdout.decode('utf-8-sig').strip() or None}
            if os.sys.platform == 'darwin':
                result = subprocess.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "CClip")'],
                                        capture_output=True, timeout=180)
                return {'path': result.stdout.decode().strip() or None}
            raise OSError('picker_unavailable')
        except (OSError, subprocess.TimeoutExpired):
            raise HTTPException(503, 'storage_picker_unavailable') from None

    @router.post('/open/{kind}')
    def open_folder(kind: str):
        if kind not in ('generated', 'downloads', 'previous-projects', 'previous-workbench'):
            raise HTTPException(422, 'invalid_storage_kind')
        try:
            if kind == 'previous-projects':
                path = storage._file('projects')
            elif kind == 'previous-workbench':
                path = app.state.store.root / 'exports'
            else:
                path = storage.folder(storage.settings()[kind])
            if not path.is_dir():
                raise OSError('storage_folder_unavailable')
            if os.name == 'nt':
                os.startfile(path)
            else:
                subprocess.Popen(['open' if os.sys.platform == 'darwin' else 'xdg-open', str(path)])
            return {'opened': True}
        except (OSError, ValueError):
            raise HTTPException(422, 'storage_folder_unavailable') from None

    @router.post('/save-text')
    def save_text(body: TextFile):
        if Path(body.name).suffix.lower() not in {'.srt', '.txt', '.json'}:
            raise HTTPException(422, 'invalid_text_type')
        path = None
        try:
            path, stream = _new_file(storage.folder(storage.settings()['downloads']), _filename(f'filename="{body.name}"'))
            with stream:
                stream.write(body.text.encode('utf-8'))
            return {'path': str(path), 'sizeBytes': path.stat().st_size}
        except (OSError, ValueError):
            if path:
                path.unlink(missing_ok=True)
            raise HTTPException(503, 'storage_save_failed') from None

    @router.post('/save-file')
    async def save_file(body: SaveFile, request: Request):
        parsed = urlsplit(body.path)
        if parsed.scheme or parsed.netloc or parsed.fragment or '%' in parsed.path or not _allowed(parsed.path):
            raise HTTPException(422, 'invalid_local_file')
        path = None
        stream = None
        size = 0
        try:
            destination = await anyio.to_thread.run_sync(lambda: storage.folder(storage.settings()['downloads']))
            scope = dict(request.scope, method='GET', path=parsed.path, raw_path=parsed.path.encode(),
                         query_string=parsed.query.encode(), endpoint=None)
            # Dispatch only an allowlisted artifact route through this same ASGI app.
            # Stream response chunks straight to disk: no HTTP/proxy and no video-sized buffer.
            scope['headers'] = [(key, value) for key, value in request.scope['headers'] if key.lower() not in (b'content-length', b'content-type', b'range')]
            scope.pop('route', None)
            scope.pop('path_params', None)

            received = False

            async def receive():
                nonlocal received
                if not received:
                    received = True
                    return {'type': 'http.request', 'body': b'', 'more_body': False}
                await anyio.Event().wait()
                return {'type': 'http.disconnect'}

            async def send(message):
                nonlocal path, stream, size
                if message['type'] == 'http.response.start':
                    if message['status'] != 200:
                        raise HTTPException(message['status'], 'local_file_unavailable')
                    headers = dict(message.get('headers', []))
                    disposition = headers.get(b'content-disposition', b'').decode('latin1')
                    if not disposition:
                        content_type = headers.get(b'content-type', b'').split(b';')[0]
                        suffix = {b'image/jpeg': '.jpg', b'image/png': '.png', b'application/x-subrip': '.srt'}.get(content_type, '.mp4')
                        disposition = f'filename="CClip{suffix}"'
                    name = _filename(disposition)
                    path, stream = await anyio.to_thread.run_sync(lambda: _new_file(destination, name))
                elif message['type'] == 'http.response.body':
                    chunk = message.get('body', b'')
                    if chunk and stream:
                        await anyio.to_thread.run_sync(stream.write, chunk)
                        size += len(chunk)

            await app(scope, receive, send)
            if not stream or size == 0:
                raise OSError('empty_file')
            await anyio.to_thread.run_sync(stream.close)
            stream = None
            return {'path': str(path), 'sizeBytes': size}
        except BaseException as error:
            if stream:
                stream.close()
            if path:
                path.unlink(missing_ok=True)
            if isinstance(error, (OSError, ValueError)):
                raise HTTPException(503, 'storage_save_failed') from None
            raise

    app.include_router(router)
