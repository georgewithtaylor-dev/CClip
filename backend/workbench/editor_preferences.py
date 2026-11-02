"""Only editor controls, never model credentials, persist in this small file."""
import json
from pathlib import Path
import threading

from pydantic import Field, model_validator
from .models import StrictModel


class EditorPreferences(StrictModel):
    snapping: bool = True
    split: str = Field(default='s', pattern=r'^[a-z]$')
    markIn: str = Field(default='i', pattern=r'^[a-z]$')
    markOut: str = Field(default='o', pattern=r'^[a-z]$')
    bookmark: str = Field(default='m', pattern=r'^[a-z]$')
    snap: str = Field(default='n', pattern=r'^[a-z]$')

    @model_validator(mode='after')
    def unique_keys(self):
        keys = [self.split, self.markIn, self.markOut, self.bookmark, self.snap]
        if len(set(keys)) != len(keys):
            raise ValueError('duplicate shortcuts')
        return self


_lock = threading.Lock()


def load(root: Path):
    try:
        path = root / 'editor-preferences.json'
        if path.stat().st_size > 2048:
            return EditorPreferences()
        return EditorPreferences.model_validate_json(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return EditorPreferences()


def save(root: Path, value: EditorPreferences):
    target = root / 'editor-preferences.json'
    with _lock:
        pending = target.with_suffix('.pending')
        try:
            pending.write_text(json.dumps(value.model_dump()), encoding='utf-8')
            pending.replace(target)
        finally:
            pending.unlink(missing_ok=True)
    return value
