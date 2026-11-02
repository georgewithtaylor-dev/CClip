"""Remove current clip versions without deleting source media or export history."""
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.models.project import Project
from backend.services.studio import store


class OutputRevision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')
    revision: int = Field(ge=1, strict=True)


class RemoveOutputs(BaseModel):
    model_config = ConfigDict(extra='forbid')
    drafts: list[OutputRevision] = Field(min_length=1, max_length=300)


class RestoreOutputs(BaseModel):
    model_config = ConfigDict(extra='forbid')
    undoId: str = Field(pattern=r'^[a-f0-9]{32}$')


def require_idle(data):
    active = {'queued', 'running', 'preparing', 'screening', 'production', 'rendering'}
    if any((data.get(key) or {}).get('status') in active for key in ('analysis', 'generation')):
        raise HTTPException(409, 'output_busy')
    if any(job.get('status') in active or job.get('cover_pending') for job in data['jobs']):
        raise HTTPException(409, 'output_busy')
    if any(item.get('status') in active or (item.get('cover_job') or {}).get('status') in active for item in data['output_variants']):
        raise HTTPException(409, 'output_busy')


def register(app):
    router = APIRouter(prefix='/api/cclip')

    def project_exists(db, project_id):
        try:
            store.directory(project_id)
        except ValueError:
            raise HTTPException(422, 'invalid_output_request') from None
        if db.get(Project, project_id) is None:
            raise HTTPException(404, 'output_not_found')

    @router.post('/projects/{project_id}/outputs/remove')
    def remove_outputs(project_id: str, body: RemoveOutputs, db: Session = Depends(get_db)):
        project_exists(db, project_id)
        identifiers = {item.id for item in body.drafts}
        if len(identifiers) != len(body.drafts):
            raise HTTPException(422, 'invalid_output_request')

        def mutate(data):
            require_idle(data)
            existing = {item['id']: item for item in data['drafts']}
            if not identifiers <= existing.keys():
                raise HTTPException(404, 'output_not_found')
            if any(existing[item.id]['revision'] != item.revision for item in body.drafts):
                raise HTTPException(409, 'output_conflict')
            removal = {'undoId': uuid4().hex, 'removed_at': store.now(),
                       'drafts': [item for item in data['drafts'] if item['id'] in identifiers],
                       'output_variants': [item for item in data['output_variants'] if item['draft_id'] in identifiers]}
            mapping = data.get('cclip_source_clips') or {}
            removal['source_ids'] = sorted({mapping[item] for item in identifiers if item in mapping})
            data['cclip_output_exclusions'] = sorted(set(data.get('cclip_output_exclusions') or []) | set(removal['source_ids']))
            data['drafts'] = [item for item in data['drafts'] if item['id'] not in identifiers]
            data['output_variants'] = [item for item in data['output_variants'] if item['draft_id'] not in identifiers]
            # One undo snapshot is bounded; immutable jobs and downloaded files remain valid.
            data['cclip_removed_output_group'] = removal
            return {'undoId': removal['undoId'], 'removed': len(identifiers)}

        try:
            return store.change(project_id, mutate)
        except OSError:
            raise HTTPException(503, 'output_save_failed') from None

    @router.post('/projects/{project_id}/outputs/restore')
    def restore_outputs(project_id: str, body: RestoreOutputs, db: Session = Depends(get_db)):
        project_exists(db, project_id)

        def mutate(data):
            require_idle(data)
            removal = data.get('cclip_removed_output_group')
            if not removal or removal['undoId'] != body.undoId:
                raise HTTPException(404, 'output_restore_expired')
            identifiers = {item['id'] for item in removal['drafts']}
            variants = {item['id'] for item in removal['output_variants']}
            if identifiers & {item['id'] for item in data['drafts']} or variants & {item['id'] for item in data['output_variants']}:
                raise HTTPException(409, 'output_conflict')
            data['drafts'].extend(removal['drafts'])
            data['output_variants'].extend(removal['output_variants'])
            data['cclip_output_exclusions'] = sorted(set(data.get('cclip_output_exclusions') or []) - set(removal.get('source_ids') or []))
            data.pop('cclip_removed_output_group')
            return {'draftId': removal['drafts'][0]['id'], 'restored': len(identifiers)}

        try:
            return store.change(project_id, mutate)
        except OSError:
            raise HTTPException(503, 'output_save_failed') from None

    app.include_router(router)
