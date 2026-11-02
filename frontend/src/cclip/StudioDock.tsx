import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { t } from '../i18n'
import { Btn, Dialog } from '../ui'
import WorkspaceLayout from '../features/workbench/WorkspaceLayout'
import SourceTimeline from '../features/workbench/SourceTimeline'
import { useEditorPreferences } from '../features/workbench/editorPreferences'
import { exportSrt, rangesFromCues, type Project, type TimeRange } from '../features/workbench/model'
import TranscriptPanel from '../features/workbench/TranscriptPanel'
import { translate, type Language } from '../features/workbench/strings'
import type { Draft, RenderJob, SubtitleCue, Workspace } from '../features/studio/types'
import ExportHistory from '../features/studio/ExportHistory'
import PlatformPicker from '../features/studio/PlatformPicker'
import { studioApi, errorText } from '../features/studio/api'
import { ct } from './messages'
import { saveCClipText } from '../features/studio/nativeDownload'
import DraftCover from './DraftCover'

interface Props {
  projectId: string; draft: Draft; workspace: Workspace; language: Language; library: ReactNode; preview: ReactNode; settings: ReactNode; scenes: ReactNode; prompt: ReactNode
  sourceCues: SubtitleCue[]; sourceAssetId?: string; sourceDuration?: number; locked?: boolean; color?: string; currentJob?: RenderJob; time: number; selected: number; playing: boolean; aspect: number; auxiliary?: ReactNode; initialInspector?: string; publishClipId?: string
  patch: (changes: Partial<Draft>) => void; onSeek: (time: number) => void; onSelect: (index: number) => void; onSplit: () => void; canSplit: boolean; onTrim: (id: string, start: number, end: number) => void; onRemoveRange: (range: TimeRange) => boolean; onDelete: () => void; onUndo: () => void; canUndo: boolean
  onRedo: () => void; canRedo: boolean; onDeleteOutput?: () => void
  onAddRange: (range: TimeRange) => boolean; onRefresh: () => void; onNavigate: (path: string) => void; onCoverChanged?: (url?: string) => void
  onSaveCover: () => Promise<Draft>
  onCaptionRanges: (ranges: TimeRange[], keep: boolean) => boolean
  active: boolean
}

