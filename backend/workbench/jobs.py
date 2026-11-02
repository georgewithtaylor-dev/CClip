"""Bounded local jobs with cancellation and revision-safe results."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from uuid import uuid4

from . import adapters, media
from .models import Project
from .store import Conflict
from backend.core import cclip_storage


def digest(project):
    return hashlib.sha256(json.dumps(project['cues'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class Jobs:
    def __init__(self, store):
        self.store = store
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='workbench')
        self.lock = threading.Lock()
        self.events = {}

    def start(self, record, request, settings=None):
        with self.lock:
            # A terminal result may reach the UI while the old worker removes
            # its scratch directory. The single-worker executor still orders
            # the next stage; only queued/running work blocks a new request.
            for identifier in list(self.events):
                if self.store.job(identifier)['status'] not in ('queued', 'running'):
                    self.events.pop(identifier, None)
            if self.events:
                raise Conflict()
            job = self.store.add_job(record['id'], request.kind)
            event = threading.Event()
            self.events[job['id']] = event
        self.pool.submit(self._run, job, record, request, event, settings)
        return job

    def cancel(self, job_id):
        with self.lock:
            event = self.events.get(str(job_id))
            if event:
                event.set()

    def close(self):
        with self.lock:
            for event in self.events.values():
                event.set()
        self.pool.shutdown(wait=True, cancel_futures=True)

    def _run(self, job, record, request, event, settings):
        job_id = job['id']
        folder = None
        scratch = ExitStack()
        try:
            from backend.core.cclip_cache import workspace
            folder = scratch.enter_context(workspace(self.store.root / 'jobs', job_id))
            self.store.update_job(job_id, status='running')
            progress = lambda value: self.store.update_job(job_id, progress=round(value * 100, 1))
            project = record['project']
            source = self.store.asset_path(project['source']['assetId'])
            if request.kind == 'export':
                target = cclip_storage.output('workbench', record['id'], job_id,
                                              self.store.root / 'exports' / f'{job_id}.mp4', create=True)
                export_project = {**project, 'clips': [clip for clip in project['clips'] if clip['id'] == request.clipId]} if request.clipId else project
                result = media.render(source, export_project, folder, target, event, progress, request.burnSubtitles)
                result.update(download=f'/api/workbench/jobs/{job_id}/download', subtitles=f'/api/workbench/jobs/{job_id}/subtitles')
            elif request.kind == 'transcribe':
                output = folder / 'original.srt'
                self._transcribe(source, output, folder, event, progress)
                cues = adapters.read_srt(output, project['source']['duration'])
                # Original ASR text is retained separately from later user corrections.
                original = self.store.root / 'transcripts' / project['source']['assetId']
                original.mkdir(exist_ok=True)
                (original / f'{job_id}.srt').write_bytes(output.read_bytes())
                candidate = Project.model_validate({**project, 'cues': cues}).document()
                if event.is_set():
                    raise media.Cancelled()
                result = self._apply(record, candidate)
            elif request.kind == 'analyze':
                clips = adapters.find_clips(project, settings, event)
                candidate = Project.model_validate({**project, 'highlights': clips, 'clips': adapters.refresh_ai_sequence(project, clips)}).document()
                if event.is_set():
                    raise media.Cancelled()
                result = self._apply(record, candidate)
            else:
                silence = media.silence_ranges(source, folder, event)
                suggestions = [{**item, 'id': str(uuid4())} for item in silence] + adapters.speech_cleanup(project['cues'])
                result = {'suggestions': sorted(suggestions, key=lambda item: item['start']), 'revision': record['revision']}
            if event.is_set():
                raise media.Cancelled()
            self.store.update_job(job_id, status='completed', progress=100, result=result)
        except media.Cancelled:
            self.store.update_job(job_id, status='cancelled', error='cancelled')
        except media.MediaError as error:
            self.store.update_job(job_id, status='failed', error=str(error))
        except Exception:
            self.store.update_job(job_id, status='cancelled' if event.is_set() else 'failed', error='cancelled' if event.is_set() else 'task_failed')
        finally:
            scratch.close()
            with self.lock:
                self.events.pop(job_id, None)

    def _apply(self, record, candidate):
        try:
            return {'record': self.store.save(record['id'], candidate, record['revision'])}
        except Conflict:
            return {'candidate': candidate, 'conflict': True}

    def _transcribe(self, source, output, folder, event, progress):
        request = {'source': str(source), 'output': str(output), 'progress': str(folder / 'progress.json'), 'result': str(folder / 'result.json')}
        config = folder / 'request.json'
        config.write_text(json.dumps(request), encoding='utf-8')
        # Do not inherit credentials, proxies or telemetry configuration into offline workers.
        allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LANGUAGE', 'LC_ALL'}
        environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        environment.update(AUTOCLIP_DATA_DIR=str(self.store.root), AUTOCLIP_LLM_CONCURRENCY='1', PYTHONUTF8='1',
                           HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
        for key in ('AUTOCLIP_FFMPEG_PATH', 'AUTOCLIP_FFPROBE_PATH'):
            if os.environ.get(key):
                environment[key] = os.environ[key]
        with (folder / 'worker.log').open('wb') as log:
            process = subprocess.Popen([sys.executable, '-m', 'backend.workbench.worker', str(config)],
                                       cwd=Path(__file__).resolve().parents[2], env=environment, stdout=log, stderr=log,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            while process.poll() is None:
                if event.wait(.3):
                    import psutil
                    try:
                        descendants = psutil.Process(process.pid).children(recursive=True)
                        for child in descendants:
                            child.kill()
                    except psutil.NoSuchProcess:
                        pass
                    process.kill()
                    process.wait()
                    raise media.Cancelled()
                try:
                    progress(json.loads((folder / 'progress.json').read_text())['progress'])
                except (OSError, ValueError, KeyError):
                    pass
            if process.returncode or not output.is_file():
                raise media.MediaError('transcription_failed')
