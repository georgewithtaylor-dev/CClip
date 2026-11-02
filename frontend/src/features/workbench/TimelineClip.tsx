import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { clamp, MIN_CLIP, type Clip, type TimeRange } from './model'
import { snapMove, snapTime } from './timelineInteraction'

interface Props {
  clip: Clip; number: number; color: string; selected: boolean; current?: boolean; scale: number; origin: number; bounds: TimeRange
  label: string; title: string; startLabel: string; endLabel: string; lane?: number; kind?: 'clip' | 'cue'; minimum?: number
  targets?: number[]; snapping?: boolean; onGuide?: (time: number | null) => void
  laneHeight?: number; children?: (range: TimeRange) => ReactNode
  timeAt: (x: number) => number; onSelect: () => void; onTrim?: (id: string, start: number, end: number) => void
}
type Edge = 'start' | 'end' | 'move'
export default function TimelineClip(props: Props) {
  const { clip, color, scale, origin, kind = 'clip' } = props
  const [preview, setPreview] = useState<TimeRange | null>(null)
  const drag = useRef<{ edge: Edge; anchor: number; x: number; moved: boolean; value: TimeRange; original: TimeRange; targets: number[] } | null>(null)
  const suppressClick = useRef(false)
  const minimum = props.minimum ?? MIN_CLIP
  const trim = (edge: 'start' | 'end', time: number): TimeRange => edge === 'start'
    ? { start: clamp(time, props.bounds.start, clip.end - minimum), end: clip.end }
    : { start: clip.start, end: clamp(time, clip.start + minimum, props.bounds.end) }
  const down = (event: PointerEvent<HTMLElement>, edge: Edge) => {
    if (!props.onTrim || event.button !== 0) return
    // In the combined output track, Shift-drag selects a time range through
    // the parent track; a normal drag continues to adjust the source window.
    if (edge === 'move' && event.shiftKey) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    drag.current = { edge, x: event.clientX, anchor: props.timeAt(event.clientX), original: { start: clip.start, end: clip.end }, value: { start: clip.start, end: clip.end }, moved: false, targets: props.targets || [] }
    if (edge === 'move') props.onSelect()
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.stopPropagation(); current.moved ||= Math.abs(event.clientX - current.x) >= 3
    if (!current.moved && current.edge === 'move') return
    const delta = props.timeAt(event.clientX) - current.anchor
    let value: TimeRange, guide: number | null = null
    if (current.edge === 'move') {
      const result = snapMove(current.original, delta, current.targets, scale, props.bounds, props.snapping && !event.altKey)
      value = result; guide = result.target
    } else {
      value = trim(current.edge, current.original[current.edge] + delta)
      const targets = current.targets.filter(target => current.edge === 'start' ? target <= clip.end - minimum : target >= clip.start + minimum)
      const result = snapTime(value[current.edge], targets, scale, props.snapping && !event.altKey)
      value = trim(current.edge, result.time); guide = result.target
    }
    current.value = value; setPreview(value); props.onGuide?.(guide)
  }
  const stop = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    if (!drag.current) return
    event.stopPropagation(); event.preventDefault()
    const current = drag.current; drag.current = null; setPreview(null); props.onGuide?.(null)
    suppressClick.current = current.moved || current.edge !== 'move'
    if (commit && (current.edge !== 'move' || current.moved) && (current.value.start !== clip.start || current.value.end !== clip.end)) props.onTrim?.(clip.id, current.value.start, current.value.end)
  }
  const handle = (edge: 'start' | 'end') => <span className={`wb-trim-handle is-${edge}`} role="slider" tabIndex={0} aria-label={edge === 'start' ? props.startLabel : props.endLabel} aria-valuemin={props.bounds.start} aria-valuemax={props.bounds.end} aria-valuenow={(preview || clip)[edge]}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); const value = trim(edge, clip[edge] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : .1)); props.onTrim?.(clip.id, value.start, value.end) } }}
    onPointerDown={event => down(event, edge)} onPointerMove={move} onPointerUp={event => stop(event, true)} onPointerCancel={event => stop(event, false)} />
  const range = preview || clip
  return <button data-range-start={range.start} data-range-end={range.end} className={`${kind === 'clip' ? 'wb-source-clip' : 'wb-subtitle-block'} ${props.children ? 'has-waveform' : ''} ${props.selected ? 'is-selected' : ''} ${props.current ? 'is-current' : ''} ${clip.origin === 'manual' ? 'is-manual' : ''}`} aria-label={props.label} style={{ left: (range.start - origin) * scale, top: (props.lane || 0) * (props.laneHeight || (kind === 'clip' ? 34 : 28)) + 3, width: Math.max(3, (range.end - range.start) * scale), '--clip-color': color, '--clip-tint': color + '22', zIndex: props.selected ? 3 : 1 } as CSSProperties} title={props.title}
    onPointerDown={event => down(event, 'move')} onPointerMove={move} onPointerUp={event => stop(event, true)} onPointerCancel={event => stop(event, false)}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } props.onSelect() }}>
    {props.children?.(range)}<span className="wb-clip-name">{kind === 'clip' && `${String(props.number).padStart(2, '0')} · `}{clip.name}</span>{props.selected && props.onTrim && <>{handle('start')}{handle('end')}</>}
  </button>
}
