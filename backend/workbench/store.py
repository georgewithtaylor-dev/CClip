"""SQLite authority, compare-and-swap drafts and durable task states."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from uuid import uuid4


class Conflict(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        for folder in ('assets', 'exports', 'jobs', 'transcripts'):
            (self.root / folder).mkdir(exist_ok=True)
        self.database = self.root / 'workbench.sqlite3'
        with self.connect() as db:
            if db.execute('PRAGMA user_version').fetchone()[0] > 1:
                raise RuntimeError('unsupported_database_version')
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, info TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
                  progress REAL NOT NULL DEFAULT 0, result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
            db.execute("UPDATE jobs SET status='failed', error='interrupted', updated=? WHERE status IN ('queued','running')", (now(),))

    @contextmanager
    def connect(self):
        with sqlite3.connect(self.database, timeout=10) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA busy_timeout=10000')
            yield db

    def add_asset(self, asset_id, info, digest):
        with self.connect() as db:
            db.execute('INSERT INTO assets VALUES(?,?,?)', (asset_id, json.dumps(info, ensure_ascii=False), digest))

    def asset(self, asset_id):
        with self.connect() as db:
            row = db.execute('SELECT info FROM assets WHERE id=?', (str(asset_id),)).fetchone()
        if not row:
            raise KeyError('asset')
        return json.loads(row['info'])

    def asset_path(self, asset_id):
        self.asset(asset_id)
        return self.root / 'assets' / str(asset_id) / 'source.mp4'

    def create(self, document):
        project_id = str(uuid4())
        document = {**document, 'localId': project_id, 'localRevision': 1}
        with self.connect() as db:
            db.execute('INSERT INTO projects VALUES(?,?,1,?)', (project_id, json.dumps(document, ensure_ascii=False), now()))
        return self.get(project_id)

    def get(self, project_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM projects WHERE id=?', (str(project_id),)).fetchone()
        if not row:
            raise KeyError('project')
        return {'id': row['id'], 'project': json.loads(row['document']), 'revision': row['revision'], 'updated': row['updated']}

    def save(self, project_id, document, revision):
        document = {**document, 'localId': str(project_id), 'localRevision': revision + 1}
        with self.connect() as db:
            cursor = db.execute('UPDATE projects SET document=?, revision=revision+1, updated=? WHERE id=? AND revision=?',
                                (json.dumps(document, ensure_ascii=False), now(), str(project_id), revision))
            if not cursor.rowcount:
                raise Conflict()
        return self.get(project_id)

    def projects(self):
        with self.connect() as db:
            rows = db.execute('SELECT id, document, revision, updated FROM projects ORDER BY updated DESC').fetchall()
        return [{'id': row['id'], 'title': json.loads(row['document'])['title'], 'revision': row['revision'], 'updated': row['updated']} for row in rows]

    def add_job(self, project_id, kind):
        job_id = str(uuid4())
        with self.connect() as db:
            db.execute('INSERT INTO jobs(id,project_id,kind,status,created,updated) VALUES(?,?,?,?,?,?)',
                       (job_id, str(project_id), kind, 'queued', now(), now()))
        return self.job(job_id)

    def update_job(self, job_id, *, status=None, progress=None, result=None, error=None):
        fields = {'updated': now()}
        fields.update({key: value for key, value in {'status': status, 'progress': progress, 'error': error}.items() if value is not None})
        if result is not None:
            fields['result'] = json.dumps(result, ensure_ascii=False)
        with self.connect() as db:
            db.execute('UPDATE jobs SET ' + ','.join(f'{key}=?' for key in fields) + ' WHERE id=?', (*fields.values(), str(job_id)))

    def job(self, job_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (str(job_id),)).fetchone()
        if not row:
            raise KeyError('job')
        return {**dict(row), 'result': json.loads(row['result']) if row['result'] else None}
