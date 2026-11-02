import { clamp, type TimeRange } from './model'

/** A screen-sized magnet, capped in seconds so a long recording never jumps far. */
export function snapTime(value: number, targets: readonly number[], scale: number, enabled = true) {
  if (!enabled || !targets.length) return { time: value, target: null as number | null }
  let lo = 0, hi = targets.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (targets[mid] < value) lo = mid + 1; else hi = mid }
  const choices = [targets[lo - 1], targets[lo]].filter((v): v is number => Number.isFinite(v))
  const target = choices.sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0]
  return Math.abs(target - value) <= Math.min(.4, 8 / Math.max(.001, scale))
    ? { time: target, target } : { time: value, target: null }
}

export function snapMove(range: TimeRange, delta: number, targets: readonly number[], scale: number, bounds: TimeRange, enabled = true) {
  const length = range.end - range.start
  const start = clamp(range.start + delta, bounds.start, bounds.end - length)
  const a = snapTime(start, targets, scale, enabled), b = snapTime(start + length, targets, scale, enabled)
  const useStart = a.target !== null && (b.target === null || Math.abs(a.time - start) <= Math.abs(b.time - start - length))
  const next = clamp(useStart ? a.time : b.target !== null ? b.time - length : start, bounds.start, bounds.end - length)
  return { start: next, end: next + length, target: useStart ? a.target : b.target }
}

/** Overlapping edits remain separately selectable, including identical ranges. */
export function rangeLanes(items: (TimeRange & { id: string })[]) {
  const ends: number[] = [], lanes = new Map<string, number>()
  for (const item of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let lane = ends.findIndex(end => end <= item.start + .00001)
    if (lane < 0) lane = ends.length
    ends[lane] = item.end; lanes.set(item.id, lane)
  }
  return { lanes, count: Math.max(1, ends.length) }
}
