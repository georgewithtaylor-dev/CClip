"""Choose the accepted analysis owner without resurrecting an older pipeline result."""
from copy import deepcopy
import json


def signature(clips):
    return sorted((item['id'], item['name'], round(item['start'], 3), round(item['end'], 3)) for item in clips)


def analysis_history(wb, project_id):
    with wb.connect() as db:
        rows = db.execute("SELECT id,result FROM jobs WHERE project_id=? AND kind='analyze' AND status='completed' ORDER BY created DESC,rowid DESC", (project_id,)).fetchall()
    history = []
    for row in rows:
        result = json.loads(row['result'] or '{}')
        document = (result.get('record') or {}).get('project') or result.get('candidate')
        if document is not None:
            history.append({'id': row['id'], 'clips': document.get('highlights', []), 'applied': bool(result.get('record'))})
    return history


def source_snapshot(document, previous, upstream, cues, history):
    previous = previous or {}
    known = {item['id'] for item in [*document['clips'], *document.get('highlights', [])]}
    accepted = next((job for job in history if job['id'] == previous.get('local_analysis_job') or
                     (job['clips'] and all(clip['id'] in known for clip in job['clips'])) or
                     (job['applied'] and not job['clips'] and not document.get('highlights'))), None)
    newer = accepted is not None and accepted['id'] != previous.get('local_analysis_job')
    same_upstream = signature(upstream) == signature(previous.get('upstream_clips', upstream))
    local = newer or (previous.get('clip_source') == 'workbench' and same_upstream)
    clips = accepted['clips'] if newer else previous.get('clips', []) if local else upstream
    return {'clips': deepcopy(clips), 'cues': cues, 'clip_source': 'workbench' if local else 'upstream',
            'upstream_clips': deepcopy(upstream),
            'known_source_ids': [clip['id'] for clip in document['clips']],
            'legacy_ai_repair_done': bool(previous.get('legacy_ai_repair_done')),
            'local_analysis_job': accepted['id'] if accepted else previous.get('local_analysis_job', '')}


def repair_superseded(document, snapshot, history):
    """Only retire exact historical recommendations mislabelled manual by the old sync bug.

    The original recommendation ID and every editable field must match. Independently
    created cuts, renamed/trimmed recommendations and all platform versions survive.
    """
    result = deepcopy(document)
    if snapshot['clip_source'] != 'workbench' or snapshot.get('legacy_ai_repair_done'):
        return result, []
    current = {item['id'] for item in snapshot['clips']}
    old = {item['id']: item for job in reversed(history) if job['applied'] for item in job['clips'] if item['id'] not in current}
    retired = [item['id'] for item in result['clips'] if item.get('origin') == 'manual' and item['id'] in old
               and {**item, 'origin': 'ai'} == old[item['id']]]
    result['clips'] = [item for item in result['clips'] if item['id'] not in retired]
    return result, retired
