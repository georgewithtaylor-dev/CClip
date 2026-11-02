"""Serve the complete upstream product and the timeline from one local authority."""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.app_factory import create_app as original_app
from backend.workbench.app import create_app as editing_app


def create_app(root: Path, frontend: Path | None = None):
    app = editing_app(root)
    app.state.full_application = True
    app.state.mode = 'desktop'
    upstream = original_app('desktop', telemetry=False)
    editing_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(current):
        async with upstream.router.lifespan_context(current):
            async with editing_lifespan(current):
                yield

    app.router.lifespan_context = lifespan
    # CClip keeps local cover/output processing, but exposes no account posting,
    # scheduler, upload queue or cookie management in this edition.
    def local_product_path(path):
        if path.startswith('/api/v1/publish/'):
            return path.startswith('/api/v1/publish/covers')
        return not (path.startswith('/api/v1/api/upload-queue') or path.startswith('/api/v1/health/check')
                    or path.startswith('/api/v1/health/refresh-cookie') or path.startswith('/api/v1/health/schedule-check')
                    or path.startswith('/api/v1/health/status/') or path == '/api/v1/health/summary')

    app.router.routes.extend(route for route in upstream.router.routes if local_product_path(getattr(route, 'path', '')))

    @app.middleware('http')
    async def no_account_posting(request, call_next):
        # Recent FastAPI versions retain nested routers until dispatch. Guard
        # actual request paths too, so an included router cannot expose posting.
        if not local_product_path(request.url.path):
            return JSONResponse({'error': 'not_found'}, status_code=404)
        return await call_next(request)

    original_openapi = app.openapi

    def local_schema():
        schema = original_openapi()
        return {**schema, 'info': {**schema.get('info', {}), 'title': 'CClip local editing'},
                'paths': {path: value for path, value in schema.get('paths', {}).items() if local_product_path(path)}}

    app.openapi = local_schema
    from .bridge import register
    register(app)
    from .projects import register as register_projects
    register_projects(app)
    from .outputs import register as register_outputs
    register_outputs(app)
    from .storage import register as register_storage
    register_storage(app)
    for exception, handler in upstream.exception_handlers.items():
        if exception not in app.exception_handlers:
            app.add_exception_handler(exception, handler)
    if frontend and frontend.is_dir():
        @app.get('/workbench.html')
        async def timeline():
            document = (frontend / 'workbench.html').read_text(encoding='utf-8')
            document = document.replace('name="workbench-service" content="disabled"', 'name="workbench-service" content="enabled"')
            return HTMLResponse(document, headers={'Cache-Control': 'no-store'})

        @app.get('/')
        @app.get('/cclip.html')
        async def home():
            return HTMLResponse((frontend / 'cclip.html').read_text(encoding='utf-8'), headers={'Cache-Control': 'no-store'})

        app.mount('/', StaticFiles(directory=frontend, html=True), name='cclip')
    return app
