"""Browser draft contract, validated again at the local service boundary."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Source(StrictModel):
    name: str = Field(max_length=255)
    duration: float = Field(gt=0, le=86400)
    kind: Literal['demo', 'local']
    bytes: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=1, le=32768)
    height: int | None = Field(default=None, ge=1, le=32768)
    assetId: UUID | None = None


class Clip(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(max_length=200)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    color: int = Field(ge=0, le=3, strict=True)
    origin: Literal['ai', 'manual'] | None = None


class Cue(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(max_length=10000)


class Bookmark(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    time: float = Field(ge=0)
    label: str = Field(max_length=200)


class Project(StrictModel):
    schemaVersion: Literal[1] = 1
    title: str = Field(max_length=200)
    source: Source
    clips: list[Clip] = Field(max_length=10000)
    cues: list[Cue] = Field(max_length=50000)
    highlights: list[Clip] = Field(default_factory=list, max_length=10000)
    bookmarks: list[Bookmark] = Field(default_factory=list, max_length=10000)
    demoTranscriptVersion: Literal[2] | None = None
    localId: UUID | None = None
    localRevision: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def boundaries(self):
        for group in (self.clips, self.cues, self.highlights, self.bookmarks):
            if len({item.id for item in group}) != len(group):
                raise ValueError('duplicate ids')
        for item in [*self.clips, *self.highlights, *self.cues]:
            minimum = .12 - .00001 if isinstance(item, Clip) else .000001
            if item.end - item.start < minimum or item.end > self.source.duration + .001:
                raise ValueError('invalid source range')
        if any(item.time > self.source.duration for item in self.bookmarks):
            raise ValueError('bookmark outside source')
        if any(item.origin == 'manual' for item in self.highlights):
            raise ValueError('invalid AI recommendation')
        return self

    def document(self):
        return self.model_dump(mode='json', exclude_none=True)


class SaveRequest(StrictModel):
    project: Project
    revision: int = Field(ge=1)


class JobRequest(StrictModel):
    kind: Literal['export', 'transcribe', 'analyze', 'cleanup']
    revision: int = Field(ge=1)
    burnSubtitles: bool = True
    consentId: str | None = None
    clipId: str | None = Field(default=None, max_length=100)


class AnalysisSettings(StrictModel):
    baseUrl: str = Field(min_length=8, max_length=2048)
    model: str = Field(min_length=1, max_length=200)
    apiKey: str = Field(max_length=4096, repr=False)


class ConsentRequest(StrictModel):
    revision: int = Field(ge=1)
    approved: bool
