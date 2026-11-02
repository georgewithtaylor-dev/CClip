"""Reuse upstream clip finding and subtitle parsing without booting its app."""
from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import pysrt

from .media import timestamp


def read_srt(path: Path, duration):
    cues = []
    for cue in pysrt.open(str(path), encoding='utf-8-sig'):
        start, end = cue.start.ordinal / 1000, min(duration, cue.end.ordinal / 1000)
        if 0 <= start < end and cue.text.strip():
            cues.append({'id': str(uuid4()), 'start': start, 'end': end, 'text': cue.text.strip()})
    if not cues:
        raise ValueError('empty_transcript')
    return cues


def endpoint(base_url):
    parsed = urlsplit(base_url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise ValueError('invalid_endpoint')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'}):
        raise ValueError('https_required')
    return base_url.rstrip('/') + '/chat/completions'


def refresh_ai_sequence(project, recommendations):
    """Refresh untouched recommendations while preserving explicitly edited selections."""
    previous = {clip['id']: clip for clip in project.get('highlights', [])}
    retained = []
    for clip in project['clips']:
        if clip.get('origin') == 'ai':
            if previous.get(clip['id']) == clip:
                continue
            clip = {**clip, 'origin': 'manual'}
        retained.append(clip)
    return [*retained, *recommendations]


def find_clips(project, settings, cancelled):
    from backend.pipeline.clip_finder import find_clips as upstream_find_clips, CLOUD_WINDOW, LOCAL_WINDOW
    from backend.pipeline.quality import to_seconds
    rows = [{'start_time': timestamp(cue['start']).replace(',', '.'), 'end_time': timestamp(cue['end']).replace(',', '.'), 'text': cue['text']} for cue in project['cues']]
    target = endpoint(settings.baseUrl)
    calls = 0
    def call(prompt, payload):
        nonlocal calls
        if cancelled.is_set():
            from .media import Cancelled
            raise Cancelled()
        calls += 1
        if calls > 2:
            raise ValueError('analysis_request_limit')
        with httpx.Client(timeout=httpx.Timeout(90, connect=15), trust_env=False, follow_redirects=False) as client:
            response = client.post(target, headers={'Authorization': 'Bearer ' + settings.apiKey}, json={
                'model': settings.model,
                'messages': [{'role': 'user', 'content': prompt + '\n' + json.dumps(payload, ensure_ascii=False)}],
                'temperature': .2,
                'max_tokens': 4096,
                **({'thinking': {'type': 'disabled'}} if urlsplit(target).hostname == 'api.deepseek.com' else {}),
            })
            if response.status_code != 200:
                raise ValueError('analysis_request_failed')
            raw = response.json()['choices'][0]['message']['content'].strip()
            if raw.startswith('```'):
                raw = raw.split('\n', 1)[1].rsplit('```', 1)[0]
            return json.loads(raw)
    local = urlsplit(settings.baseUrl).hostname in {'127.0.0.1', 'localhost', '::1'}
    result = upstream_find_clips(rows, call, threshold=.7, window=LOCAL_WINDOW if local else CLOUD_WINDOW)
    return [{'id': str(uuid4()), 'name': item['generated_title'], 'start': to_seconds(item['start_time']),
             'end': to_seconds(item['end_time']), 'color': index % 4, 'origin': 'ai'} for index, item in enumerate(result)]


def speech_cleanup(cues):
    suggestions, previous = [], None
    for cue in sorted(cues, key=lambda item: (item['start'], item['end'])):
        text = re.sub(r'[\W_]+', '', cue['text']).casefold()
        kind = None
        if text in {'嗯', '呃', '额', '嗯嗯', '呃呃'}:
            kind = 'filler'
        elif previous and text and text == previous[0] and cue['start'] - previous[1] <= 5:
            kind = 'repeat'
        if kind:
            suggestions.append({'id': str(uuid4()), 'start': cue['start'], 'end': cue['end'], 'kind': kind, 'text': cue['text']})
        previous = (text, cue['end'])
    return suggestions
