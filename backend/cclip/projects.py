"""One saved-project catalogue and explicit lifecycle for temporary timeline edits."""
import json
from datetime import timezone
import shutil
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.models.project import Project as OriginalProject
from backend.workbench.store import Conflict
from .bridge import HandoffRequest, lock, project_fingerprint


def register(app):
    wb = app.state.store
    with wb.connect() as connection:
        connection.execute('CREATE TABLE IF NOT EXISTS cclip_saved_projects (wb_id TEXT PRIMARY KEY, saved INTEGER NOT NULL)')
        connection.execute('CREATE TABLE IF NOT EXISTS cclip_cleanup_paths (relative_path TEXT PRIMARY KEY)')
        columns = {item['name'] for item in connection.execute('PRAGMA table_info(cclip_saved_projects)')}
        if 'document' not in columns:
            connection.execute("ALTER TABLE cclip_saved_projects ADD COLUMN document TEXT NOT NULL DEFAULT ''")
        # Existing versions did not distinguish explicit saves. Protect every old
        # durable edit rather than infer deletion from revision numbers or titles.
        connection.execute('INSERT OR IGNORE INTO cclip_saved_projects SELECT id,1,document FROM projects')
        connection.execute("UPDATE cclip_saved_projects SET document=(SELECT document FROM projects WHERE id=wb_id) WHERE saved=1 AND document='' AND wb_id IN (SELECT id FROM projects)")

    def created(record):
        with wb.connect() as connection:
            connection.execute("INSERT INTO cclip_saved_projects VALUES(?,0,'')", (record['id'],))
    app.state.workbench_created = created

    def mark_saved(project_id):
        document = json.dumps(wb.get(project_id)['project'], ensure_ascii=False)
        with wb.connect() as connection:
            connection.execute('INSERT INTO cclip_saved_projects VALUES(?,1,?) ON CONFLICT(wb_id) DO UPDATE SET saved=1,document=excluded.document', (str(project_id), document))
    app.state.mark_workbench_saved = mark_saved

    def cleanup_files():
        with wb.connect() as connection:
            paths = [item['relative_path'] for item in connection.execute('SELECT relative_path FROM cclip_cleanup_paths')]
        for relative in paths:
            target = wb.root / relative
            if not target.resolve().is_relative_to(wb.root) or target.resolve() == wb.root or target.is_symlink() or getattr(target, 'is_junction', lambda: False)():
                continue
            try:
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.is_file():
                    target.unlink()
            except OSError:
                # A player can still hold the file on Windows during navigation.
                # Persist the cleanup receipt and retry on the next close/start.
                continue
            with wb.connect() as connection:
                connection.execute('DELETE FROM cclip_cleanup_paths WHERE relative_path=?', (relative,))

    def remove(project_id, only_unsaved=True):
        project_id = str(project_id)
        with lock, wb.connect() as connection:
            row = connection.execute('SELECT p.document,p.revision,s.saved,s.document AS snapshot FROM projects p LEFT JOIN cclip_saved_projects s ON s.wb_id=p.id WHERE p.id=?', (project_id,)).fetchone()
            if row is None:
                return False
            if only_unsaved and row['saved'] != 0:
                # Task preparation persists a working copy. Discard must restore
                # the last explicit save, not silently retain those edits.
                if row['snapshot'] and project_fingerprint(json.loads(row['snapshot'])) != project_fingerprint(json.loads(row['document'])):
                    if connection.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
                        raise Conflict()
                    wb.save(project_id, json.loads(row['snapshot']), row['revision'])
                return False
            if connection.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
                raise Conflict()
            asset_id = json.loads(row['document'])['source'].get('assetId')
            jobs = [item['id'] for item in connection.execute('SELECT id FROM jobs WHERE project_id=?', (project_id,))]
            connection.execute('DELETE FROM jobs WHERE project_id=?', (project_id,))
            connection.execute('DELETE FROM cclip_links WHERE wb_id=?', (project_id,))
            connection.execute('DELETE FROM cclip_saved_projects WHERE wb_id=?', (project_id,))
            connection.execute('DELETE FROM projects WHERE id=?', (project_id,))
            referenced = any(json.loads(item['document'])['source'].get('assetId') == asset_id for item in connection.execute('SELECT document FROM projects'))
            if asset_id and not referenced:
                connection.execute('DELETE FROM assets WHERE id=?', (asset_id,))
            # Only UUID paths beneath this local authority; never touch the original.
            targets = [wb.root / 'jobs' / str(UUID(job)) for job in jobs]
            targets.extend(wb.root / 'exports' / f'{UUID(job)}{suffix}' for job in jobs for suffix in ('.mp4', '.srt'))
            if asset_id and not referenced:
                targets.extend([wb.root / 'assets' / str(UUID(asset_id)), wb.root / 'transcripts' / str(UUID(asset_id)), wb.root / 'thumbnails' / str(UUID(asset_id))])
            for target in targets:
                connection.execute('INSERT OR IGNORE INTO cclip_cleanup_paths VALUES(?)', (target.relative_to(wb.root).as_posix(),))
            connection.commit()
            cleanup_files()
            return True

    def discard_all():
        with wb.connect() as connection:
            ids = [item['wb_id'] for item in connection.execute('SELECT wb_id FROM cclip_saved_projects')]
        for project_id in ids:
            try:
                remove(project_id)
            except Conflict:
                continue
        cleanup_files()
    # A previous process has already marked interrupted jobs failed in Store.__init__.
    discard_all()
    app.state.discard_unsaved_workbench = discard_all

    router = APIRouter(prefix='/api/cclip')

    @router.get('/projects')
    def catalogue(db: Session = Depends(get_db)):
        originals = db.query(OriginalProject).all()
        original_ids = {item.id for item in originals}
        with wb.connect() as connection:
            links = [dict(item) for item in connection.execute('SELECT * FROM cclip_links')]
            saved = {item['wb_id'] for item in connection.execute('SELECT wb_id FROM cclip_saved_projects WHERE saved=1')}
        linked = {item['wb_id'] for item in links if item['project_id'] in original_ids}
        rows = []
        for item in originals:
            config = item.processing_config or {}
            if config.get('import_staging'):
                continue
            edits = [link for link in links if link['project_id'] == item.id and link['wb_id'] in saved]
            latest = max((wb.get(link['wb_id']) for link in edits), key=lambda record: record['updated'], default=None)
            rows.append({'id': f'project:{item.id}', 'title': item.name, 'project_id': item.id,
                         'route': f'/project/{item.id}', 'status': getattr(item.status, 'value', item.status),
                         'updated': latest['updated'] if latest else item.updated_at.replace(tzinfo=timezone.utc).isoformat(),
                         'saved_edits': len(edits), 'thumbnail': (item.thumbnail if item.thumbnail.startswith('data:image/') else f'data:image/jpeg;base64,{item.thumbnail}') if item.thumbnail else None})
        for item in wb.projects():
            if item['id'] not in saved or item['id'] in linked:
                continue
            rows.append({'id': f'workbench:{item["id"]}', 'title': item['title'], 'workbench_id': item['id'],
                         'route': f'/workbench/{item["id"]}', 'status': 'saved', 'updated': item['updated'], 'saved_edits': 1})
        return sorted(rows, key=lambda item: item['updated'], reverse=True)

    @router.get('/workbench/{project_id}/context')
    def context(project_id: UUID, db: Session = Depends(get_db)):
        wb.get(project_id)
        with wb.connect() as connection:
            link = connection.execute('SELECT project_id,draft_id FROM cclip_links WHERE wb_id=?', (str(project_id),)).fetchone()
            state = connection.execute('SELECT saved FROM cclip_saved_projects WHERE wb_id=?', (str(project_id),)).fetchone()
        saved = state is None or bool(state['saved'])
        if link and db.get(OriginalProject, link['project_id']):
            return {'projectId': link['project_id'], 'draftId': link['draft_id'] or None, 'saved': saved}
        return {'projectId': None, 'draftId': None, 'saved': saved}

    @router.post('/workbench/{project_id}/saved')
    def save(project_id: UUID, body: HandoffRequest, db: Session = Depends(get_db)):
        with lock:
            record = wb.get(project_id)
            if record['revision'] != body.revision:
                raise Conflict()
            with wb.connect() as connection:
                link = connection.execute("SELECT project_id FROM cclip_links WHERE wb_id=? AND draft_id=''", (str(project_id),)).fetchone()
            if link:
                original = db.get(OriginalProject, link['project_id'])
                if original:
                    original.name = record['project']['title']
                    db.commit()
            mark_saved(project_id)
        return {'saved': True}

    @router.delete('/workbench/{project_id}/unsaved')
    def discard(project_id: UUID):
        return {'discarded': remove(project_id)}

    @router.delete('/unsaved')
    def discard_temporary():
        discard_all()
        return {'discarded': True}

    @router.delete('/projects/{kind}/{project_id}')
    def delete(kind: str, project_id: UUID, db: Session = Depends(get_db)):
        with lock:
            if kind == 'workbench':
                return {'deleted': remove(project_id, only_unsaved=False)}
            if kind != 'project':
                raise HTTPException(404)
            with wb.connect() as connection:
                ids = [item['wb_id'] for item in connection.execute('SELECT wb_id FROM cclip_links WHERE project_id=?', (str(project_id),))]
                if any(connection.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (value,)).fetchone() for value in ids):
                    raise Conflict()
            from backend.services.project_service import ProjectService
            if not ProjectService(db).delete_project_with_files(str(project_id)):
                raise HTTPException(409, '项目正在使用或已不存在')
            for value in ids:
                remove(value, only_unsaved=False)
        return {'deleted': True}

    app.include_router(router)
