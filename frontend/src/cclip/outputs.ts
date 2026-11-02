import type { Draft, Workspace } from '../features/studio/types'
import { draftExportState } from '../features/studio/draftExportState'

import { clipColor, type Clip, type Project, type TimelineOutput } from '../features/workbench/model'

export function outputGroups(workspace: Workspace, project?: Project) {
  const grouped = new Map<string, { drafts: Draft[]; sourceId?: string; source?: Clip }>()
  const links = workspace.cclip_source_clips || {}
  const retired = new Set(workspace.cclip_retired_source_ids || [])
  const excluded = new Set(workspace.cclip_output_exclusions || [])
  for (const source of project?.clips || []) {
    if (!excluded.has(source.id)) grouped.set(`source:${source.id}`, { drafts: [], sourceId: source.id, source })
  }
  for (const draft of workspace.drafts) {
    const scenes = draft.scenes
    const linkedId = links[draft.id] || (draft.parent_draft_id ? links[draft.parent_draft_id] : undefined)
    const candidates = project?.clips.filter(clip => scenes.every(scene => scene.start >= clip.start - .001 && scene.end <= clip.end + .001)) || []
    const source = project?.clips.find(clip => clip.id === linkedId)
      || (!retired.has(linkedId || '') ? candidates.find(clip => scenes.some(scene => scene.id === clip.id))
      || candidates.find(clip => Math.abs(outputStart(draft) - clip.start) < .001 && Math.abs(Math.max(...scenes.map(scene => scene.end)) - clip.end) < .001)
      || (candidates.length === 1 ? candidates[0] : undefined) : undefined)
    const sourceId = source?.id || linkedId
    const key = sourceId ? `source:${sourceId}` : scenes.map(scene => `${scene.start.toFixed(3)}-${scene.end.toFixed(3)}`).join('/')
    const group = grouped.get(key) || { drafts: [], sourceId, source }
    group.drafts.push(draft); grouped.set(key, group)
  }
  let extra = project?.clips.length || 0
  return [...grouped.entries()].sort((a, b) => Number(!a[1].source) - Number(!b[1].source) || (a[1].source?.start ?? outputStart(a[1].drafts[0])) - (b[1].source?.start ?? outputStart(b[1].drafts[0])) || a[0].localeCompare(b[0])).map(([key, group], index) => {
    const source = group.source
    const number = source && project ? project.clips.indexOf(source) + 1 : project ? ++extra : index + 1
    return { key, source, archived: Boolean(project && !source), drafts: group.drafts, number, color: clipColor(number - 1), origin: source?.origin || (group.drafts[0]?.origin === 'cclip-timeline' ? 'manual' : 'ai') }
  })
}

/** All scenes stay on source time; overlapping versions occupy different rows. */
export function timelineOutputs(workspace: Workspace, project?: Project): TimelineOutput[] {
  const result: TimelineOutput[] = []
  const occupied: { start: number; end: number }[][] = []
  for (const group of outputGroups(workspace, project)) {
    const draft = group.drafts[0]
    if (!draft || group.archived) continue
    const variants = workspace.output_variants?.filter(item => item.draft_id === draft.id) || []
    const state = draftExportState(draft, workspace.jobs)
    const status = state.status === 'draft' && variants.some(item => item.status === 'failed') ? 'failed' : state.status
    for (const scene of draft.scenes) {
      let lane = occupied.findIndex(ranges => ranges.every(range => range.end <= scene.start || range.start >= scene.end))
      if (lane < 0) { lane = occupied.length; occupied.push([]) }
      occupied[lane].push(scene)
      result.push({ id: `${draft.id}:${scene.id}`, draftId: draft.id, label: draft.title, status, start: scene.start, end: scene.end, lane, number: group.number, color: group.color })
    }
  }
  return result
}

export const outputStart = (draft: Draft) => Math.min(...draft.scenes.map(scene => scene.start))
