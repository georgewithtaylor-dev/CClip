import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { clamp, clipColor, formatTime, type Project, type TimeRange, type TimelineOutput } from './model'
import type { MessageKey } from './strings'
import TimelineClip from './TimelineClip'
import AudioWaveform from './AudioWaveform'
import { useEditorPreferences } from './editorPreferences'
import { rangeLanes, snapTime } from './timelineInteraction'

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string
interface Props {
  unified?: boolean
  bounds?: TimeRange
  color?: string
  outputs?: TimelineOutput[]
  outputsLabel?: string
  onOutput?: (draftId: string) => void
  editable?: boolean
  project: Project
  time: number
  selected: string
  ranges: TimeRange[]
  playing: boolean
  ui: Translator
  tools: ReactNode
  onSeek: (time: number) => void
  onRange: (range: TimeRange) => void
  onClip: (id: string, time: number) => void
  onTrim?: (id: string, start: number, end: number) => void
  onCueTrim?: (id: string, start: number, end: number) => void
  onCueDelete?: (id: string) => void
  onClipDelete?: () => void
  onAddRange?: () => void
  markShortcuts?: boolean
  selectionActionLabel?: string
  emptyRangeHint?: string
  onMark: (edge: 'in' | 'out') => void
  onClear: () => void
  onAdd: () => void
  outputDuration: number
}

