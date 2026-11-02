import type { Project } from './model'

/** Import late source results without discarding unsaved edits or undo history. */
export function mergeExternalProject(base: Project, local: Project, remote: Project): Project {
  if (local.localId !== remote.localId || local.source.assetId !== remote.source.assetId) return local
  const merge = <T extends { id: string }>(before: T[], current: T[], incoming: T[]): T[] => {
    const old = new Map(before.map(item => [item.id, item])), fresh = new Map(incoming.map(item => [item.id, item]))
    const kept = current.flatMap(item => {
      if (!old.has(item.id) || JSON.stringify(item) !== JSON.stringify(old.get(item.id))) return [item]
      return fresh.has(item.id) ? [fresh.get(item.id)!] : []
    })
    const ids = new Set(current.map(item => item.id))
    const added = incoming.filter(item => !ids.has(item.id) && !old.has(item.id))
    return before.length ? [...kept, ...added] : [...added, ...kept]
  }
  return { ...remote, title: local.title !== base.title ? local.title : remote.title,
    clips: merge(base.clips, local.clips, remote.clips), cues: merge(base.cues, local.cues, remote.cues),
    bookmarks: merge(base.bookmarks || [], local.bookmarks || [], remote.bookmarks || []), highlights: remote.highlights }
}
