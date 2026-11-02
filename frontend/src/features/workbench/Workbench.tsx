import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  STORAGE_KEY, MIN_CLIP, clipColor, clamp, commit, demoProject, duration, exportSrt, formatTime, moveClip,
  outputCues, parseSrt, programPosition, redo, sourcePosition, splitClip, trimClip, undo,
  validateProject, prepareProject, appendManualClips, rangesFromCues, removeSourceRanges, type TimelineOutput, type TimeRange, type Clip, type Cue, type History, type Project,
} from './model'
import { languages, translate, type Language, type MessageKey } from './strings'
import SourceTimeline from './SourceTimeline'
import { useEditorPreferences } from './editorPreferences'
import { mergeExternalProject } from './mergeExternalProject'
import WorkspaceLayout from './WorkspaceLayout'
import TranscriptPanel from './TranscriptPanel'
import LocalServiceControls, { type LocalServiceHandle } from './LocalServiceControls'
import LocalTaskProgress, { type LocalTaskActivity } from './LocalTaskProgress'
import { mediaUrl } from './localApi'

type IconName = 'cut' | 'play' | 'pause' | 'folder' | 'film' | 'text' | 'undo' | 'redo' | 'trash' | 'plus' | 'search' | 'save' | 'download' | 'chevron' | 'shield' | 'previous' | 'next' | 'sliders' | 'close' | 'check' | 'arrow'
const iconPaths: Record<IconName, string> = {
  cut: 'M6 3v5m0 4v9m12-18L7.5 14.5M18 21l-6-6M3 10a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm0 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
  play: 'm9 5 11 7-11 7V5Z', pause: 'M8 5v14M16 5v14', folder: 'M3 7h7l2-3h7a2 2 0 0 1 2 2v13H3V7Zm0 0V4h6l3 3',
  film: 'M3 5h18v14H3V5Zm4 0v14m10-14v14M3 10h4m10 0h4M3 15h4m10 0h4', text: 'M4 5h16M12 5v15M8 20h8',
  undo: 'M4 10h10a6 6 0 0 1 0 12M4 10l5-5m-5 5 5 5', redo: 'M20 10H10a6 6 0 0 0 0 12m10-12-5-5m5 5-5 5',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7', plus: 'M12 4v16M4 12h16',
  search: 'M17 17l5 5M3 10a7 7 0 1 0 14 0 7 7 0 0 0-14 0Z', save: 'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', chevron: 'm9 5 7 7-7 7', shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  previous: 'M5 5v14m14-14L8 12l11 7V5Z', next: 'M19 5v14M5 5l11 7-11 7V5Z',
  sliders: 'M4 7h16M4 17h16M9 4v6m6 4v6', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6', arrow: 'M5 12h14m-6-6 6 6-6 6',
}
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>
}
type Translator = (key: MessageKey, values?: Record<string, string | number>) => string

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const project: unknown = JSON.parse(raw)
      if (validateProject(project)) return { project: prepareProject(project), error: false, savedSnapshot: JSON.stringify(project) }
      return { project: demoProject(), error: true, savedSnapshot: '' }
    }
  } catch { return { project: demoProject(), error: true, savedSnapshot: '' } }
  const example = demoProject()
  return { project: example, error: false, savedSnapshot: JSON.stringify(example) }
}