export default function SourceTimeline({ unified = false, bounds, color, project, outputs = [], outputsLabel, onOutput, editable = true, time, selected, ranges, playing, ui, tools, onSeek, onRange, onClip, onTrim, onCueTrim, onCueDelete, onClipDelete, onAddRange, markShortcuts = false, selectionActionLabel, emptyRangeHint, onMark, onClear, onAdd, outputDuration }: Props) {
  const [zoom, setZoom] = useState(1)
  const [preferences, savePreferences] = useEditorPreferences()
  const [preferenceError, setPreferenceError] = useState(false)
  const [guide, setGuide] = useState<number | null>(null)
  const [selectedCue, setSelectedCue] = useState('')
  const section = useRef<HTMLElement>(null)
  const zoomScroll = useRef<number | null>(null)
  const skipFollow = useRef(false)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewport, setViewport] = useState(1000)
  const scroll = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; left: number } | null>(null)
  const drag = useRef<{ time: number; x: number; playhead: number } | null>(null)
  const origin = bounds?.start ?? 0
  const ending = bounds?.end ?? project.source.duration
  const span = Math.max(.12, ending - origin)
  const baseScale = Math.max(.001, (viewport - 35) / span)
  const scale = baseScale * zoom
  const clipLanes = useMemo(() => rangeLanes(project.clips), [project.clips])
  const cueLanes = useMemo(() => rangeLanes(project.cues), [project.cues])
  const clipLaneHeight = unified ? 62 : 34
  const clipHeight = Math.min(3, clipLanes.count) * clipLaneHeight + 8
  const cueHeight = Math.min(3, cueLanes.count) * 28 + 6
  const boundaries = useMemo(() => [...new Set([origin, ending, ...project.clips.flatMap(item => [item.start, item.end]), ...project.cues.flatMap(item => [item.start, item.end]), ...(project.bookmarks || []).map(mark => mark.time)])].sort((a, b) => a - b), [origin, ending, project.clips, project.cues, project.bookmarks])
  const targets = useMemo(() => [...new Set([...boundaries, time])].sort((a, b) => a - b), [boundaries, time])
  const width = Math.max(viewport, span * scale + 35)
  const visibleStart = Math.max(origin, origin + scrollLeft / scale - 1)
  const visibleEnd = origin + (scrollLeft + viewport) / scale + 1
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].find(value => value * scale >= 85) || 14400
  const ticks = Array.from({ length: Math.ceil(viewport / scale / step) + 3 }, (_, index) => (Math.floor(visibleStart / step) + index) * step).filter(value => value >= origin && value <= ending)
  const highlights = project.highlights || []
  const outputHeight = !unified && outputs.length ? Math.min(3, Math.max(...outputs.map(item => item.lane)) + 1) * 26 + 6 : 0
  const inView = (range: TimeRange) => range.end >= visibleStart && range.start <= visibleEnd
  const timeLabel = (value: number) => project.source.duration >= 3600 ? formatTime(value) : formatTime(value).slice(3)

  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientWidth))
    observer.observe(element); setViewport(element.clientWidth)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (skipFollow.current) { skipFollow.current = false; return }
    if (!scroll.current || drag.current) return
    const x = (time - origin) * scale
    if (x < scroll.current.scrollLeft || x > scroll.current.scrollLeft + viewport - 24) scroll.current.scrollLeft = Math.max(0, x - viewport * .25)
  }, [time, playing, scale, viewport, origin])
  useEffect(() => { setZoom(1); if (scroll.current) scroll.current.scrollLeft = 0 }, [project.source.assetId, project.source.duration])
  useLayoutEffect(() => {
    if (scroll.current && zoomScroll.current !== null) { scroll.current.scrollLeft = zoomScroll.current; zoomScroll.current = null; skipFollow.current = true }
  }, [zoom])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const anchor = clamp(event.clientX - element.getBoundingClientRect().left, 0, element.clientWidth)
      const next = clamp(zoom * Math.exp(-event.deltaY * .0025), 1, 30)
      zoomScroll.current = (element.scrollLeft + anchor) / scale * baseScale * next - anchor
      setZoom(next)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [zoom, scale, baseScale])
  useEffect(() => { setSelectedCue('') }, [selected])
  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || event.defaultPrevented || !editable || !section.current?.offsetParent || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog],.wb-transcript-panel')) return
      if (selectedCue && project.cues.some(cue => cue.id === selectedCue) && onCueDelete) { event.preventDefault(); onCueDelete(selectedCue); setSelectedCue('') }
      else if (selected && onClipDelete) { event.preventDefault(); onClipDelete() }
    }
    window.addEventListener('keydown', remove, true)
    return () => window.removeEventListener('keydown', remove, true)
  }, [editable, selectedCue, selected, project.cues, onCueDelete, onClipDelete])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!editable || event.defaultPrevented || !section.current?.offsetParent || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return
      const command = event.ctrlKey || event.metaKey
      if (!command && event.key.toLowerCase() === preferences.snap) { event.preventDefault(); void savePreferences({ ...preferences, snapping: !preferences.snapping }).catch(() => setPreferenceError(true)) }
      else if (markShortcuts && !command && [preferences.markIn, preferences.markOut].includes(event.key.toLowerCase())) { event.preventDefault(); onMark(event.key.toLowerCase() === preferences.markIn ? 'in' : 'out') }
      else if (command && ['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); const next = event.key === '0' ? 1 : clamp(zoom * (event.key === '-' ? .8 : 1.25), 1, 30); zoomScroll.current = Math.max(0, (time - origin) * baseScale * next - viewport * .35); setZoom(next) }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [preferences, savePreferences, markShortcuts, onMark, zoom, time, origin, baseScale, viewport, editable])

  const point = (event: PointerEvent<HTMLDivElement>) => clamp((event.clientX - event.currentTarget.getBoundingClientRect().left) / scale + origin, origin, ending)
  const scrub = (event: PointerEvent<HTMLDivElement>) => onSeek(point(event))
  const timeAt = (x: number) => clamp(origin + (x - (scroll.current?.getBoundingClientRect().left || 0) + (scroll.current?.scrollLeft || 0)) / scale, origin, ending)
  const rangePoint = (event: PointerEvent<HTMLDivElement>, playhead: number) => {
    const result = snapTime(point(event), [...boundaries, playhead].sort((a, b) => a - b), scale, preferences.snapping && !event.altKey)
    setGuide(result.target); return result.time
  }
  return <section ref={section} data-zoom={zoom} className={`wb-timeline-section wb-source-timeline${unified ? ' is-unified' : ''}${!unified && outputs.length ? ' has-outputs' : ''}`} style={{ '--output-track-height': `${outputHeight}px`, '--clip-track-height': `${clipHeight}px`, '--caption-track-height': `${cueHeight}px`, '--clip-color': clipColor(project.clips.findIndex(clip => clip.id === selected)) } as CSSProperties} aria-label={ui('fullTimeline')}>
    <div className="wb-timeline-toolbar"><div className="wb-edit-tools">{tools}<button className="wb-tool-button" data-timeline-snap aria-pressed={preferences.snapping} onClick={() => void savePreferences({ ...preferences, snapping: !preferences.snapping }).catch(() => setPreferenceError(true))}>{ui('snap')} <kbd>{preferences.snap.toUpperCase()}</kbd></button><span className="wb-tool-divider" /><span className="wb-timeline-legend"><i className="is-ai" />{ui('aiPicks')}<i className="is-manual" />{ui('manualClip')}</span></div><div className="wb-zoom"><button className="wb-text-button" onClick={() => { setZoom(1); if (scroll.current) scroll.current.scrollLeft = 0 }}>{ui('fitTimeline')}</button><span>−</span><input type="range" aria-label={ui('zoom')} min="1" max="30" step=".1" value={zoom} onChange={event => setZoom(Number(event.target.value))} /><span>+</span></div></div>
    <div className="wb-timeline-layout"><div className="wb-track-labels"><div />{!unified && <div>{ui('source')}</div>}<div>{ui('selectedClips')}</div>{!unified && outputs.length > 0 && <div className="wb-output-label">{outputsLabel}</div>}<div>{ui('subtitles')}</div></div><div className="wb-timeline-scroll" ref={scroll} onPointerDownCapture={event => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); pan.current = { x: event.clientX, left: event.currentTarget.scrollLeft } }} onPointerMoveCapture={event => { if (!pan.current) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.scrollLeft = pan.current.left - (event.clientX - pan.current.x) }} onPointerUpCapture={event => { if (!pan.current) return; event.preventDefault(); event.stopPropagation(); pan.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { pan.current = null }} onAuxClick={event => { if (event.button === 1) event.preventDefault() }} onScroll={event => setScrollLeft(event.currentTarget.scrollLeft)}><div className="wb-timeline-content" style={{ width }}>
      <div className="wb-ruler" role="slider" tabIndex={0} aria-label={ui('playhead')} aria-valuemin={origin} aria-valuemax={ending} aria-valuenow={Math.round(time * 10) / 10} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onSeek(clamp(time + (event.key === 'ArrowRight' ? 1 : -1), origin, ending)) } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); scrub(event) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event) }}>
        {ticks.map(value => <span className="wb-ruler-tick" style={{ left: (value - origin) * scale }} key={value}>{timeLabel(value)}</span>)}
        {(project.bookmarks || []).filter(mark => mark.time >= visibleStart && mark.time <= visibleEnd).map(mark => <button className="wb-bookmark-marker" key={mark.id} style={{ left: (mark.time - origin) * scale }} title={`${formatTime(mark.time)} · ${mark.label}`} aria-label={`${ui('jumpBookmark')} ${formatTime(mark.time)} ${mark.label}`} onPointerDown={event => event.stopPropagation()} onClick={() => onSeek(mark.time)}>◆</button>)}
      </div>
      {!unified && <div className="wb-full-source-track" aria-label={ui('fullSource')} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); const next = rangePoint(event, time); drag.current = { time: next, x: event.clientX, playhead: time }; onSeek(next) }} onPointerMove={event => { if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return; const next = rangePoint(event, drag.current.playhead); if (editable && Math.abs(event.clientX - drag.current.x) >= 3) onRange({ start: Math.min(drag.current.time, next), end: Math.max(drag.current.time, next) }); onSeek(next) }} onPointerUp={() => { drag.current = null; setGuide(null) }} onPointerCancel={() => { drag.current = null; setGuide(null) }}>
        <div className="wb-full-source-strip" style={{ width: span * scale }}><span style={{ left: Math.max(10, scrollLeft + 10) }}>{bounds ? <>{ui('source')} · {formatTime(origin)} → {formatTime(ending)}</> : <>{ui('fullSource')} · {formatTime(project.source.duration)}</>}</span></div>
        <AudioWaveform url={project.source.assetId ? `/api/workbench/assets/${project.source.assetId}/waveform` : undefined} origin={origin} scale={scale} visibleStart={visibleStart} visibleEnd={Math.min(ending, visibleEnd)} label={ui('waveform')} loadingLabel={ui('waveformLoading')} unavailableLabel={ui('waveformUnavailable')} />
        {!unified && highlights.filter(inView).map(clip => <span key={clip.id} className="wb-ai-source-marker" title={`${ui('aiPicks')} · ${clip.name}`} style={{ left: (clip.start - origin) * scale, width: Math.max(2, (clip.end - clip.start) * scale) }}>{(clip.end - clip.start) * scale > 35 ? 'AI' : ''}</span>)}
        {ranges.filter(inView).map((range, index) => <span className="wb-source-selection" key={index} style={{ left: (range.start - origin) * scale, width: Math.max(2, (range.end - range.start) * scale) }} />)}
      </div>}
      <div className="wb-source-clip-track" style={{ height: clipHeight }} aria-label={ui('fullSource')} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); const next = rangePoint(event, time); drag.current = { time: next, x: event.clientX, playhead: time }; onSeek(next) }} onPointerMove={event => { if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return; const next = rangePoint(event, drag.current.playhead); if (editable && Math.abs(event.clientX - drag.current.x) >= 3) onRange({ start: Math.min(drag.current.time, next), end: Math.max(drag.current.time, next) }); onSeek(next) }} onPointerUp={() => { drag.current = null; setGuide(null) }} onPointerCancel={() => { drag.current = null; setGuide(null) }}><div className="wb-timeline-lanes" style={{ height: clipLanes.count * clipLaneHeight + 6 }}>{project.clips.filter(inView).map(clip => <TimelineClip key={clip.id} clip={clip} lane={clipLanes.lanes.get(clip.id)} snapping={preferences.snapping} targets={targets} onGuide={setGuide} number={project.clips.indexOf(clip) + 1} color={color || clipColor(project.clips.indexOf(clip))} selected={selected === clip.id} scale={scale} origin={origin} bounds={{ start: origin, end: ending }} timeAt={timeAt} label={`${ui('chooseClip')}: ${clip.name}`} title={`${clip.name} · ${formatTime(clip.start)} – ${formatTime(clip.end)}`} startLabel={ui('start')} endLabel={ui('end')} onSelect={() => { setSelectedCue(''); onClip(clip.id, clip.start) }} onTrim={editable ? onTrim : undefined} laneHeight={clipLaneHeight}>{unified ? range => <AudioWaveform url={project.source.assetId ? `/api/workbench/assets/${project.source.assetId}/waveform` : undefined} origin={range.start} scale={scale} visibleStart={Math.max(range.start, visibleStart)} visibleEnd={Math.min(range.end, visibleEnd)} label={ui('waveform')} loadingLabel={ui('waveformLoading')} unavailableLabel={ui('waveformUnavailable')} /> : undefined}</TimelineClip>)}</div>{unified && ranges.filter(inView).map((range, index) => <span className="wb-source-selection" key={index} style={{ left: (range.start - origin) * scale, width: Math.max(2, (range.end - range.start) * scale) }} />)}</div>
      {!unified && outputs.length > 0 && <div className="wb-output-track" aria-label={outputsLabel}>{outputs.filter(inView).map(item => <button className={`wb-output-marker is-${item.status}`} key={item.id} style={{ left: (item.start - origin) * scale, width: Math.max(8, (item.end - item.start) * scale - 1), top: 3 + item.lane * 26 }} title={`${item.label} · ${formatTime(item.start)} – ${formatTime(item.end)}`} aria-label={`${outputsLabel}: ${item.label} ${formatTime(item.start)}`} onClick={() => onOutput?.(item.draftId)}>{item.label}</button>)}</div>}
      <div className="wb-source-caption-track" style={{ height: cueHeight }}><div className="wb-timeline-lanes" style={{ height: cueLanes.count * 28 + 6 }}>{project.cues.filter(inView).map(cue => <TimelineClip key={cue.id} kind="cue" current={cue.start <= time && time < cue.end} minimum={.02} clip={{ ...cue, name: cue.text, color: 0 }} number={0} lane={cueLanes.lanes.get(cue.id)} color="#cdb678" selected={selectedCue === cue.id} scale={scale} origin={origin} bounds={{ start: origin, end: ending }} timeAt={timeAt} label={`${ui('subtitleText')}: ${cue.text}`} title={`${formatTime(cue.start, true)} · ${cue.text}`} startLabel={ui('start')} endLabel={ui('end')} onSelect={() => { setSelectedCue(cue.id); onSeek(cue.start) }} onTrim={editable ? onCueTrim : undefined} snapping={preferences.snapping} targets={targets} onGuide={setGuide} />)}</div></div>
      {guide !== null && <div className="wb-snap-guide" style={{ left: (guide - origin) * scale }}><span>{formatTime(guide, true)}</span></div>}
      <div className="wb-timeline-playhead" style={{ left: (time - origin) * scale }}><span /></div>
    </div></div></div>
    <div className="wb-selection-bar" aria-disabled={!editable}><div className="wb-mark-buttons"><button className="wb-text-button" disabled={!editable} onClick={() => onMark('in')}>{ui('markIn')}<kbd>{preferences.markIn.toUpperCase()}</kbd></button><button className="wb-text-button" disabled={!editable} onClick={() => onMark('out')}>{ui('markOut')}<kbd>{preferences.markOut.toUpperCase()}</kbd></button></div><div className="wb-selection-summary">{ranges.length ? <><b>{ui('selection')} {formatTime(ranges[0].start, true)} → {formatTime(ranges[ranges.length - 1].end, true)}</b><span>{ui('rangeCount', { count: ranges.length })}</span><button className="wb-text-button" disabled={!editable} onClick={onClear}>{ui('clearSelection')}</button></> : <span>{emptyRangeHint || ui('rangeHint')}</span>}</div>{onAddRange && <button className="wb-button" disabled={!editable || !ranges.length} onClick={onAddRange} title={ui('independentRange')}>{ui('addRange')}</button>}<button className="wb-button wb-button-accent" disabled={!editable || !ranges.length} onClick={onAdd}>{selectionActionLabel || ui('addSelection')}{!selectionActionLabel && ' +'}</button></div>
    <div className="wb-timeline-footer"><span>{preferenceError ? ui('editorPreferencesFailed') : ui('timelineInteractionHint')}</span><div><span>{ui(bounds ? 'selection' : 'sourceDuration')} <b>{bounds ? `${formatTime(origin)} → ${formatTime(ending)}` : formatTime(project.source.duration)}</b></span><i /><span>{ui('clipCount', { count: project.clips.length })}</span><i /><span>{ui('outputDuration')} <b>{formatTime(outputDuration)}</b></span></div></div>
  </section>
}
