"""Three-way import of late analysis results into an editable source project."""
from copy import deepcopy


def cue_key(cue):
    return (round(cue['start'], 3), round(cue['end'], 3))


def draft_sources(data, clips, recommendations=()):
    """Keep a logical clip identity when a platform version is trimmed or split."""
    mapping = dict(data.get('cclip_source_clips') or {})
    current_ids = {clip['id'] for clip in clips}
    by_source = {clip['id']: clip for clip in clips}
    original_ranges = {clip['id']: clip for clip in recommendations}
    ranges = dict(data.get('cclip_source_ranges') or {})
    retired = set(data.get('cclip_retired_source_ids') or [])
    def remember_range(draft, source_id):
        if draft['id'] not in ranges and source_id in by_source:
            source = original_ranges.get(source_id, by_source[source_id])
            ranges[draft['id']] = dict(ranges.get(draft.get('parent_draft_id')) or {'start': source['start'], 'end': source['end']})
    for draft in data['drafts']:
        linked = mapping.get(draft['id'])
        if linked in current_ids or linked in retired:
            remember_range(draft, linked)
            continue
        if draft.get('parent_draft_id') in mapping:
            mapping[draft['id']] = mapping[draft['parent_draft_id']]
            remember_range(draft, mapping[draft['id']])
            continue
        scenes = draft['scenes']
        matches = [clip for clip in clips if all(scene['start'] >= clip['start'] - .001
                   and scene['end'] <= clip['end'] + .001 for scene in scenes)]
        exact = next((clip for clip in matches if any(scene['id'] == clip['id'] for scene in scenes)), None)
        exact = exact or next((clip for clip in matches if abs(min(s['start'] for s in scenes) - clip['start']) < .001
                              and abs(max(s['end'] for s in scenes) - clip['end']) < .001), None)
        # Older automatic drafts can include a small lead/tail outside the raw
        # recommendation. Repair that legacy link only when it is unambiguous.
        if not matches:
            start, end = min(s['start'] for s in scenes), max(s['end'] for s in scenes)
            matches = [clip for clip in clips if abs(start - clip['start']) <= 2
                       and abs(end - clip['end']) <= 2
                       and min(end, clip['end']) - max(start, clip['start']) >= .95 * max(end - start, clip['end'] - clip['start'])]
        if exact or len(matches) == 1:
            mapping[draft['id']] = (exact or matches[0])['id']
            remember_range(draft, mapping[draft['id']])
    if mapping != data.get('cclip_source_clips', {}):
        data['cclip_source_clips'] = mapping
    if ranges:
        data['cclip_source_ranges'] = ranges


def merge_source(document, previous, clips, cues):
    result = deepcopy(document)
    incoming = [clip for clip in clips if clip['origin'] == 'ai']
    legacy = previous is None
    previous = previous or {'clips': document.get('highlights', []), 'cues': []}
    old_clips = {clip['id']: clip for clip in previous['clips']}
    fresh = {clip['id']: clip for clip in incoming}
    kept = []
    for clip in result['clips']:
        baseline = old_clips.get(clip['id'])
        if baseline and clip == baseline:
            if clip['id'] in fresh:
                kept.append(deepcopy(fresh[clip['id']]))
        else:
            kept.append(clip)
    ids = {clip['id'] for clip in kept}
    ranges = {cue_key(clip) for clip in kept if clip.get('origin') == 'ai'}
    added = [deepcopy(clip) for clip in incoming if clip['id'] not in ids
             and clip['id'] not in old_clips and cue_key(clip) not in ranges]
    # A master opened during transcription can already contain a manual cut.
    result['clips'] = added + kept if not old_clips else kept + added
    result['highlights'] = deepcopy(incoming)

    old_cues = {cue_key(cue): cue for cue in previous['cues']}
    if legacy and (result['cues'] or document.get('highlights')):
        # Existing text edits/deletions cannot be inferred from old revision-only links.
        old_cues = {cue_key(cue): cue for cue in cues}
    current_cues = {cue_key(cue): cue for cue in result['cues']}
    fresh_cues = {cue_key(cue): cue for cue in cues}
    merged = []
    for key, cue in current_cues.items():
        baseline = old_cues.get(key)
        if baseline and cue['text'] == baseline['text']:
            if key in fresh_cues:
                merged.append({**cue, 'text': fresh_cues[key]['text']})
        else:
            merged.append(cue)
    merged.extend(deepcopy(cue) for key, cue in fresh_cues.items()
                  if key not in current_cues and key not in old_cues)
    result['cues'] = sorted(merged, key=lambda cue: (cue['start'], cue['end']))
    return result