function download(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ClipSettings({ clip, max, ui, onApply }: { clip: Clip; max: number; ui: Translator; onApply: (start: number, end: number, name: string) => void }) {
  const [start, setStart] = useState(String(clip.start))
  const [end, setEnd] = useState(String(clip.end))
  const [name, setName] = useState(clip.name)
  useEffect(() => { setStart(String(clip.start)); setEnd(String(clip.end)); setName(clip.name) }, [clip])
  return <form className="wb-clip-settings" onSubmit={event => { event.preventDefault(); onApply(start.trim() ? Number(start) : NaN, end.trim() ? Number(end) : NaN, name) }}>
    <label>{ui('clipName')}<input maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="wb-range-inputs"><label>{ui('start')}<input type="number" min="0" max={max} step="0.01" value={start} onChange={event => setStart(event.target.value)} /></label><label>{ui('end')}<input type="number" min="0" max={max} step="0.01" value={end} onChange={event => setEnd(event.target.value)} /></label></div>
    <div className="wb-range-summary"><span>{ui('outputDuration')}</span><b>{formatTime(Math.max(0, Number(end) - Number(start)) || 0, true)}</b></div>
    <button className="wb-button wb-button-accent" type="submit">{ui('apply')}<Icon name="check" size={16} /></button>
  </form>
}

interface WorkbenchProps {
  initialProject?: Project
  language?: Language
  onHome?: () => void
  onProjectChange?: (project: Project) => void
  onPlatform?: (project: Project, clipId?: string) => Promise<void>
  onDownload?: (url: string) => Promise<void>
  onTextDownload?: (name: string, text: string) => Promise<unknown>
  onSettings?: () => void
  onSaved?: (project: Project) => Promise<void>
  onOpened?: (project: Project) => void
  onPanelHeaderHost?: (host: HTMLDivElement | null) => void
  onSaveReady?: (save: () => Promise<void>) => void
  initialSaved?: boolean
  workspaceControls?: ReactNode
  workspaceTasks?: ReactNode
  workspacePanel?: ReactNode
  workspacePanelActive?: boolean
  hasPanelChanges?: boolean
  onSavePanel?: () => Promise<unknown>
  workspaceLibrary?: ReactNode
  onShowOutputs?: () => void
  onEditSource?: () => void
  outputsLabel?: string
  timelineOutputs?: TimelineOutput[]
  onOutput?: (draftId: string) => void
  panelTime?: number
  onPanelSeek?: (time: number) => void
}

export default function Workbench({ initialProject, language: sharedLanguage, onHome, onProjectChange, onPlatform, onDownload, onTextDownload, onSettings, onSaved, onOpened, initialSaved = true, onPanelHeaderHost, onSaveReady, workspaceControls, workspaceTasks, workspacePanel, workspacePanelActive = true, hasPanelChanges = false, onSavePanel, workspaceLibrary, onShowOutputs, onEditSource, outputsLabel, timelineOutputs, onOutput, panelTime, onPanelSeek }: WorkbenchProps = {}) {
  const [preferences] = useEditorPreferences()
  const integrated = Boolean(onHome)
  const panelActive = Boolean(workspacePanel) && workspacePanelActive
  const [initial] = useState(() => initialProject ? { project: initialProject, savedSnapshot: initialSaved ? JSON.stringify(initialProject) : '', error: false } : loadInitial())
  const [platformBusy, setPlatformBusy] = useState(false)
  const [history, setHistory] = useState<History>({ past: [], present: initial.project, future: [] })
  const historyRef = useRef(history)
  const incomingBase = useRef(initialProject)
  const project = history.present
  const [saved, setSaved] = useState(initial.savedSnapshot)
  const [language, setLanguage] = useState<Language>(() => {
    if (sharedLanguage) return sharedLanguage
    try { const value = localStorage.getItem('autoclip.workbench.language'); return languages.some(([code]) => code === value) ? value as Language : 'zh' } catch { return 'zh' }
  })
  const ui: Translator = (key, values) => translate(language, key, values)
  const [notice, setNotice] = useState<MessageKey | null>(initial.error ? 'invalidProject' : initial.project.source.kind === 'local' && !initial.project.source.assetId ? 'sourceUnavailable' : null)
  const [selected, setSelected] = useState(sourcePosition(project, 0)?.clip.id || '')
  const [mode, setMode] = useState<'source' | 'program'>('source')
  const [playhead, setPlayhead] = useState(0)
  const [sourceTime, setSourceTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [query, setQuery] = useState('')
  const [rightTab, setRightTab] = useState<'subtitles' | 'range'>('subtitles')
  const [selectedCueIds, setSelectedCueIds] = useState<string[]>([])
  const [transcriptFocus, setTranscriptFocus] = useState<{ start: number; end: number; revision: number } | null>(null)
  const [sourceRange, setSourceRange] = useState<TimeRange | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [mediaError, setMediaError] = useState(false)
  const [localReady, setLocalReady] = useState(false)
  const [activity, setActivity] = useState<LocalTaskActivity | null>(null)
  const localService = useRef<LocalServiceHandle>(null)
  const video = useRef<HTMLVideoElement>(null)
  const srtInput = useRef<HTMLInputElement>(null)
  const draftInput = useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(project) !== saved
  const total = duration(project)
  const position = programPosition(project, playhead)
  const currentSource = mode === 'source' ? sourceTime : position?.sourceTime ?? 0
  const selectedClip = project.clips.find(clip => clip.id === selected)
  const activeCue = project.cues.find(cue => cue.start <= currentSource && currentSource < cue.end)
  const subtitles = outputCues(project)
  const pendingRanges = useMemo(() => (selectedCueIds.length ? rangesFromCues(project.cues, selectedCueIds) : sourceRange ? [sourceRange] : [])
    .filter(range => range.end - range.start >= MIN_CLIP), [selectedCueIds, sourceRange, project.cues])
  useEffect(() => { onProjectChange?.(project) }, [project, onProjectChange])
  useEffect(() => {
    const before = incomingBase.current
    incomingBase.current = initialProject
    if (!before || !initialProject || before === initialProject || before.localId !== initialProject.localId) return
    setHistory(current => {
      const next = { past: current.past.map(value => mergeExternalProject(before, value, initialProject)),
        present: mergeExternalProject(before, current.present, initialProject),
        future: current.future.map(value => mergeExternalProject(before, value, initialProject)) }
      historyRef.current = next
      return next
    })
    setSaved(JSON.stringify(initialProject))
  }, [initialProject])

  useEffect(() => {
    if (sharedLanguage) setLanguage(sharedLanguage)
  }, [sharedLanguage])
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language
    document.title = translate(language, 'workbench')
    try { localStorage.setItem('autoclip.workbench.language', language) } catch { /* Language remains usable without storage. */ }
  }, [language])
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])
  useEffect(() => { if (localReady && project.source.assetId) { setVideoUrl(mediaUrl(project)); setMediaError(false) } }, [localReady, project.source.assetId])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || localService.current?.hasTask()) { event.preventDefault(); event.returnValue = '' } }
    const desktopWindow = window as Window & { __cclipCloseReady?: boolean; __cclipEditorActive?: boolean; __cclipNeedsConfirm?: () => boolean }
    const protectNavigation = (event: Event) => {
      flushSync(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      const running = localService.current?.hasTask()
      if (integrated && (event as CustomEvent<{ withinProject?: boolean }>).detail?.withinProject && !running) return
      if ((JSON.stringify(historyRef.current.present) !== saved || hasPanelChanges || running) && !window.confirm(ui(running ? 'closeTaskConfirm' : 'closeConfirm'))) event.preventDefault()
    }
    const closeNative = () => {
      flushSync(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      const unsaved = JSON.stringify(historyRef.current.present) !== saved || hasPanelChanges
      const running = localService.current?.hasTask()
      if ((!unsaved && !running) || window.confirm(ui(running ? 'closeTaskConfirm' : 'closeConfirm'))) {
        window.removeEventListener('beforeunload', warn)
        window.location.href = 'cclip-close://approved'
      }
    }
    desktopWindow.__cclipCloseReady = true
    desktopWindow.__cclipEditorActive = true
    desktopWindow.__cclipNeedsConfirm = () => JSON.stringify(historyRef.current.present) !== saved || hasPanelChanges || !!localService.current?.hasTask()
    window.addEventListener('beforeunload', warn)
    window.addEventListener('cclip-close-request', closeNative)
    window.addEventListener('cclip-before-navigate', protectNavigation)
    return () => { desktopWindow.__cclipCloseReady = integrated; desktopWindow.__cclipEditorActive = false; desktopWindow.__cclipNeedsConfirm = undefined; window.removeEventListener('beforeunload', warn); window.removeEventListener('cclip-close-request', closeNative); window.removeEventListener('cclip-before-navigate', protectNavigation) }
  }, [dirty, language, integrated, hasPanelChanges])
  useEffect(() => {
    const bounded = clamp(playhead, 0, total)
    if (bounded !== playhead) setPlayhead(bounded)
    if (!project.clips.some(clip => clip.id === selected)) setSelected(mode === 'source' ? sourcePosition(project, sourceTime)?.clip.id || '' : project.clips[0]?.id || '')
    if (video.current && mode === 'program') {
      const next = programPosition(project, bounded)
      if (next) video.current.currentTime = next.sourceTime
    }
  // Re-seek after editing the sequence; playback updates must not repeatedly seek the video.
  }, [project.clips])
  useEffect(() => {
    if (playing && mode === 'program' && position) setSelected(position.clip.id)
    if (playing && mode === 'source') setSelected(sourcePosition(project, sourceTime, selected)?.clip.id || '')
  }, [playing, mode, position?.clip.id, sourceTime])
  useEffect(() => {
    const valid = new Set(project.cues.map(cue => cue.id))
    setSelectedCueIds(ids => ids.every(id => valid.has(id)) ? ids : ids.filter(id => valid.has(id)))
  }, [project.cues])
  useEffect(() => {
    if (!playing || videoUrl) return
    if (project.source.kind !== 'demo') { setPlaying(false); return }
    let previous = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now(); const delta = (now - previous) / 1000; previous = now
      if (mode === 'program') setPlayhead(value => { if (value + delta >= total) setPlaying(false); return Math.min(total, value + delta) })
      else setSourceTime(value => { if (value + delta >= project.source.duration) setPlaying(false); return Math.min(project.source.duration, value + delta) })
    }, 100)
    return () => window.clearInterval(timer)
  }, [playing, videoUrl, mode, total, project.source.kind, project.source.duration])

  const pause = () => { video.current?.pause(); setPlaying(false) }
  const apply = (change: (current: Project) => Project) => {
    pause()
    try {
      const next = commit(historyRef.current, change(historyRef.current.present))
      historyRef.current = next; setHistory(next)
      return true
    } catch (error) { setNotice((error as Error).message === 'invalidRange' ? 'invalidRange' : (error as Error).message === 'splitBoundary' ? 'splitBoundary' : 'invalidProject'); return false }
  }
  const travel = (direction: 'undo' | 'redo') => {
    pause()
    const next = direction === 'undo' ? undo(historyRef.current) : redo(historyRef.current)
    historyRef.current = next; setHistory(next)
  }
  const seek = (nextMode: 'source' | 'program', time: number) => {
    const current = historyRef.current.present
    const bounded = clamp(time, 0, nextMode === 'source' ? current.source.duration : duration(current))
    setMode(nextMode)
    if (nextMode === 'program') {
      setPlayhead(bounded)
      const next = programPosition(current, bounded)
      if (next) { setSelected(next.clip.id); if (video.current) video.current.currentTime = next.sourceTime }
    } else { setSourceTime(bounded); setSelected(sourcePosition(current, bounded, selected)?.clip.id || ''); if (video.current) video.current.currentTime = bounded }
  }
  const chooseClip = (clip: Clip) => { pause(); seek('source', clip.start); setSelected(clip.id); setSourceRange(null); setSelectedCueIds(project.cues.filter(cue => cue.start < clip.end && cue.end > clip.start).map(cue => cue.id)); setTranscriptFocus(current => ({ start: clip.start, end: clip.end, revision: (current?.revision || 0) + 1 })) }
  const seekCue = (cue: Cue) => {
    pause()
    seek('source', cue.start)
  }
  const togglePlay = () => {
    if (playing) { pause(); return }
    if (mode === 'program' && !total) return
    if (project.source.kind === 'local' && !videoUrl) { setNotice('sourceUnavailable'); return }
    if ((mode === 'program' ? playhead >= total : sourceTime >= project.source.duration)) seek(mode, 0)
    if (video.current) void video.current.play().catch(() => { setNotice('mediaError'); setPlaying(false) })
    else setPlaying(true)
  }
  const split = () => {
    if (panelActive) return
    const p = historyRef.current.present
    const at = mode === 'program' ? programPosition(p, playhead) : sourcePosition(p, sourceTime, selected)
    const clip = at?.clip
    if (!clip) { setNotice('splitBoundary'); return }
    const time = mode === 'program' ? programPosition(p, playhead)!.sourceTime : sourceTime
    apply(current => splitClip(current, clip.id, time, crypto.randomUUID()))
  }
  const removeClip = (id: string) => {
    if (panelActive || !id) return
    const next = project.clips.find(clip => clip.id !== id)
    if (apply(current => ({ ...current, clips: current.clips.filter(clip => clip.id !== id) })) && selected === id) {
      if (next) chooseClip(next)
      else { setSelected(''); clearSelection() }
    }
  }
  const remove = () => removeClip(selected)
  const clearSelection = () => { setSourceRange(null); setSelectedCueIds([]) }
  const bookmark = (time: number, label: string) => apply(current => {
    const marks = current.bookmarks || []
    const existing = marks.find(item => Math.abs(item.time - time) < .05)
    return { ...current, bookmarks: existing ? marks.filter(item => item.id !== existing.id) : [...marks, { id: crypto.randomUUID(), time: Math.round(time * 1000) / 1000, label }] }
  })
  const add = (sentences?: Cue[]) => {
    if (panelActive) return
    const ranges = sentences ? rangesFromCues(historyRef.current.present.cues, sentences.map(cue => cue.id)) : pendingRanges
    if (!ranges.length) { setNotice('chooseRange'); return }
    const ids = ranges.map(() => crypto.randomUUID())
    const name = sentences?.[0]?.text.trim().slice(0, 40) || ui('manualClip')
    if (!apply(current => appendManualClips(current, ranges, ids, name))) return
    clearSelection(); seek('source', ranges[0].start); setSelected(ids[0])
  }
  const mark = (edge: 'in' | 'out') => {
    setSelectedCueIds([])
    if (edge === 'in') {
      const start = Math.min(currentSource, project.source.duration - MIN_CLIP)
      setSourceRange({ start, end: sourceRange && sourceRange.end > start + MIN_CLIP ? sourceRange.end : Math.min(project.source.duration, start + 30) })
    } else {
      if (currentSource < MIN_CLIP) { setNotice('invalidRange'); return }
      setSourceRange({ start: sourceRange && sourceRange.start < currentSource - MIN_CLIP ? sourceRange.start : Math.max(0, currentSource - 30), end: currentSource })
    }
  }
  const save = async () => {
    const snapshot = historyRef.current.present, raw = JSON.stringify(snapshot)
    try {
      const stored = await localService.current?.save(snapshot)
      if (integrated && snapshot.source.kind === 'local' && !stored) throw new Error('service_unavailable')
      if (stored) await onSaved?.(stored)
      if (!integrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored || snapshot))
      setSaved(raw); setNotice('saved')
    } catch (error) { setNotice('storageError'); throw error }
  }
  const saveAll = async () => { try { await save(); await onSavePanel?.() } catch { setNotice('storageError') } }
  useEffect(() => { onSaveReady?.(save) })
  const replaceProject = (next: Project) => {
    pause()
    if (video.current) video.current.currentTime = 0
    onOpened?.(next)
    const fresh = { past: [], present: prepareProject(next), future: [] }
    historyRef.current = fresh; setHistory(fresh); setSelected(sourcePosition(fresh.present, 0)?.clip.id || '')
    setMode('source'); setPlayhead(0); setSourceTime(0); setSaved(''); setQuery(''); setMediaError(false); clearSelection()
  }
  const approveReplace = () => !dirty || window.confirm(ui('replaceConfirm'))
  const importText = async (event: ChangeEvent<HTMLInputElement>, kind: 'srt' | 'draft') => {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    if (file.size > (kind === 'srt' ? 5 : 20) * 1024 * 1024) { setNotice('fileLimit'); return }
    const before = historyRef.current.present
    try {
      const raw = await file.text()
      if (before !== historyRef.current.present) return
      if (kind === 'srt') { const imported = parseSrt(raw, before.source.duration); apply(current => ({ ...current, cues: imported })); setRightTab('subtitles') }
      else {
        const candidate: unknown = JSON.parse(raw)
        if (!validateProject(candidate)) throw new Error('invalidProject')
        if (integrated && (candidate.source.assetId !== before.source.assetId || candidate.source.name !== before.source.name || candidate.source.bytes !== before.source.bytes || Math.abs(candidate.source.duration - before.source.duration) > .001)) { setNotice('sourceLocked'); return }
        if (!approveReplace()) return
        const imported = integrated ? { ...candidate, source: before.source, localId: before.localId, localRevision: before.localRevision } : candidate
        replaceProject(imported)
        const address = localReady ? mediaUrl(imported) : ''
        setVideoUrl(address)
        setNotice(imported.source.kind === 'local' && !address ? 'sourceUnavailable' : null)
      }
    } catch { setNotice(kind === 'srt' ? 'invalidSrt' : 'invalidProject') }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (panelActive) return
      const target = event.target as HTMLElement
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); target.blur(); void saveAll(); return }
      if (event.defaultPrevented || target.closest('input, textarea, select, [contenteditable=true], [role=dialog]')) return
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo') }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); travel('redo') }
      else if (event.code === 'Space') { event.preventDefault(); togglePlay() }
      else if (!modifier && event.key.toLowerCase() === preferences.split) { event.preventDefault(); split() }
      else if (!modifier && event.key.toLowerCase() === preferences.markIn) { event.preventDefault(); mark('in') }
      else if (!modifier && event.key.toLowerCase() === preferences.markOut) { event.preventDefault(); mark('out') }
      else if (!modifier && event.key.toLowerCase() === preferences.bookmark) { event.preventDefault(); bookmark(currentSource, activeCue?.text.trim().slice(0, 60) || ui('bookmark')) }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const tool = (name: IconName, label: MessageKey, action: () => void, disabled = false) => <button className="wb-icon-button" title={ui(label)} aria-label={ui(label)} onClick={action} disabled={disabled || panelActive}><Icon name={name} /></button>
  const openPlatform = async (clipId?: string) => {
    if (!onPlatform || platformBusy || localService.current?.hasTask()) return
    pause(); setPlatformBusy(true)
    try {
      const current = historyRef.current.present
      const persisted = await localService.current?.save(current)
      if (!persisted) throw new Error('service_unavailable')
      setSaved(JSON.stringify(current))
      if (!integrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
      await onSaved?.(persisted); await onPlatform(persisted, clipId)
    } catch { setNotice('serviceError') } finally { setPlatformBusy(false) }
  }


  const library = <aside className="wb-library">{panelActive && workspaceLibrary ? workspaceLibrary : <>
            <div className="wb-panel-title"><h2>{ui('selectedClips')}</h2><span>{String(project.clips.length).padStart(2, '0')}</span></div>
            <div className="wb-search"><Icon name="search" size={15} /><input aria-label={ui('search')} placeholder={ui('search')} value={query} onChange={event => setQuery(event.target.value)} /></div><div className="wb-clip-list">
              {project.clips.filter(clip => clip.name.toLowerCase().includes(query.toLowerCase())).map(clip => <article className={`wb-library-clip ${selected === clip.id ? 'is-selected' : ''}`} key={clip.id} style={{ '--clip-color': clipColor(project.clips.indexOf(clip)) } as CSSProperties}><button className="wb-clip-select" aria-pressed={selected === clip.id} onClick={() => chooseClip(clip)}>
                <div className="wb-clip-cover"><span className="wb-clip-number">{String(project.clips.indexOf(clip) + 1).padStart(2, '0')}</span><span className="wb-mini-poster">{project.source.assetId ? <img src={`/api/workbench/assets/${project.source.assetId}/thumbnail?time=${clip.start}`} alt="" loading="lazy" /> : <Icon name="film" size={22} />}</span><span className="wb-origin-badge">{ui(clip.origin === 'ai' ? 'aiPicks' : clip.origin === 'manual' ? 'manualClip' : 'selectedClips')}</span><span className="wb-duration-badge">{formatTime(clip.end - clip.start).slice(3)}</span></div>
                <div className="wb-clip-card-body"><strong>{clip.name}</strong><div><span><span className="wb-clip-source-label">{ui(clip.origin === 'ai' ? 'aiPicks' : 'manualClip')}</span> · {ui('source')} {formatTime(clip.start)}</span><span className="wb-clip-arrow"><Icon name="arrow" size={14} /></span></div></div>
              </button><button className="wb-clip-delete" aria-label={`${ui('delete')} ${clip.name}`} title={ui('delete')} onClick={() => removeClip(clip.id)}><Icon name="trash" size={15} /></button></article>)}
              {!project.clips.some(clip => clip.name.toLowerCase().includes(query.toLowerCase())) && <p className="wb-empty-copy">{ui(project.clips.length || query ? 'noMatches' : 'emptySequence')}</p>}
              <button className="wb-button wb-clip-open-output" disabled={!selectedClip || platformBusy} onClick={() => void openPlatform(selected)}>{ui('clipEditor')}</button><button className="wb-add-clip" disabled={!pendingRanges.length} title={ui('chooseRange')} onClick={() => add()}><Icon name="plus" size={16} />{ui('add')}</button>
            </div>
            <div className="wb-library-footer" hidden={integrated}><Icon name="shield" size={15} /><div><b>{ui('localOnly')}</b><p>{ui('localHint')}</p></div></div>
          </>}</aside>
  const preview = <section className="wb-preview">
            <div className="wb-preview-heading">{!integrated && <div className="wb-segmented"><button className={mode === 'source' ? 'is-active' : ''} onClick={() => { pause(); seek('source', currentSource) }}>{ui('source')}</button><button className={mode === 'program' ? 'is-active' : ''} onClick={() => { pause(); const mapped = sourcePosition(project, currentSource, selected); seek('program', mapped?.time ?? playhead) }}>{ui('program')}</button></div>}<span className="wb-preview-resolution">{project.source.width || '—'} × {project.source.height || '—'}</span></div>
            <div className="wb-stage">
              {videoUrl && !mediaError ? <video ref={video} src={videoUrl} playsInline preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => { setMediaError(true); setPlaying(false); setNotice('mediaError') }} onLoadedMetadata={() => { if (video.current) video.current.currentTime = currentSource }} onTimeUpdate={() => {
                const player = video.current; if (!player) return
                if (mode === 'source') { setSourceTime(player.currentTime); return }
                const at = programPosition(project, playhead); if (!at) return
                if (player.currentTime >= at.clip.end - 0.015) {
                  const next = project.clips[at.index + 1]
                  if (next && playing) { player.currentTime = next.start; setPlayhead(at.offset + at.clip.end - at.clip.start); setSelected(next.id) }
                  else { player.pause(); setPlayhead(Math.min(total, at.offset + at.clip.end - at.clip.start)) }
                } else { setPlayhead(at.offset + clamp(player.currentTime - at.clip.start, 0, at.clip.end - at.clip.start)); setSelected(at.clip.id) }
              }} onEnded={() => setPlaying(false)} /> : project.source.kind === 'demo' ? <div className="wb-demo-poster"><div className="wb-poster-orbit wb-orbit-one" /><div className="wb-poster-orbit wb-orbit-two" /><div className="wb-poster-top"><span className="wb-live-dot" />LOCAL STUDIO<span>01 / 03</span></div><div className="wb-poster-copy"><span className="wb-poster-eyebrow">THE HIGHLIGHT COLLECTION</span><h1>{ui('demoTitle').split('\n').map((line, index) => <span key={index}>{line}</span>)}</h1><span className="wb-poster-line" /><p>STORIES WORTH KEEPING.</p></div><div className="wb-poster-bottom"><span>EDIT. REFINE. REPLAY.</span><span>✳</span></div></div> : <div className="wb-empty-preview"><Icon name="film" size={38} /><p>{ui(mediaError ? 'mediaError' : 'sourceUnavailable')}</p>{onHome && <button className="wb-button" onClick={onHome}>{ui('projectList')}</button>}</div>}
              {activeCue && (!videoUrl ? project.source.kind === 'demo' : true) && <div className="wb-preview-caption">{activeCue.text}</div>}
              {!videoUrl && <span className="wb-preview-label">{ui(project.source.kind === 'demo' ? 'demoVisual' : 'sourceUnavailable')}</span>}
            </div>
            <div className="wb-player-controls"><span className="wb-timecode">{formatTime(mode === 'program' ? playhead : sourceTime, true)}<span> / {formatTime(mode === 'program' ? total : project.source.duration)}</span></span><div className="wb-transport">{tool('previous', 'previous', () => { const index = project.clips.findIndex(clip => clip.id === selected); chooseClip(project.clips[Math.max(0, index - 1)]) }, !project.clips.length)}<button className="wb-play-button" aria-label={ui(playing ? 'pause' : 'play')} title={ui(playing ? 'pause' : 'play')} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} size={21} /></button>{tool('next', 'next', () => { const index = project.clips.findIndex(clip => clip.id === selected); chooseClip(project.clips[Math.min(project.clips.length - 1, index + 1)]) }, !project.clips.length)}</div><span className="wb-player-label">{ui(mode === 'program' ? 'program' : 'source')}</span></div>

          </section>
  const inspector = <aside className="wb-inspector"><div className="wb-inspector-tabs"><button className={rightTab === 'subtitles' ? 'is-active' : ''} onClick={() => setRightTab('subtitles')}><Icon name="text" size={16} />{ui('subtitles')}<span>{project.cues.length}</span></button><button className={rightTab === 'range' ? 'is-active' : ''} onClick={() => setRightTab('range')}><Icon name="sliders" size={16} />{ui('range')}</button></div>
            {rightTab === 'subtitles' ? <TranscriptPanel focusRequest={transcriptFocus} selectionColor={clipColor(project.clips.findIndex(clip => clip.id === selected))} cues={project.cues} time={currentSource} selectedIds={selectedCueIds} ui={ui} onSeek={seekCue} onSelect={ids => { setSourceRange(null); setSelectedCueIds(ids) }} onAdd={sentences => add(sentences)} onImport={() => srtInput.current?.click()}
              onEdit={(id, text) => apply(current => ({ ...current, cues: current.cues.map(cue => cue.id === id ? { ...cue, text } : cue) }))}
              onDeleteSelected={ids => apply(current => ({ ...current, cues: current.cues.filter(cue => !ids.includes(cue.id)) }))}
              onDelete={id => { apply(current => ({ ...current, cues: current.cues.filter(cue => cue.id !== id) })); setSelectedCueIds(ids => ids.filter(item => item !== id)) }}
              canDownload={subtitles.length > 0} onDownload={() => { const text = exportSrt(historyRef.current.present); if (onTextDownload) void onTextDownload('edited-subtitles.srt', text).catch(() => window.alert(ui('serviceError'))); else download(text, 'edited-subtitles.srt', 'application/x-subrip;charset=utf-8') }}
              bookmarks={project.bookmarks || []} onBookmark={bookmark} onBookmarkSeek={time => { pause(); seek('source', time) }}
              onBookmarkEdit={(id, label) => apply(current => ({ ...current, bookmarks: (current.bookmarks || []).map(item => item.id === id ? { ...item, label } : item) }))}
              onBookmarkDelete={id => apply(current => ({ ...current, bookmarks: (current.bookmarks || []).filter(item => item.id !== id) }))} /> : selectedClip ? <ClipSettings clip={selectedClip} max={project.source.duration} ui={ui} onApply={(start, end, name) => apply(current => ({ ...trimClip(current, selectedClip.id, start, end), clips: trimClip(current, selectedClip.id, start, end).clips.map(clip => clip.id === selectedClip.id ? { ...clip, name: name.trim() || clip.name } : clip) }))} /> : <p className="wb-empty-copy">{ui('chooseClip')}</p>}
          </aside>
  const timeline = <SourceTimeline unified={integrated} project={project} outputs={timelineOutputs} outputsLabel={outputsLabel} onOutput={onOutput} editable={!panelActive} time={panelActive ? panelTime ?? currentSource : currentSource} selected={selected} ranges={pendingRanges} playing={playing} ui={ui} outputDuration={total}
          onSeek={time => { pause(); if (panelActive) onPanelSeek?.(time); else seek('source', time) }}
          onRange={range => { setSelectedCueIds([]); setSourceRange(range) }}
          onClip={(id, time) => { const clip = project.clips.find(item => item.id === id); if (clip) chooseClip(clip); seek('source', time) }}
          onCueDelete={id => apply(current => ({ ...current, cues: current.cues.filter(cue => cue.id !== id) }))} onClipDelete={remove} onTrim={(id, start, end) => apply(current => trimClip(current, id, start, end))} onCueTrim={(id, start, end) => apply(current => ({ ...current, cues: current.cues.map(cue => cue.id === id ? { ...cue, start, end } : cue).sort((a, b) => a.start - b.start) }))} onMark={mark} onClear={clearSelection} onAdd={() => add()}
          tools={<>
            {tool('undo', 'undo', () => travel('undo'), !history.past.length)}
            {tool('redo', 'redo', () => travel('redo'), !history.future.length)}
            <span className="wb-tool-divider" />
            <button className="wb-tool-button" onClick={split} disabled={panelActive || !selectedClip}><Icon name="cut" size={17} />{ui('split')}<kbd>{preferences.split.toUpperCase()}</kbd></button>
            {tool('trash', 'delete', remove, !selectedClip)}
            <span className="wb-tool-divider" />
            {tool('previous', 'left', () => apply(current => moveClip(current, selected, -1)), !selectedClip || project.clips[0]?.id === selected)}
            {tool('next', 'right', () => apply(current => moveClip(current, selected, 1)), !selectedClip || project.clips[project.clips.length - 1]?.id === selected)}
          </>} />
  return <div className="wb-app">
    <input ref={srtInput} type="file" accept=".srt" hidden onChange={event => void importText(event, 'srt')} />
    <input ref={draftInput} type="file" accept=".json" hidden onChange={event => void importText(event, 'draft')} />
    {integrated ? <header className="wb-header wb-project-header">
      <label className="wb-project-title">{ui('projectName')}<input aria-label={ui('projectName')} maxLength={200} value={project.title} onChange={event => apply(current => ({ ...current, title: event.target.value }))} /></label>
      <div className="cclip-workspace-tasks" data-workspace-tasks>{activity && <LocalTaskProgress activity={activity} ui={ui} onCancel={() => localService.current?.cancel()} />}{workspaceTasks}</div><details className="wb-file-menu"><summary>{ui('projectFiles')}</summary><div><button className="wb-button" onClick={() => draftInput.current?.click()}>{ui('importProjectFile')}</button><button className="wb-button" onClick={() => download(JSON.stringify(historyRef.current.present, null, 2), 'cclip-edit.json', 'application/json')}>{ui('exportProjectFile')}</button><p>{ui('projectFileHint')}</p></div></details>
      {panelActive ? <div key="clip-actions" className="wb-header-actions" ref={onPanelHeaderHost} /> : <div key="source-actions" className="wb-header-actions"><button className="wb-button" disabled={!localReady} onClick={() => void saveAll()}><Icon name="save" size={16} />{ui('saveProject')}</button><div className="wb-export-action"><button className="wb-button wb-button-accent" disabled={Boolean(activity) || !localReady || !project.source.assetId || !project.clips.length} onClick={() => { pause(); localService.current?.export(historyRef.current.present) }}><Icon name="download" size={16} />{ui('exportVideo')}</button></div></div>}
    </header> : <>    <header className={`wb-header ${activity?.kind === 'export' ? 'has-export-task' : ''}`}>
      <div className="wb-brand">{onHome ? <button className="wb-text-button" onClick={onHome} aria-label={ui('home')}><img src="./cclip-mark.svg" width="25" height="25" alt="CClip" /></button> : <span className="wb-brand-icon"><Icon name="cut" size={21} /></span>}<span>{ui('workbench')}</span></div>
      <div className="wb-header-status" hidden={panelActive}><span className={`wb-status-dot ${dirty ? 'is-dirty' : ''}`} />{ui(dirty ? 'unsaved' : 'saved')}</div>
      {onPlatform && !panelActive && <button className="wb-button wb-button-accent" title={ui('platformHint')} disabled={panelActive || platformBusy || Boolean(activity) || !localReady || !project.source.assetId || !project.clips.length} onClick={() => void openPlatform()}>{ui('platformOutput')}</button>}
      <div className="wb-header-actions" style={panelActive ? { display: 'none' } : undefined}>{!integrated && <select aria-label={ui('language')} value={language} onChange={event => setLanguage(event.target.value as Language)}>{languages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>}<button className="wb-button" disabled={panelActive || integrated && !localReady} onClick={() => void saveAll()}><Icon name="save" size={16} />{ui('save')}</button><div className="wb-export-action"><button className="wb-button wb-button-accent" disabled={panelActive || Boolean(activity) || !localReady || !project.source.assetId || !project.clips.length} title={ui(localReady ? 'exportVideo' : 'exportHint')} onClick={() => { pause(); localService.current?.export(historyRef.current.present) }}><Icon name="download" size={16} />{ui('exportVideo')}</button>{activity?.kind === 'export' && <LocalTaskProgress activity={activity} ui={ui} onCancel={() => localService.current?.cancel()} />}</div></div>
    </header>
    <div className="wb-project-bar"><div className="wb-project-path"><Icon name="folder" size={16} /><span>{ui('localProject')}</span><Icon name="chevron" size={13} /><input disabled={panelActive} aria-label={ui('projectName')} maxLength={200} value={project.title} onChange={event => apply(current => ({ ...current, title: event.target.value }))} /><span className="wb-demo-badge">{ui(project.source.kind === 'demo' ? 'demo' : 'localOnly')}</span></div><div className="wb-project-actions"><button disabled={panelActive} className="wb-text-button" onClick={() => draftInput.current?.click()}>{ui('openDraft')}</button><button disabled={panelActive} className="wb-text-button" onClick={() => download(JSON.stringify(historyRef.current.present, null, 2), 'editing-draft.json', 'application/json')}>{ui('downloadDraft')}<Icon name="download" size={14} /></button></div></div>
    {workspaceControls}
</>}
    <div hidden={panelActive}><LocalServiceControls headerProgress={integrated} locked={panelActive} onProjects={integrated ? onHome : undefined} ref={localService} project={project} selectedClipId={selected} ui={ui} onReady={setLocalReady}
      onDownload={onDownload} onSettings={onSettings} onActivity={setActivity}
      onOpen={value => { replaceProject(value); setVideoUrl(mediaUrl(value)); setNotice(null) }}
      onResult={value => { apply(() => value); clearSelection() }}
      onCleanup={suggestions => { apply(current => removeSourceRanges(current, suggestions)); clearSelection() }} /></div>
    <div className="wb-body">
      <nav className="wb-rail" aria-label={ui('workbench')}><button className={`wb-rail-button ${!panelActive ? 'is-active' : ''}`} title={ui('selectedClips')} aria-label={ui('selectedClips')} onClick={() => onEditSource?.()}><Icon name="film" size={21} /><span>{ui('selectedClips')}</span></button>{onShowOutputs && <button className={`wb-rail-button ${panelActive ? 'is-active' : ''}`} onClick={() => { pause(); if (!panelActive && !workspacePanel && onPlatform && project.clips.length) void openPlatform(selected || undefined); else onShowOutputs() }} aria-label={outputsLabel}><Icon name="film" size={21} /><span>{outputsLabel}</span></button>}<div className="wb-rail-bottom"><Icon name="shield" size={20} /></div></nav>
      <div className="wb-main cclip-work-area" hidden={!panelActive}>{workspacePanel}</div>{!panelActive && (integrated ? <WorkspaceLayout preview={preview} library={library} inspector={inspector} timeline={timeline} labels={[ui('splitPreview'), ui('splitPanels'), ui('splitTimeline')]} /> : <div className="wb-main"><div className="wb-editing-grid">{library}{preview}{inspector}</div>{timeline}</div>)}
    </div>
    {notice && <div className="wb-notice" role="status"><Icon name={notice === 'saved' ? 'check' : 'shield'} size={17} /><span>{ui(integrated && notice === 'saved' ? 'projectSaved' : notice)}</span><button aria-label={ui('close')} className="wb-icon-button" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}
  </div>
}
