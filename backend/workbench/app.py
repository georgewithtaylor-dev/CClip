"""Loopback-only editing service; no original app bootstrap or telemetry."""
from __future__ import annotations

from contextlib import asynccontextmanager
import hashlib
from pathlib import Path
import secrets
import shutil
import time
from uuid import UUID, uuid4

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from backend.services.studio.models import Draft as StudioDraft

from . import adapters, media
from .jobs import Jobs, digest
from .models import AnalysisSettings, ConsentRequest, JobRequest, Project, SaveRequest
from .store import Conflict, Store
from .editor_preferences import EditorPreferences, load as load_editor_preferences, save as save_editor_preferences


def create_app(root: Path, frontend: Path | None = None):
    store = Store(root)
    jobs = Jobs(store)
    session = secrets.token_urlsafe(32)
    settings = None
    settings_override = False
    generation = 0
    consents = {}

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await run_in_threadpool(jobs.close)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.jobs = jobs

    def refresh_settings():
        nonlocal settings, generation
        resolver = getattr(app.state, 'analysis_settings_resolver', None)
        if resolver is not None and not settings_override:
            current = resolver()
            if current != settings:
                settings = current
                generation += 1
                consents.clear()

    @app.middleware('http')
    async def local_boundary(request: Request, call_next):
        if request.url.hostname not in {'127.0.0.1', 'localhost', '::1', 'testserver'}:
            return JSONResponse({'error': 'invalid_host'}, status_code=403)
        origin = request.headers.get('origin')
        expected = f'{request.url.scheme}://{request.url.netloc}'
        if origin and origin != expected:
            return JSONResponse({'error': 'invalid_origin'}, status_code=403)
        protected = request.url.path.startswith('/api/') if getattr(app.state, 'full_application', False) else request.url.path.startswith('/api/workbench/')
        if protected and request.url.path != '/api/workbench/session':
            if not secrets.compare_digest(request.cookies.get('wb-session', ''), session):
                return JSONResponse({'error': 'session_required'}, status_code=401)
            if request.method not in {'GET', 'HEAD'} and not secrets.compare_digest(request.headers.get('x-workbench-session', ''), session):
                return JSONResponse({'error': 'session_required'}, status_code=403)
            try:
                length = int(request.headers.get('content-length', 0))
            except ValueError:
                return JSONResponse({'error': 'invalid_request'}, status_code=400)
            multipart = request.headers.get('content-type', '').startswith('multipart/form-data')
            if request.url.path != '/api/workbench/assets' and not multipart and length > 20 * 1024 * 1024:
                return JSONResponse({'error': 'request_too_large'}, status_code=413)
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, _error):
        # Pydantic diagnostics contain submitted text/keys; never echo them.
        return JSONResponse({'error': 'invalid_request'}, status_code=422)

    @app.exception_handler(KeyError)
    async def missing(_request, _error):
        return JSONResponse({'error': 'not_found'}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(_request, _error):
        return JSONResponse({'error': 'revision_conflict_or_busy'}, status_code=409)

    @app.exception_handler(media.MediaError)
    async def media_error(_request, error):
        return JSONResponse({'error': str(error)}, status_code=422)

    @app.get('/api/workbench/session')
    async def start_session():
        # Readiness checks must not trigger downloads or network requests.
        runtime = root / 'whisper-runtime' / 'faster_whisper'
        models = root / 'whisper-models' / 'hub' / 'models--Systran--faster-whisper-base' / 'snapshots'
        ready = runtime.is_dir() and models.is_dir() and any(models.glob('*/model.bin'))
        response = JSONResponse({'session': session, 'mediaReady': media.available(), 'asrReady': ready, 'localOnly': True})
        response.set_cookie('wb-session', session, httponly=True, samesite='strict')
        return response

    def validate_asset(project):
        if project.source.assetId:
            info = store.asset(project.source.assetId)
            if project.source.kind != 'local' or abs(info['duration'] - project.source.duration) > .1 or project.source.bytes != info['bytes']:
                raise HTTPException(422, detail='source_mismatch')

    @app.post('/api/workbench/assets')
    async def import_asset(video: UploadFile = File(...)):
        if Path(video.filename or '').suffix.lower() not in {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'}:
            raise HTTPException(422, detail='unsupported_media')
        asset_id = str(uuid4())
        folder = store.root / 'assets' / asset_id
        folder.mkdir()
        pending = folder / 'upload.pending'
        checksum, size = hashlib.sha256(), 0
        try:
            with pending.open('wb') as output:
                while chunk := await video.read(1024 * 1024):
                    size += len(chunk)
                    if size > 10 * 1024 * 1024 * 1024:
                        raise HTTPException(413, detail='media_too_large')
                    checksum.update(chunk)
                    output.write(chunk)
            info = await run_in_threadpool(media.probe, pending)
            info.update(assetId=asset_id, name=Path(video.filename).name, bytes=size, kind='local')
            pending.replace(folder / 'source.mp4')
            store.add_asset(asset_id, info, checksum.hexdigest())
            return info
        except Exception:
            # This UUID folder was created by this request, beneath the managed assets root.
            if folder.resolve().parent != (store.root / 'assets').resolve():
                raise RuntimeError('invalid_cleanup_target') from None
            shutil.rmtree(folder)
            raise
        finally:
            await video.close()

    @app.get('/api/workbench/assets/{asset_id}/video')
    async def asset_video(asset_id: UUID):
        return FileResponse(store.asset_path(asset_id), media_type='video/mp4')

    @app.get('/api/workbench/assets/{asset_id}/thumbnail')
    def asset_thumbnail(asset_id: UUID, time: float = 0):
        import math
        info = store.asset(asset_id)
        if not math.isfinite(time) or time < 0 or time > info['duration']:
            raise HTTPException(422, 'invalid_range')
        frame = media.thumbnail(store.asset_path(asset_id), store.root / 'thumbnails' / str(asset_id), min(time, max(0, info['duration'] - .1)))
        return FileResponse(frame, media_type='image/jpeg', headers={'Cache-Control': 'private, max-age=86400'})

    @app.get('/api/workbench/assets/{asset_id}/waveform')
    def asset_waveform(asset_id: UUID):
        from .waveform import waveform
        info = store.asset(asset_id)
        return JSONResponse(waveform(store.asset_path(asset_id), store.root / 'waveforms' / str(asset_id),
                                     info['duration'], info.get('hasAudio', False)),
                            headers={'Cache-Control': 'private, max-age=86400'})

    @app.get('/api/workbench/projects')
    async def list_projects():
        return store.projects()

    @app.get('/api/workbench/template-assets/{template}/{filename}')
    def preview_template_asset(template: str, filename: str):
        from .template_preview import template_asset
        return template_asset(template, filename)

    @app.post('/api/workbench/template-preview')
    def preview_template(value: StudioDraft):
        from .template_preview import preview_fill
        return preview_fill(value)

    @app.get('/api/workbench/editor-preferences')
    def editor_preferences():
        return load_editor_preferences(store.root)

    @app.put('/api/workbench/editor-preferences')
    def update_editor_preferences(value: EditorPreferences):
        return save_editor_preferences(store.root, value)

    @app.post('/api/workbench/projects')
    async def create_project(project: Project):
        validate_asset(project)
        record = store.create(project.document())
        if callable(getattr(app.state, 'workbench_created', None)):
            app.state.workbench_created(record)
        return record

    @app.get('/api/workbench/projects/{project_id}')
    async def get_project(project_id: UUID):
        return store.get(project_id)

    @app.put('/api/workbench/projects/{project_id}')
    async def save_project(project_id: UUID, body: SaveRequest):
        validate_asset(body.project)
        return store.save(project_id, body.project.document(), body.revision)

    @app.post('/api/workbench/analysis-settings')
    async def analysis_settings(body: AnalysisSettings):
        nonlocal settings, generation, settings_override
        try:
            adapters.endpoint(body.baseUrl)
        except ValueError:
            raise HTTPException(422, detail='invalid_endpoint') from None
        settings = body
        settings_override = True
        generation += 1
        consents.clear()
        return {'configured': True, 'baseUrl': body.baseUrl, 'model': body.model}

    @app.get('/api/workbench/analysis-settings')
    async def read_settings():
        refresh_settings()
        return {'configured': settings is not None, 'baseUrl': settings.baseUrl if settings else '', 'model': settings.model if settings else ''}

    @app.get('/api/workbench/projects/{project_id}/analysis-preview')
    async def analysis_preview(project_id: UUID):
        refresh_settings()
        if settings is None:
            raise HTTPException(409, detail='analysis_not_configured')
        record = store.get(project_id)
        return {'projectId': str(project_id), 'revision': record['revision'], 'baseUrl': settings.baseUrl, 'model': settings.model,
                'scope': 'transcript_only', 'sentences': len(record['project']['cues']),
                'characters': sum(len(cue['text']) for cue in record['project']['cues']), 'digest': digest(record['project'])}

    @app.post('/api/workbench/projects/{project_id}/analysis-consent')
    async def analysis_consent(project_id: UUID, body: ConsentRequest):
        refresh_settings()
        if not body.approved or settings is None:
            raise HTTPException(403, detail='consent_required')
        record = store.get(project_id)
        if record['revision'] != body.revision:
            raise Conflict()
        consent_id = secrets.token_urlsafe(32)
        consents[consent_id] = {'project': str(project_id), 'revision': body.revision, 'digest': digest(record['project']),
                                'generation': generation, 'expires': time.monotonic() + 600}
        return {'consentId': consent_id}

    @app.post('/api/workbench/projects/{project_id}/jobs')
    async def start_job(project_id: UUID, body: JobRequest):
        refresh_settings()
        record = store.get(project_id)
        if body.revision != record['revision']:
            raise Conflict()
        if not record['project']['source'].get('assetId'):
            raise HTTPException(422, detail='local_media_required')
        if body.kind == 'export' and body.clipId and not any(clip['id'] == body.clipId for clip in record['project']['clips']):
            raise HTTPException(422, detail='clip_not_found')
        if body.kind == 'analyze':
            consent = consents.pop(body.consentId, None)
            if settings is None or not consent or consent['project'] != str(project_id) or consent['revision'] != body.revision \
                    or consent['generation'] != generation or consent['digest'] != digest(record['project']) or consent['expires'] < time.monotonic():
                raise HTTPException(403, detail='consent_required')
            if not record['project']['cues']:
                raise HTTPException(422, detail='transcript_required')
        return jobs.start(record, body, settings.model_copy(deep=True) if settings else None)

    @app.get('/api/workbench/jobs/{job_id}')
    async def get_job(job_id: UUID):
        return store.job(job_id)

    @app.post('/api/workbench/jobs/{job_id}/cancel')
    async def cancel_job(job_id: UUID):
        store.job(job_id)
        jobs.cancel(job_id)
        return {'requested': True}

    def completed_export(job_id):
        job = store.job(job_id)
        if job['kind'] != 'export' or job['status'] != 'completed':
            raise HTTPException(409, detail='export_not_ready')
        from backend.core.cclip_storage import output
        return output('workbench', job['project_id'], str(job_id), store.root / 'exports' / f'{job_id}.mp4')

    @app.get('/api/workbench/jobs/{job_id}/download')
    async def download_export(job_id: UUID):
        return FileResponse(completed_export(job_id), media_type='video/mp4', filename='剪辑成片.mp4')

    @app.get('/api/workbench/jobs/{job_id}/subtitles')
    async def download_subtitles(job_id: UUID):
        return FileResponse(completed_export(job_id).with_suffix('.srt'), media_type='application/x-subrip', filename='成片字幕.srt')

    if frontend and frontend.is_dir():
        @app.get('/workbench.html')
        async def workbench_page():
            document = (frontend / 'workbench.html').read_text(encoding='utf-8')
            return HTMLResponse(document.replace('name="workbench-service" content="disabled"', 'name="workbench-service" content="enabled"'), headers={'Cache-Control': 'no-store'})
        app.mount('/', StaticFiles(directory=frontend, html=True), name='workbench')
    return app