export default function StudioDock(props: Props) {
  const { draft, workspace, projectId, language } = props
  const [preferences] = useEditorPreferences()
  const [range, setRange] = useState<TimeRange | null>(null)
  const [selectedCueIds, setSelectedCueIds] = useState<string[]>([])
  const [tab, setTab] = useState(props.initialInspector === 'publish' ? 'settings' : props.initialInspector || 'captions')
  const [history, setHistory] = useState(false)
  const [platformsOpen, setPlatformsOpen] = useState(false)
  const [platforms, setPlatforms] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stamp, setStamp] = useState(0)
  const [frameWidth, setFrameWidth] = useState(240)
  const previewBox = useRef<HTMLDivElement>(null)
  useEffect(() => { if (props.initialInspector) setTab(props.initialInspector === 'publish' ? 'settings' : props.initialInspector) }, [props.initialInspector])
  useEffect(() => {
    const box = previewBox.current; if (!box) return
    const observer = new ResizeObserver(() => setFrameWidth(Math.max(100, Math.min(box.clientWidth - 16, (box.clientHeight - 88) * props.aspect))))
    observer.observe(box); return () => observer.disconnect()
  }, [props.aspect])
  const allCues = draft.subtitle_cues ?? draft.packaging?.cues ?? props.sourceCues
  const filtered = allCues
    .filter(cue => draft.scenes.some(scene => cue.start < scene.end && cue.end > scene.start))
  const cueTime = (cue: SubtitleCue) => Math.max(cue.start, draft.scenes.find(scene => cue.start < scene.end && cue.end > scene.start)?.start || 0)
  const editCue = (index: number, changes: Partial<SubtitleCue>) => {
    if (changes.start !== undefined || changes.end !== undefined) setSelectedCueIds([])
    const cue = filtered[index]
    const next = allCues.map(item => item === cue ? { ...item, ...changes } : item).sort((a, b) => a.start - b.start)
    props.patch({ subtitle_cues: next, ...(draft.packaging ? { packaging: { ...draft.packaging, cues: next.map(item => ({ original: '', ...item })) } } : {}) })
  }
  const start = Math.min(...draft.scenes.map(scene => scene.start)), end = Math.max(...draft.scenes.map(scene => scene.end))
  const bounds = useRef({ start, end })
  bounds.current = { start: Math.min(bounds.current.start, start), end: Math.max(bounds.current.end, end) }
  const project: Project = { schemaVersion: 1, title: draft.title, source: { assetId: props.sourceAssetId, name: draft.title, kind: 'local', duration: props.sourceDuration || end }, clips: draft.scenes.map((scene, index) => ({ id: scene.id, name: scene.label, start: scene.start, end: scene.end, color: index })), cues: filtered.map((cue, index) => ({ ...cue, id: String(index), start: Math.max(cue.start, bounds.current.start), end: Math.min(cue.end, bounds.current.end) })), bookmarks: draft.caption_bookmarks }
  const captionRanges = rangesFromCues(project.cues, selectedCueIds)
  const toggleBookmark = (time: number, label: string) => { const marks = draft.caption_bookmarks || []; const found = marks.find(mark => Math.abs(mark.time - time) < .05); props.patch({ caption_bookmarks: found ? marks.filter(mark => mark.id !== found.id) : [...marks, { id: crypto.randomUUID(), time, label }] }) }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!props.active || props.locked || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]'))) return
      if (event.key.toLowerCase() === preferences.bookmark) { event.preventDefault(); toggleBookmark(props.time, filtered.find(cue => cue.start <= props.time && cue.end > props.time)?.text.trim().slice(0, 60) || '') }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  })
  const ui = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(language, key, values)
  const variant = workspace.output_variants?.find(item => item.draft_id === draft.id)
  const changed = (url?: string) => { setStamp(Date.now()); props.onCoverChanged?.(url); props.onRefresh() }
  const inspector = <aside className="wb-inspector cclip-dock-inspector">
    <div className="wb-inspector-tabs">{[['captions', ui('subtitles')], ['settings', ct('frameAndCover')]].map(([value, label]) => <button className={tab === value && !props.auxiliary ? 'is-active' : ''} key={value} onClick={() => { if (props.auxiliary) props.onNavigate(`/project/${projectId}/studio/${draft.id}`); setTab(value) }}>{label}</button>)}</div>
    {props.auxiliary ? <div className="cclip-dock-settings">{props.auxiliary}</div> : tab === 'captions' ? <div className="cclip-dock-captions">
      <TranscriptPanel cues={project.cues} time={props.time} selectedIds={selectedCueIds} selectionColor={props.color} ui={ui}
        onSeek={cue => props.onSeek(cueTime(filtered[Number(cue.id)]))}
        onSelect={ids => { setRange(null); setSelectedCueIds(ids) }}
        onEdit={(id, text) => editCue(Number(id), { text })}
        onDeleteSelected={ids => { const removed = new Set(ids.map(id => filtered[Number(id)])); const next = allCues.filter(cue => !removed.has(cue)); props.patch({ subtitle_cues: next, ...(draft.packaging ? { packaging: { ...draft.packaging, cues: next.map(item => ({ original: '', ...item })) } } : {}) }) }}
        onDelete={id => { const cue = filtered[Number(id)]; const next = allCues.filter(item => item !== cue); setSelectedCueIds([]); props.patch({ subtitle_cues: next, ...(draft.packaging ? { packaging: { ...draft.packaging, cues: next.map(item => ({ original: '', ...item })) } } : {}) }) }}
        onRemove={() => { if (props.onCaptionRanges(captionRanges, false)) { setSelectedCueIds([]); setRange(null) } }}
        onKeep={() => { if (props.onCaptionRanges(captionRanges, true)) { setSelectedCueIds([]); setRange(null) } }}
        onDownload={() => { void saveCClipText('clip-subtitles.srt', exportSrt(project)).catch(() => setError(ct('storageFailed'))) }} canDownload={project.cues.length > 0}
        bookmarks={(draft.caption_bookmarks || []).filter(mark => mark.time >= bounds.current.start && mark.time <= bounds.current.end)}
        onBookmark={toggleBookmark}
        onBookmarkSeek={props.onSeek} onBookmarkEdit={(id, label) => props.patch({ caption_bookmarks: (draft.caption_bookmarks || []).map(mark => mark.id === id ? { ...mark, label } : mark) })}
        onBookmarkDelete={id => props.patch({ caption_bookmarks: (draft.caption_bookmarks || []).filter(mark => mark.id !== id) })} />
    </div> : <div className="cclip-dock-settings cclip-picture-cover">{props.settings}{props.prompt}
      <DraftCover key={draft.id} projectId={projectId} draft={draft} workspace={workspace} currentTime={props.time} fallback={variant?.cover ? studioApi.variantCover(projectId, variant.id, stamp) : undefined} onSave={props.onSaveCover} onRefresh={props.onRefresh} onNavigate={props.onNavigate} onChanged={url => changed(url)} />
    </div>}
  </aside>
  const timeline = <SourceTimeline unified markShortcuts color={props.color} bounds={bounds.current} project={project} selected={draft.scenes[props.selected]?.id || ''} time={props.time} ranges={range ? [range] : captionRanges} playing={props.playing} ui={ui} outputDuration={draft.scenes.reduce((sum, scene) => sum + scene.end - scene.start, 0)} editable={!props.locked} selectionActionLabel={ct('removeRange')} emptyRangeHint={ct('clipRangeHint')} onTrim={props.onTrim} onCueTrim={(id, start, end) => editCue(Number(id), { start, end })} onCueDelete={id => { const cue = filtered[Number(id)]; const next = allCues.filter(item => item !== cue); props.patch({ subtitle_cues: next, ...(draft.packaging ? { packaging: { ...draft.packaging, cues: next.map(item => ({ original: '', ...item })) } } : {}) }) }} onClipDelete={draft.scenes.length > 1 ? props.onDelete : props.onDeleteOutput} onAddRange={range ? () => { if (props.onAddRange(range)) setRange(null) } : undefined} onSeek={props.onSeek} onClip={(id, time) => { const scene = draft.scenes.find(item => item.id === id); props.onSelect(draft.scenes.findIndex(item => item.id === id)); props.onSeek(time); setRange(null); if (scene) setSelectedCueIds(project.cues.filter(cue => cue.start < scene.end && cue.end > scene.start).map(cue => cue.id)) }} onRange={value => { setSelectedCueIds([]); setRange(value) }} onMark={edge => { setSelectedCueIds([]); setRange(current => edge === 'in' ? { start: props.time, end: Math.max(props.time, current?.end || props.time) } : { start: Math.min(props.time, current?.start ?? props.time), end: props.time }) }} onClear={() => { setRange(null); setSelectedCueIds([]) }} onAdd={() => { if (range ? props.onRemoveRange(range) : props.onCaptionRanges(captionRanges, false)) { setRange(null); setSelectedCueIds([]) } }} tools={<><button className="wb-icon-button" disabled={!props.canUndo} onClick={props.onUndo} aria-label={ui('undo')}>↶</button><button className="wb-icon-button" disabled={!props.canRedo} onClick={props.onRedo} aria-label={ui('redo')}>↷</button><button className="wb-tool-button" disabled={!props.canSplit} onClick={props.onSplit}>{ui('split')} <kbd>{preferences.split.toUpperCase()}</kbd></button><button className="wb-tool-button" disabled={draft.scenes.length < 2 && !props.onDeleteOutput} onClick={draft.scenes.length > 1 ? props.onDelete : props.onDeleteOutput}>{ui('delete')}</button></>} />
  return <><fieldset className="cclip-dock-fieldset" disabled={props.locked}><WorkspaceLayout labels={[ct('splitPreview'), ct('splitPanels'), ct('splitTimeline')]} preview={<div className="cclip-dock-preview" ref={previewBox} style={{ '--frame-width': `${frameWidth}px` } as CSSProperties}>{props.preview}</div>} library={<aside className="wb-library cclip-dock-library">{props.library}<div className="cclip-clip-tools"><Btn size="sm" onClick={() => setHistory(true)}>{t('导出记录')}</Btn><Btn size="sm" onClick={() => setPlatformsOpen(true)}>{t('追加平台版本')}</Btn></div>{props.scenes}</aside>} inspector={inspector} timeline={timeline} /></fieldset>
    <ExportHistory projectId={projectId} jobs={workspace.jobs} open={history} onClose={() => setHistory(false)} />
    <Dialog open={platformsOpen} title={t('追加平台版本')} onClose={() => setPlatformsOpen(false)}><PlatformPicker value={platforms} onChange={setPlatforms} disabled={busy} /><Btn disabled={!platforms.length || busy} onClick={async () => { setBusy(true); setError(''); try { await studioApi.appendPlatforms(projectId, platforms, workspace.generation?.branding.outro_enabled ?? true); setPlatformsOpen(false); props.onRefresh() } catch (e) { setError(t(errorText(e))) } finally { setBusy(false) } }}>{t('生成追加版本')}</Btn>{error && <p role="alert">{error}</p>}</Dialog>
  </>
}
