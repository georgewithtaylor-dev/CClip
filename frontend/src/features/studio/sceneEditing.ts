import type { Scene } from './types'

/** Add source content once, merging only the connected overlap at its first scene. */
export function addSceneRange(scenes: Scene[], range: { start: number; end: number }, base: Scene,
                              makeId = () => crypto.randomUUID()): Scene[] {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end - range.start < .12) return scenes
  let start = range.start, end = range.end
  const touched = new Set<Scene>()
  let found = true
  while (found) {
    found = false
    for (const scene of scenes) {
      if (touched.has(scene) || scene.end < start || scene.start > end) continue
      touched.add(scene); found = true
      start = Math.min(start, scene.start); end = Math.max(end, scene.end)
    }
  }
  if (!touched.size) return [...scenes, { ...base, id: makeId(), start, end, crop_track: null, framing_adjusted: true }]
  const first = scenes.find(scene => touched.has(scene))!
  if (touched.size === 1 && first.start === start && first.end === end) return scenes
  const merged = { ...first, start, end, crop_track: null, framing_adjusted: true }
  return scenes.flatMap(scene => scene === first ? [merged] : touched.has(scene) ? [] : [scene])
}

export function trimScene(scene: Scene, start: number, end: number): Scene {
  const track = scene.crop_track
  let crop_track = track
  if (track?.length) {
    const delta = start - scene.start
    let first = track[0]
    for (const point of track) if (point.start <= delta) first = point
    crop_track = [{ ...first, start: 0 }, ...track.filter(point => point.start > delta && point.start < end - scene.start)
      .map(point => ({ ...point, start: point.start - delta }))]
  }
  return { ...scene, start, end, crop_track, framing_adjusted: true }
}

/** Cut source time, leaving ordered pieces and their original speaker framing. */
export function removeSceneRange(scenes: Scene[], range: { start: number; end: number }, makeId = () => crypto.randomUUID()): Scene[] {
  return scenes.flatMap(scene => {
    if (range.end <= scene.start || range.start >= scene.end) return [scene]
    const result: Scene[] = []
    if (range.start - scene.start >= .12) result.push(trimScene(scene, scene.start, range.start))
    if (scene.end - range.end >= .12) result.push({ ...trimScene(scene, range.end, scene.end), id: result.length ? makeId() : scene.id })
    return result
  })
}

/** Source-time caption selections keep the user's scene order and framing. */
export function editSceneRanges(scenes: Scene[], ranges: { start: number; end: number }[], keep: boolean,
                                makeId = () => crypto.randomUUID()): Scene[] {
  const ordered = ranges.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map(r => ({ ...r })).sort((a, b) => a.start - b.start)
  const merged: typeof ordered = []
  for (const range of ordered) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + .00001) last.end = Math.max(last.end, range.end)
    else merged.push(range)
  }
  if (!merged.length) return scenes
  if (!keep) return merged.reduce((result, range) => removeSceneRange(result, range, makeId), scenes)
  return scenes.flatMap(scene => {
    const overlaps = merged.map(range => ({ start: Math.max(scene.start, range.start), end: Math.min(scene.end, range.end) }))
      .filter(range => range.end - range.start >= .12)
    return overlaps.map((range, index) => ({ ...trimScene(scene, range.start, range.end), id: index ? makeId() : scene.id }))
  })
}
