"""Versioned handoff between upstream Studio drafts and the full-source timeline."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
from uuid import UUID, uuid4
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from backend.core.database import get_db
from backend.models.clip import Clip as OriginalClip
from backend.models.project import Project as OriginalProject, ProjectStatus
from backend.services.publish_export import find_source_srt, find_source_video
from backend.services.studio import store as studio
from backend.services.studio.models import Draft, PackagingCue, Scene
from backend.workbench import media
from backend.workbench.models import Project
from backend.workbench.store import Conflict

lock = threading.RLock()


def project_fingerprint(document):
    # Saving can advance the local revision without changing the edit itself.
    value = Project.model_validate(document).model_dump(mode='json', exclude_none=True,
                                                       exclude={'localId', 'localRevision'})
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def initialize_links(wb):
    with wb.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS cclip_links (
          wb_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, draft_id TEXT NOT NULL DEFAULT '',
          draft_revision INTEGER NOT NULL DEFAULT 0, wb_revision INTEGER NOT NULL,
          wb_fingerprint TEXT NOT NULL DEFAULT '', UNIQUE(project_id,draft_id))''')
        columns = {row['name'] for row in db.execute('PRAGMA table_info(cclip_links)')}
        if 'wb_fingerprint' not in columns:
            db.execute("ALTER TABLE cclip_links ADD COLUMN wb_fingerprint TEXT NOT NULL DEFAULT ''")
        if 'source_snapshot' not in columns:
            db.execute("ALTER TABLE cclip_links ADD COLUMN source_snapshot TEXT NOT NULL DEFAULT ''")
        # Backfill only a version known to be the original baseline. An already
        # diverged old record remains protected; migration must not guess its edits.
        rows = db.execute('''SELECT l.wb_id,p.document FROM cclip_links l
          JOIN projects p ON p.id=l.wb_id WHERE l.wb_fingerprint='' AND p.revision=l.wb_revision''').fetchall()
        for row in rows:
            try:
                fingerprint = project_fingerprint(json.loads(row['document']))
            except (TypeError, ValueError):
                continue
            db.execute('UPDATE cclip_links SET wb_fingerprint=? WHERE wb_id=?', (fingerprint, row['wb_id']))


def unchanged_timeline(record, link):
    return record['revision'] == link['wb_revision'] or bool(
        link.get('wb_fingerprint') and project_fingerprint(record['project']) == link['wb_fingerprint'])


class TimelineRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    draftId: str | None = Field(default=None, pattern=r'^[a-zA-Z0-9_-]{1,100}$')


class HandoffRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int = Field(ge=1)
    clipId: str | None = Field(default=None, pattern=r'^[a-zA-Z0-9_-]{1,100}$')


class PresetRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    draft: Draft
    strategyId: str = Field(min_length=1, max_length=40)


def copy_media(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def load_cues(source: Path | None, duration: float):
    if source is None or not source.is_file():
        return []
    import pysrt
    rows = pysrt.from_string(source.read_text(encoding='utf-8-sig'))
    return [{'id': uuid4().hex, 'start': max(0, row.start.ordinal / 1000),
             'end': min(duration, row.end.ordinal / 1000), 'text': row.text}
            for row in rows if row.start.ordinal / 1000 < duration and row.end.ordinal > row.start.ordinal]


def register(app):
    wb = app.state.store
    def analysis_settings():
        from backend.services import ai_model_settings as ai
        from backend.workbench.models import AnalysisSettings
        from backend.workbench.adapters import endpoint
        try:
            configured = ai.for_editing()
            if not configured.analysis:
                return None
            binding = configured.analysis
            connection = ai.connection_for(configured, binding)
            resolved = ai.chat_endpoint(connection, binding.model)
            endpoint(resolved['base_url'])
            if not resolved['api_key'] and urlsplit(resolved['base_url']).hostname not in {'127.0.0.1', 'localhost', '::1'}:
                return None
            return AnalysisSettings(baseUrl=resolved['base_url'], model=binding.model, apiKey=resolved['api_key'])
        except (OSError, ValueError, KeyError, StopIteration):
            return None
    app.state.analysis_settings_resolver = analysis_settings
    router = APIRouter(prefix='/api/cclip')
    initialize_links(wb)

    def link_for(project_id, draft_id):
        with wb.connect() as db:
            row = db.execute('SELECT * FROM cclip_links WHERE project_id=? AND draft_id=?', (project_id, draft_id or '')).fetchone()
            return dict(row) if row else None

    def bind(wb_id, project_id, draft_id, draft_revision, wb_revision, document):
        with wb.connect() as db:
            db.execute('''INSERT INTO cclip_links
              (wb_id,project_id,draft_id,draft_revision,wb_revision,wb_fingerprint) VALUES(?,?,?,?,?,?)
              ON CONFLICT(wb_id) DO UPDATE SET
              project_id=excluded.project_id,draft_id=excluded.draft_id,
              draft_revision=excluded.draft_revision,wb_revision=excluded.wb_revision,
              wb_fingerprint=excluded.wb_fingerprint''',
                       (wb_id, project_id, draft_id or '', draft_revision, wb_revision, project_fingerprint(document)))

    def idle(project_id):
        with wb.connect() as db:
            if db.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
                raise Conflict()

    def project_or_404(db, project_id):
        studio.directory(project_id)
        project = db.get(OriginalProject, project_id)
        if project is None:
            raise HTTPException(404, '项目不存在')
        return project

    @router.post('/platform-preset')
    def platform_preset(body: PresetRequest):
        # Reuse upstream defaults. This only edits output settings: no analysis,
        # translation, cropping downloads or network calls on choosing a preset.
        from backend.services.platform_strategy import platform_strategy
        from backend.services.studio.jobs import _apply_strategy
        try:
            strategy = platform_strategy(body.strategyId)
        except ValueError:
            raise HTTPException(422, '未知平台预设') from None
        value = _apply_strategy(body.draft.model_dump(), strategy.id)
        fields = ('aspect', 'layout', 'subtitle_style', 'title_style', 'title_template_version', 'title_motion')
        changes = {name: getattr(value, name) for name in fields}
        changes['platform_preset'] = strategy.id
        if body.draft.packaging and strategy.aspect == 'portrait':
            packaging = body.draft.packaging.model_dump()
            if packaging['template'] == 'interview_zh':
                packaging['style'] = 'boxed' if strategy.id == 'xiaohongshu' else 'classic'
                changes['packaging'] = packaging
        return {'changes': changes}

    @router.get('/activity')
    def activity(db: Session = Depends(get_db)):
        from backend.models.task import Task
        with wb.connect() as connection:
            count = connection.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        count += sum(getattr(status, 'value', status) in {'pending', 'queued', 'running', 'processing', 'retrying'}
                     for status, in db.query(Task.status).all())
        for project_id, in db.query(OriginalProject.id).all():
            try:
                data = studio.read(project_id, recover=False)
                count += sum(job.get('status') in {'queued', 'running'} for job in data.get('jobs', []))
                count += (data.get('analysis') or {}).get('status') == 'running'
            except (OSError, ValueError):
                count += 1
        return {'active': bool(count)}

    @router.post('/projects/{project_id}/timeline')
    def open_timeline(project_id: str, body: TimelineRequest, db: Session = Depends(get_db)):
        with lock:
            original = project_or_404(db, project_id)
            draft = next((item for item in studio.read(project_id)['drafts'] if item['id'] == body.draftId), None) if body.draftId else None
            if body.draftId and draft is None:
                raise HTTPException(404, '草稿不存在')
            link = link_for(project_id, body.draftId)
            if link:
                record = wb.get(link['wb_id'])
                changed = draft is not None and draft['revision'] != link['draft_revision']
                if draft is not None and not changed:
                    return record
                if draft is not None and not unchanged_timeline(record, link):
                    raise HTTPException(409, '时间轴和包装草稿都已修改，已有版本均保留，请另存版本后重试')
                if draft is not None:
                    idle(record['id'])
            try:
                source = find_source_video(project_id)
            except FileNotFoundError:
                raise HTTPException(409, '原视频尚未就绪，可查看处理状态后重试') from None
            if not source.resolve().is_relative_to(studio.directory(project_id).resolve()):
                raise HTTPException(422, '源文件不在项目目录')
            if link:
                asset = record['project']['source']
            else:
                info = media.probe(source)
                asset_id = str(uuid4())
                asset = {**info, 'assetId': asset_id, 'name': source.name, 'bytes': source.stat().st_size, 'kind': 'local'}
                copy_media(source, wb.root / 'assets' / asset_id / 'source.mp4')
                with source.open('rb') as stream:
                    checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
                wb.add_asset(asset_id, asset, checksum)
            cues = load_cues(find_source_srt(project_id), asset['duration'])
            if draft:
                overrides = draft.get('subtitle_cues')
                if overrides is None and draft.get('packaging'):
                    overrides = draft['packaging'].get('cues')
                if overrides is not None:
                    mapping = {(round(cue['start'], 3), round(cue['end'], 3)): cue['text'] for cue in overrides}
                    for cue in cues:
                        cue['text'] = mapping.get((round(cue['start'], 3), round(cue['end'], 3)), cue['text'])
                    existing = {(round(cue['start'], 3), round(cue['end'], 3)) for cue in cues}
                    cues.extend({'id': uuid4().hex, 'start': cue['start'], 'end': cue['end'], 'text': cue['text']}
                                for cue in overrides if (round(cue['start'], 3), round(cue['end'], 3)) not in existing)
                    cues.sort(key=lambda cue: cue['start'])
            clips = [{'id': str(row.id), 'name': row.title, 'start': float(row.start_time), 'end': float(row.end_time),
                      'origin': 'ai', 'color': index % 4}
                     for index, row in enumerate(db.query(OriginalClip).filter(OriginalClip.project_id == project_id).order_by(OriginalClip.start_time).all())]
            if not draft and not clips and link and (original.processing_config or {}).get('cclip_manual'):
                # A workbench-created master owns its picks. Edited/trimmed
                # platform scenes are outputs, not new upstream recommendations.
                clips = record['project'].get('highlights', [])
            elif not draft and not clips:
                config = original.processing_config or {}
                origins = config.get('cclip_clip_origins') or {}
                fallback_origin = 'manual' if config.get('cclip_manual') else 'ai'
                seen = set()
                for item in studio.read(project_id)['drafts']:
                    for scene in item['scenes']:
                        key = (round(scene['start'], 3), round(scene['end'], 3))
                        if key in seen:
                            continue
                        seen.add(key)
                        stable_id = scene['id'] if origins.get(scene['id'], fallback_origin) == 'manual' else 'source-' + hashlib.sha256(f'{key[0]:.3f}:{key[1]:.3f}'.encode()).hexdigest()[:24]
                        clips.append({'id': stable_id, 'name': scene['label'], 'start': scene['start'], 'end': scene['end'], 'origin': origins.get(scene['id'], fallback_origin), 'color': len(clips) % 4})
            snapshot = {'clips': [clip for clip in clips if clip['origin'] == 'ai'], 'cues': cues,
                        'known_source_ids': [clip['id'] for clip in clips]}
            if link and draft is None:
                from .source_sync import merge_source, draft_sources
                from .source_history import analysis_history, source_snapshot, repair_superseded
                previous = json.loads(link['source_snapshot']) if link.get('source_snapshot') else None
                history = analysis_history(wb, record['id'])
                snapshot = source_snapshot(record['project'], previous, snapshot['clips'], cues, history)
                repaired, retired = repair_superseded(record['project'], snapshot, history)
                merged = Project.model_validate(merge_source(repaired, previous, snapshot['clips'], cues)).document()
                if project_fingerprint(merged) != project_fingerprint(record['project']):
                    idle(record['id'])
                    record = wb.save(record['id'], merged, record['revision'])
                def synchronize_sources(data):
                    removed = set(data.get('cclip_retired_source_ids') or []) | set(retired)
                    removed.update(clip['id'] for clip in (previous or {}).get('clips', [])
                                   if clip['id'] not in {item['id'] for item in record['project']['clips']})
                    removed.update(set((previous or {}).get('known_source_ids', [])) - {item['id'] for item in record['project']['clips']})
                    data['cclip_retired_source_ids'] = sorted(removed)
                    draft_sources(data, record['project']['clips'], record['project'].get('highlights', []))
                studio.change(project_id, synchronize_sources)
                # Import into the explicit-save snapshot independently: user work
                # persisted for a task must remain discardable until explicitly saved.
                with wb.connect() as connection:
                    saved = connection.execute('SELECT document FROM cclip_saved_projects WHERE wb_id=? AND saved=1', (record['id'],)).fetchone()
                    if saved and saved['document']:
                        saved_document, _ = repair_superseded(json.loads(saved['document']), snapshot, history)
                        saved_document = merge_source(saved_document, previous, snapshot['clips'], cues)
                        connection.execute('UPDATE cclip_saved_projects SET document=? WHERE wb_id=?',
                                           (json.dumps(saved_document, ensure_ascii=False), record['id']))
                    snapshot['legacy_ai_repair_done'] = True
                    connection.execute('UPDATE cclip_links SET source_snapshot=? WHERE wb_id=?',
                                       (json.dumps(snapshot, ensure_ascii=False), record['id']))
                return record
            selected = [{'id': scene['id'], 'name': scene['label'], 'start': scene['start'], 'end': scene['end'],
                         'origin': 'manual', 'color': index % 4} for index, scene in enumerate(draft['scenes'])] if draft else clips
            document = Project.model_validate({'schemaVersion': 1, 'title': draft['title'] if draft else original.name,
                                               'source': {key: value for key, value in asset.items() if key in {'assetId','name','bytes','kind','duration','width','height'}},
                                               'clips': selected, 'cues': cues, 'highlights': [clip for clip in clips if clip['origin'] == 'ai'],
                                               'bookmarks': record['project'].get('bookmarks', []) if link else []}).document()
            result = wb.save(record['id'], document, record['revision']) if link else wb.create(document)
            bind(result['id'], project_id, body.draftId, draft['revision'] if draft else 0, result['revision'], result['project'])
            if draft is None:
                from .source_sync import draft_sources
                studio.change(project_id, lambda data: draft_sources(data, result['project']['clips']))
                with wb.connect() as connection:
                    connection.execute('UPDATE cclip_links SET source_snapshot=? WHERE wb_id=?',
                                       (json.dumps(snapshot, ensure_ascii=False), result['id']))
            app.state.mark_workbench_saved(result['id'])
            return result

    @router.post('/projects/{project_id}/drafts/{draft_id}/export')
    def export_edit(project_id: str, draft_id: str, body: HandoffRequest, db: Session = Depends(get_db)):
        from backend.api.v1.studio import call, validate_draft
        from backend.services.studio import jobs
        with studio.lock:
            project_or_404(db, project_id)
            state = studio.read(project_id)
            raw = next((item for item in state['drafts'] if item['id'] == draft_id), None)
            if raw is None:
                raise HTTPException(404, '草稿不存在')
            if raw['revision'] != body.revision:
                raise Conflict()
            draft = Draft.model_validate(raw)
            call(validate_draft, project_id, draft)
            chosen_template = draft.packaging.template if draft.packaging else None
            options = {}
            if chosen_template in {'editorial', 'street'}:
                from backend.services.studio.overlay_fill import SAFE_AREAS
                options.update(html_template=chosen_template,
                               safe_area=draft.platform_preset if draft.platform_preset in SAFE_AREAS else 'xiaohongshu')
            variant = next((item for item in state.get('output_variants', []) if item['draft_id'] == draft_id), None)
            if chosen_template in {'editorial', 'street'} or variant and variant.get('html_template'):
                from backend.services.studio.overlay_fill import SAFE_AREAS
                strategy = draft.platform_preset or (variant or {}).get('strategy_id')
                options['safe_area'] = strategy if strategy in SAFE_AREAS else 'xiaohongshu'
            if draft.template_override is None and variant:
                if variant.get('html_template'):
                    options.update(html_template=variant['html_template'])
                elif variant.get('html_fallback'):
                    options.update(html_fallback=variant['html_fallback'])
                    if variant.get('requested_template') in {'editorial', 'street'}:
                        options['requested_template'] = variant['requested_template']
            elif draft.template_override in {'editorial', 'street'}:
                options.update(html_template=draft.template_override)
            elif draft.template_override == 'classic':
                options = {}
            if variant is None:
                return call(jobs.export, project_id, draft, **options)
            active = next((item for item in state['jobs'] if item['draft_id'] == draft_id and item['status'] in {'queued', 'running'}), None)
            if active:
                if active['revision'] != draft.revision:
                    raise Conflict()
                if variant.get('render_job_id') == active['job_id'] and variant['draft_revision'] == draft.revision:
                    return {key: value for key, value in active.items() if key not in {'snapshot', 'instance', 'variant_links'}}
            # Reuse the original renderer and template policy, with a new fenced
            # attempt. Previous immutable jobs/files and edited post copy survive.
            def reserve(data):
                target = next(item for item in data['output_variants'] if item['id'] == variant['id'])
                target.update(draft_revision=draft.revision, status='queued', render_attempt_id=uuid4().hex)
                if draft.platform_preset:
                    target['strategy_id'] = draft.platform_preset
                for key in ('render_job_id', 'render_dispatch_claimed', 'render_dispatch_instance', 'error', 'error_code', 'cover', 'cover_job'):
                    target.pop(key, None)
                if data.get('generation'):
                    data['generation']['status'] = 'rendering'
                return studio.claim_render(data, studio.variant_identity(target))
            expected = studio.change(project_id, reserve)
            try:
                job = call(jobs.export, project_id, draft, brand_outro=bool(variant.get('branding', {}).get('outro_enabled', True)), _variant_identity=expected, **options)
            except Exception:
                def failed(data):
                    target = next(item for item in data['output_variants'] if item['id'] == variant['id'])
                    if studio.variant_identity(target) == expected:
                        target.update(status='failed', error='导出任务未能启动，请重试；已有成片已保留')
                        target.pop('render_dispatch_claimed', None)
                        target.pop('render_dispatch_instance', None)
                studio.change(project_id, failed)
                raise
            studio.remember_render_link(project_id, expected, job['job_id'])
            studio.change(project_id, lambda data: studio.bind_render(data, expected, job['job_id']))
            return job

    @router.post('/workbench/{workbench_id}/platform-draft')
    def platform_draft(workbench_id: UUID, body: HandoffRequest, db: Session = Depends(get_db)):
        with lock:
            record = wb.get(workbench_id)
            if record['revision'] != body.revision:
                raise Conflict()
            idle(record['id'])
            document = Project.model_validate(record['project'])
            chosen = [clip for clip in document.clips if clip.id == body.clipId] if body.clipId else document.clips
            if body.clipId and not chosen:
                raise HTTPException(404, '片段不存在')
            if not chosen or len(chosen) > 30:
                raise HTTPException(422, '包装草稿需要 1–30 个片段；全部剪辑仍可在时间轴直接导出')
            with wb.connect() as connection:
                row = connection.execute('SELECT * FROM cclip_links WHERE wb_id=?', (str(workbench_id),)).fetchone()
                link = dict(row) if row else None
            source_template = None
            if link:
                project = project_or_404(db, link['project_id'])
                parent = next((item for item in studio.read(project.id)['drafts'] if item['id'] == link['draft_id']), None)
                if body.clipId:
                    from .source_sync import draft_sources
                    studio.change(project.id, lambda data: draft_sources(data, record['project']['clips'], record['project'].get('highlights', [])))
                    state = studio.read(project.id)
                    mapping = state.get('cclip_source_clips') or {}
                    versions = [item for item in state['drafts'] if mapping.get(item['id']) == body.clipId]
                    baselines = state.get('cclip_source_ranges') or {}
                    parent = next((item for item in versions if abs(baselines.get(item['id'], {}).get('start', -1) - chosen[0].start) < .001
                                   and abs(baselines.get(item['id'], {}).get('end', -1) - chosen[0].end) < .001), None)
                    parent = parent or next((item for item in state['drafts'] if len(item['scenes']) == 1
                                   and item['scenes'][0]['id'] == chosen[0].id
                                   and abs(item['scenes'][0]['start'] - chosen[0].start) < .001
                                   and abs(item['scenes'][0]['end'] - chosen[0].end) < .001), None)
                    if parent:
                        return {'projectId': project.id, 'draftId': parent['id'], 'revision': parent['revision']}
                    # A changed master range gets a new matching version. Keep
                    # earlier platform edits and immutable exports untouched.
                    source_template = versions[0] if versions else None
                if parent is not None and parent['revision'] != link['draft_revision']:
                    if unchanged_timeline(record, link):
                        # Reopen the newer packaging without overwriting it. Keep
                        # the old binding until the reverse handoff imports it.
                        return {'projectId': project.id, 'draftId': parent['id'], 'revision': parent['revision']}
                    raise HTTPException(409, '包装草稿已被修改，已保留两个版本，请重新打开后再保存')
            else:
                project = OriginalProject(name=document.title or document.source.name, status=ProjectStatus.COMPLETED,
                                           processing_config={'cclip_manual': True})
                db.add(project); db.flush()
                raw = studio.directory(project.id) / 'raw'
                source = raw / 'input.mp4'
                copy_media(wb.asset_path(document.source.assetId), source)
                media.write_srt(raw / 'input.srt', [cue.model_dump() for cue in document.cues])
                project.video_path = str(source)
                project.subtitle_path = str(raw / 'input.srt')
                project.video_duration = round(document.source.duration)
                db.commit()
                parent = None
            project.processing_config = {**(project.processing_config or {}),
                                         'cclip_clip_origins': {clip.id: clip.origin or 'manual' for clip in document.clips}}
            db.commit()
            scenes = [Scene(id=clip.id, label=clip.name[:120] or '片段', start=clip.start, end=clip.end) for clip in chosen]
            basis = parent or source_template
            if basis:
                by_id = {scene['id']: scene for scene in basis['scenes']}
                scenes = [Scene.model_validate({**by_id.get(scene.id, {}), **scene.model_dump(exclude_unset=True)}) for scene in scenes]
                scenes = [scene.model_copy(update={'crop_track': None, 'framing_adjusted': True})
                          if scene.crop_track and (by_id[scene.id]['start'] != scene.start or by_id[scene.id]['end'] != scene.end)
                          else scene for scene in scenes]
            values = {**(basis or {}), 'id': parent['id'] if parent else uuid4().hex, 'title': chosen[0].name if body.clipId else document.title or document.source.name,
                      'scenes': scenes, 'origin': 'cclip-timeline',
                      'subtitle_cues': [PackagingCue(start=cue.start, end=cue.end, text=cue.text or ' ', original=cue.text or ' ') for cue in document.cues
                                        if not body.clipId or any(cue.start < clip.end and cue.end > clip.start for clip in chosen)]}
            if source_template:
                values.update(revision=1, parent_draft_id=source_template['id'], parent_revision=source_template['revision'])
                if values.get('packaging'):
                    values['packaging'] = {**values['packaging'], 'cues': values['subtitle_cues']}
            result = studio.save_draft(project.id, Draft.model_validate(values), create=parent is None)
            if body.clipId:
                def remember_source(data):
                    data.setdefault('cclip_source_clips', {})[result['id']] = body.clipId
                    data.setdefault('cclip_source_ranges', {})[result['id']] = {'start': chosen[0].start, 'end': chosen[0].end}
                    data['cclip_output_exclusions'] = [item for item in data.get('cclip_output_exclusions', []) if item != body.clipId]
                studio.change(project.id, remember_source)
            if not body.clipId:
                bind(record['id'], project.id, result['id'], result['revision'], record['revision'], record['project'])
            elif not link:
                bind(record['id'], project.id, '', 0, record['revision'], record['project'])
            app.state.mark_workbench_saved(record['id'])
            return {'projectId': project.id, 'draftId': result['id'], 'revision': result['revision']}

    @router.post('/workbench/{workbench_id}/platform-drafts')
    def platform_drafts(workbench_id: UUID, body: HandoffRequest, db: Session = Depends(get_db)):
        """Idempotently prepare one editable output per current source clip, locally."""
        with lock:
            record = wb.get(workbench_id)
            if record['revision'] != body.revision:
                raise Conflict()
            idle(record['id'])
            clips = record['project']['clips']
            if not clips or len(clips) > 30:
                raise HTTPException(422, '包装草稿需要 1–30 个片段；全部剪辑仍可在时间轴直接导出')
            if body.clipId and body.clipId not in {item['id'] for item in clips}:
                raise HTTPException(404, '片段不存在')
            with wb.connect() as connection:
                link = connection.execute('SELECT project_id,draft_id FROM cclip_links WHERE wb_id=?', (str(workbench_id),)).fetchone()
            if link and not link['draft_id']:
                # Local analysis does not change the legacy Studio signal. Sync
                # ownership before matching platform drafts, even on an immediate
                # edit click, so a superseded shorter draft cannot hijack the pick.
                synced = open_timeline(link['project_id'], TimelineRequest(), db)
                if synced['revision'] != body.revision:
                    raise Conflict()
            excluded = set(studio.read(link['project_id']).get('cclip_output_exclusions') or []) if link else set()
            clips = [item for item in clips if item['id'] not in excluded or item['id'] == body.clipId]
            if not clips:
                return {'projectId': link['project_id'], 'draftId': None, 'drafts': []}
            results = [platform_draft(workbench_id, HandoffRequest(revision=body.revision, clipId=item['id']), db) for item in clips]
            selected = next((result for item, result in zip(clips, results) if item['id'] == body.clipId), results[0])
            return {**selected, 'drafts': [dict(sourceId=item['id'], **result) for item, result in zip(clips, results)]}

    app.include_router(router)
