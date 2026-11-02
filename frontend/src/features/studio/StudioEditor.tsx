import { useTranslation } from 'react-i18next'
import { t } from '../../i18n'
import { isCClip } from '../../cclip/runtime'
import { ct } from '../../cclip/messages'
import StudioDownloadLink from './StudioDownloadLink'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import StudioDock from '../../cclip/StudioDock'
import type { Language as UiLanguage } from '../workbench/strings'
import { translate } from '../workbench/strings'
import { useNavigate, useParams } from 'react-router-dom'
import { Btn, Dialog, ProgressLine, Row, fmtDuration } from '../../ui'
import { studioApi, errorText, type SourcePreview } from './api'
import { useWorkspace } from './useWorkspace'
import PlayerBar from './PlayerBar'
import { CropPoint, Draft, Scene, SubtitleCue, draftDuration, draftError, moveScene, applyCandidate, portraitDesign, cropAt, frameModeAt, patchShot } from './types'
import CandidatePicker from './CandidatePicker'
import TitleArtwork from './TitleArtwork'
import DraftVariantDialog from './DraftVariantDialog'
import { isArtworkStyle } from './titlePresets'
import DraftSettingsPanel, { type FramingState } from './DraftSettingsPanel'
import { draftExportState } from './draftExportState'
import { trimScene, removeSceneRange, editSceneRanges, addSceneRange } from './sceneEditing'
import { useEditorPreferences } from '../workbench/editorPreferences'
import PackagingPreview, { packagingCanvas } from './PackagingPreview'
import HtmlPackagingPreview from './HtmlPackagingPreview'
import { resolveDraftTemplate } from './TemplateSetting'
import { workspaceTasks, type WorkspaceTask } from '../../cclip/WorkspaceTasks'
import './studio.css'

export default function StudioEditor() {
  const { id, draftId } = useParams()
  return <Editor key={`${id}:${draftId}`} projectId={id!} draftId={draftId!} />
}
function Editor({ projectId, draftId }: { projectId: string; draftId: string }) {
  return <StudioEditorPanel projectId={projectId} draftId={draftId} />
}

export function StudioEditorPanel({ projectId, draftId, embedded = false, workbench = false, activeEditor = true, externalLocked = false, initialDraft, language = 'zh', library, color, headerHost, auxiliary, initialInspector, publishClipId, sourceAssetId, onSaveProject, onDeleteOutput, onSaveReady, onDirtyChange, onCoverChanged, onTasks, onNavigate, onSaved, onTime, seekRequest }: {
  workbench?: boolean; activeEditor?: boolean; externalLocked?: boolean; initialDraft?: Draft; language?: UiLanguage; library?: ReactNode; color?: string; headerHost?: HTMLDivElement | null; auxiliary?: ReactNode; initialInspector?: string; publishClipId?: string; sourceAssetId?: string
  onDeleteOutput?: () => void; onSaveProject?: () => Promise<void>; onSaveReady?: (save: (() => Promise<Draft>) | null) => void; onDirtyChange?: (dirty: boolean) => void; onCoverChanged?: (url?: string) => void
  projectId: string; draftId: string; embedded?: boolean; onNavigate?: (path: string) => void
  onSaved?: () => void; onTime?: (time: number) => void; seekRequest?: { time: number; serial: number }
  onTasks?: (tasks: WorkspaceTask[]) => void
}) {
  useTranslation()
  const [preferences] = useEditorPreferences()
  const routerNavigate = useNavigate()
  const navigate = onNavigate || routerNavigate
  const { workspace, error: loadError, loading, refresh } = useWorkspace(projectId)
  const [draft, setDraft] = useState<Draft | null>(initialDraft || null)
  const [saved, setSaved] = useState(initialDraft ? JSON.stringify(initialDraft) : '')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [instruction, setInstruction] = useState('')
  const [selected, setSelected] = useState(0)
  const [picker, setPicker] = useState<number | 'append' | null>(null)
  const [sourceDuration, setSourceDuration] = useState<number>()
  const [showVariant, setShowVariant] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showRendered, setShowRendered] = useState(false)
  const [playbackError, setPlaybackError] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<SourcePreview>({status: 'idle'})
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [currentTime, setCurrentTime] = useState(initialDraft?.scenes[0]?.start || 0)
  const [sourceAspect, setSourceAspect] = useState(16 / 9)
  const pendingSeek = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [renderedDuration, setRenderedDuration] = useState(0)
  const [framing, setFraming] = useState<FramingState>({ busy: false })
  const taskSnapshot = JSON.stringify([...workspaceTasks(workspace),
    ...(['queued', 'running'].includes(sourcePreview.status) ? [{ id: 'source-preview', label: ct('previewTask') }] : []),
    ...(framing.busy || framing.status?.status === 'installing' ? [{ id: 'framing', label: ct('framingTask'), progress: framing.status?.status === 'installing' ? framing.status.progress : undefined }] : [])])
  useEffect(() => { onTasks?.(JSON.parse(taskSnapshot)) }, [taskSnapshot, onTasks])
  useEffect(() => () => onTasks?.([]), [onTasks])
  useEffect(() => {
    const controller = new AbortController()
    studioApi.subtitles(projectId, controller.signal).then(v => setCues(v.cues)).catch(() => setCues([]))
    studioApi.framingStatus().then(status => setFraming(f => ({ ...f, status }))).catch(() => undefined)
    return () => controller.abort()
  }, [projectId])
  useEffect(() => {
    if (framing.status?.status !== 'installing') return
    const timer = window.setInterval(() => {
      studioApi.framingStatus().then(status => setFraming(f => ({ ...f, status }))).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [framing.status?.status])
  useEffect(() => {
    if (!['queued', 'running'].includes(sourcePreview.status)) return
    let cancelled = false
    const timer = window.setInterval(() => {
      studioApi.previewStatus(projectId).then(state => {
        if (cancelled) return
        setSourcePreview(state)
        if (state.status === 'completed') setPlaybackError(false)
      }).catch(error => { if (!cancelled) setSourcePreview({status:'failed', error:errorText(error)}) })
    }, 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [projectId, sourcePreview.status])
  const preparePreview = async () => {
    setSourcePreview({status:'queued'})
    try {
      const state = await studioApi.preparePreview(projectId)
      setSourcePreview(state)
      if (state.status === 'completed') setPlaybackError(false)
    } catch(error) { setSourcePreview({status:'failed', error:errorText(error)}) }
  }

  /** Centre every scene's crop window on the speaker; scenes without a face keep their value. */
  const autoFrame = async (target?: Draft, trigger: 'auto' | 'manual' | 'portrait_preset' = 'manual') => {
    const base = target || draft
    if (!base || framing.status?.status !== 'installed') return
    setFraming(f => ({ ...f, busy: true, error: undefined }))
    try {
      const result = await studioApi.autoFrame(projectId, base, trigger)
      const found = new Map(result.scenes.filter(s => s.crop_x !== null).map(s => [s.id, s]))
      setDraft(current => current ? { ...current, scenes: current.scenes.map(sc => { const f = found.get(sc.id); return f ? { ...sc, crop_x: f.crop_x, crop_track: f.crop_track, framing_source: 'auto' as const, framing_adjusted: false } : sc }) } : current)
      setShowRendered(false)
      setFraming(f => ({ ...f, busy: false, result: { framed: found.size, total: result.scenes.length, shots: result.scenes.reduce((n, s) => n + (s.crop_track?.length ?? 0), 0), fit: result.scenes.reduce((n, s) => n + s.fit_shots, 0) } }))
    } catch (e) { setFraming(f => ({ ...f, busy: false, error: t(errorText(e)) })) }
  }
  const installFraming = async () => {
    try { const status = await studioApi.framingInstall(); setFraming(f => ({ ...f, status })) }
    catch (e) { setFraming(f => ({ ...f, error: t(errorText(e)) })) }
  }
  // Once the runtime lands (or the user switches to a cropped layout), frame automatically the first time.
  const cropping = !!draft && draft.aspect !== 'original' && draft.layout === 'crop'
  useEffect(() => {
    if (!cropping || framing.busy || framing.result || framing.status?.status !== 'installed') return
    if (draft?.scenes.some(s => s.crop_x != null || s.crop_track?.length)) return
    void autoFrame(undefined, 'auto')
  }, [cropping, framing.status?.status])
  /** Edit only the shot under the playhead; the rest of the scene's track stays as detected. */
  const setShot = (sceneId: string, changes: Partial<CropPoint>) => {
    if (draft) patch({ scenes: draft.scenes.map(sc => sc.id === sceneId ? { ...patchShot(sc, editingTime, changes, draft.crop_x ?? .5), framing_source: sc.framing_source || 'manual', framing_adjusted: true } : sc) })
  }
  const applyPortrait = () => {
    if (!draft) return
    const next = portraitDesign(draft)
    patch(next)
    setFraming(f => ({ ...f, result: undefined }))
    void autoFrame(next, 'portrait_preset')
  }

  const [suggestion, setSuggestion] = useState<Draft | null>(null)
  const [undoStack, setUndoStack] = useState<Draft[]>([])
  const [redoStack, setRedoStack] = useState<Draft[]>([])
  const undo = undoStack[undoStack.length - 1]
  const redoDraft = redoStack[redoStack.length - 1]
  const setUndo = (value: Draft) => { setUndoStack(items => [...items.slice(-99), value]); setRedoStack([]) }
  const video = useRef<HTMLVideoElement>(null)
  const localKey = `autoclip.studio.${projectId}.${draftId}`
  const dirty = !!draft && JSON.stringify(draft) !== saved
  const artworkStyle = isArtworkStyle(draft?.title_style)
  const scene = draft?.scenes[selected] || draft?.scenes[0]
  // The preview transport runs on the clip's own timeline: 0 = scene start (or rendered clip start).
  const playBase = draft?.scenes.slice(0, selected).reduce((sum, value) => sum + value.end - value.start, 0) || 0
  const editingTime = showRendered ? (scene?.start || 0) + currentTime - playBase : currentTime
  const playLength = showRendered ? renderedDuration : draft ? draftDuration(draft) : 0
  const togglePlay = () => { const v = video.current; if (!v) return; if (v.paused) { if (!showRendered && scene && v.currentTime >= scene.end - .03 && draft) seekSource(draft.scenes[0].start); void v.play().catch(() => undefined) } else v.pause() }
  const jobs = workspace.jobs.filter(j => j.draft_id === draftId)
  const exportState = draft ? draftExportState(draft, jobs) : undefined
  const currentJob = !dirty ? exportState?.completed || exportState?.failure : undefined
  const active = jobs.find(j => j.status === 'queued' || j.status === 'running')

  useEffect(() => {
    if (draft) return
    const raw = workspace.drafts.find(d => d.id === draftId)
    if (!raw) return
    const server = resolveDraftTemplate(raw, workspace)
    setSaved(JSON.stringify(server))
    try {
      const cached = JSON.parse(localStorage.getItem(localKey) || 'null') as Draft | null
      if (!embedded && cached && cached.revision === server.revision && cached.id === server.id && !draftError(cached)) {
        setDraft(cached); setNotice("已恢复本机暂存的修改，请保存后导出"); return
      }
    } catch { /* A damaged local cache must never hide the server draft. */ }
    setDraft(server)
  }, [workspace, draftId, draft])
  useEffect(() => {
    if (!draft) return
    try { if (dirty && !embedded) localStorage.setItem(localKey, JSON.stringify(draft)); else localStorage.removeItem(localKey) } catch { setNotice("本机暂存不可用，请及时保存草稿") }
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft, dirty])
  useEffect(() => {
    if (!embedded) return
    const protect = (event: Event) => {
      if ((event as CustomEvent<{ sameClip?: boolean }>).detail?.sameClip) return
      if (dirty && !window.confirm(ct('discardChanges'))) event.preventDefault()
    }
    window.addEventListener('cclip-before-navigate', protect)
    return () => window.removeEventListener('cclip-before-navigate', protect)
  }, [dirty, embedded])
  useEffect(() => {
    if (!seekRequest || !draft || !video.current) return
    const index = draft.scenes.findIndex(item => item.start <= seekRequest.time && seekRequest.time < item.end)
    if (index < 0) return
    pendingSeek.current = seekRequest.time
    setSelected(index); setShowRendered(false); video.current.pause()
    video.current.currentTime = seekRequest.time; setCurrentTime(seekRequest.time)
  }, [seekRequest])
  useEffect(() => {
    if (!video.current || !scene || showRendered) return
    const requested = pendingSeek.current
    const target = requested !== null && requested >= scene.start && requested < scene.end ? requested : scene.start
    video.current.currentTime = target
    setCurrentTime(target)
    if (video.current.readyState >= 1) pendingSeek.current = null
  }, [scene?.id, scene?.start, scene?.end, showRendered])
  useEffect(() => { if (draft) setMuted(!draft.original_audio) }, [draft?.original_audio])
  const patch = (changes: Partial<Draft>) => { if (draft) { setDraft({...draft, ...changes}); setUndo(draft); setShowRendered(false); setError('') } }
  const undoOnce = () => { if (undo && draft) { setRedoStack(items => [...items, draft]); setDraft({ ...undo, revision: draft.revision }); setUndoStack(items => items.slice(0, -1)); setSelected(0); setShowRendered(false) } }
  const redoOnce = () => { if (redoDraft && draft) { setUndoStack(items => [...items, draft]); setDraft({ ...redoDraft, revision: draft.revision }); setRedoStack(items => items.slice(0, -1)); setSelected(0); setShowRendered(false) } }
  const save = async (): Promise<Draft> => {
    if (!draft) throw new Error(t("草稿不存在"))
    const invalid = draftError(draft, sourceDuration)
    if (invalid) throw new Error(t(invalid))
    if (!dirty) return draft
    const result = await studioApi.save(projectId, draft)
    setDraft(result); setSaved(JSON.stringify(result)); setNotice(workbench ? ct('projectSaved') : '草稿已保存'); refresh(); onSaved?.()
    return result
  }
  const perform = async (kind: string, action: () => Promise<void>) => {
    setBusy(kind); setError('')
    try { await action() } catch (e) { setError(t(errorText(e))) } finally { setBusy('') }
  }
  const render = async () => {
    await perform('render', async () => {
      await onSaveProject?.()
      const savedDraft = await save()
      await studioApi.export(projectId, savedDraft.id, savedDraft.revision, savedDraft)
      refresh(); setNotice("渲染已开始，可以离开页面，之后在导出记录查看")
    })
  }
  const rewrite = async () => {
    if (!draft || !instruction.trim()) return
    await perform('rewrite', async () => setSuggestion(await studioApi.rewrite(projectId, draft, instruction.trim())))
  }
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => { onSaveReady?.(save) })
  useEffect(() => () => { onSaveReady?.(null); onDirtyChange?.(false) }, [onSaveReady, onDirtyChange])
  useEffect(() => { if (!activeEditor || externalLocked) { video.current?.pause(); setPlaying(false) } }, [activeEditor, externalLocked])
  const seekSource = (time: number) => {
    if (!draft) return
    const index = draft.scenes.findIndex(scene => scene.start <= time && time < scene.end)
    if (index < 0) return
    pendingSeek.current = time; setSelected(index); setShowRendered(false); setCurrentTime(time)
    if (video.current) { video.current.pause(); video.current.currentTime = time }
  }
  const splitScene = () => {
    if (!draft || !scene || editingTime - scene.start < .12 || scene.end - editingTime < .12 || draft.scenes.length >= 30) return
    const right = { ...trimScene(scene, editingTime, scene.end), id: crypto.randomUUID() }
    const left = trimScene(scene, scene.start, editingTime)
    pendingSeek.current = editingTime; setCurrentTime(editingTime)
    patch({ scenes: draft.scenes.flatMap((item, index) => index === selected ? [left, right] : [item]) }); setSelected(selected + 1)
  }
  const trim = (id: string, start: number, end: number) => {
    if (!draft) return
    video.current?.pause()
    patch({ scenes: draft.scenes.map(value => value.id === id ? trimScene(value, start, end) : value) })
    pendingSeek.current = Math.min(Math.max(currentTime, start), end - .01)
    setCurrentTime(pendingSeek.current)
  }
  const cutRange = (range: { start: number; end: number }) => {
    if (!draft) return false
    const scenes = removeSceneRange(draft.scenes, range)
    if (!scenes.length || scenes.length > 30) { setError(ct('keepClipContent')); return false }
    video.current?.pause(); patch({ scenes }); setSelected(0); pendingSeek.current = scenes[0].start; setCurrentTime(scenes[0].start)
    return true
  }
  const captionRanges = (ranges: { start: number; end: number }[], keep: boolean) => {
    if (!draft || !ranges.length) return false
    const scenes = editSceneRanges(draft.scenes, ranges, keep)
    if (!scenes.length || scenes.length > 30) { setError(ct('keepClipContent')); return false }
    video.current?.pause(); patch({ scenes }); setSelected(0)
    pendingSeek.current = scenes[0].start; setCurrentTime(scenes[0].start)
    return true
  }
  const addRange = (range: { start: number; end: number }) => {
    if (!draft || range.end - range.start < .12) return false
    const base = draft.scenes[selected] || draft.scenes[0]
    const next = { ...draft, scenes: addSceneRange(draft.scenes, range, base) }
    const invalid = draftError(next, sourceDuration)
    if (invalid) { setError(t(invalid)); return false }
    video.current?.pause(); patch({ scenes: next.scenes }); setSelected(next.scenes.findIndex(item => item.start <= range.start && item.end >= range.end))
    pendingSeek.current = range.start; setCurrentTime(range.start); return true
  }
  useEffect(() => {
    if (!workbench || !activeEditor || busy || externalLocked) return
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return
      if (event.code === 'Space') { if (event.target instanceof Element && event.target.closest('button')) return; event.preventDefault(); togglePlay() }
      else if (event.key.toLowerCase() === preferences.split && !event.ctrlKey && !event.metaKey) { event.preventDefault(); splitScene() }
      else if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void perform('save', async () => { await onSaveProject?.(); await save() }) }
      else if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && draft) { event.preventDefault(); if (event.shiftKey) redoOnce(); else undoOnce() }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  })
  if (!draft) return <div className="ac-page"><button className="ac-back" onClick={() => navigate(`/project/${projectId}`)}>{t("‹ 返回项目")}</button><div className="ac-empty"><b>{loading ? t("加载成片草稿…") : t("无法打开草稿")}</b>{loadError || (!loading && t("草稿不存在或已移除"))}<Btn onClick={refresh}>{t("重试")}</Btn></div></div>
  const previewUrl = currentJob?.status === 'completed' ? studioApi.video(projectId, currentJob.job_id) : ''
  const activeCue = (draft.subtitle_cues ?? draft.packaging?.cues ?? cues).find(c => c.start <= currentTime && currentTime < c.end)
  const updateScene = (i: number, update: Partial<Scene>) => patch({ scenes: draft.scenes.map((s, index) => index === i ? {...s,...update} : s) })
  const frameAspect = draft.aspect === 'portrait' ? 9 / 16 : draft.aspect === 'landscape' ? 16 / 9 : sourceAspect
  const windowed = !showRendered && draft.aspect === 'portrait' && draft.layout === 'window' && !!draft.packaging
  const cinematic = !showRendered && draft.packaging?.style === 'cinematic'
  const player = <div className="studio-editor-sticky"><div className={`studio-stage studio-stage--${draft.aspect}`}>
        <div className={`studio-video-frame${windowed ? ' studio-pack-window' : ''}${cinematic ? ' studio-pack-cinematic' : ''}`} style={{aspectRatio: frameAspect, background: draft.packaging?.palette ? packagingCanvas(draft.packaging.palette) : undefined}}>
          <video ref={video} preload="metadata" playsInline muted={muted} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setPlaybackError(true)} onLoadedData={() => setPlaybackError(false)} src={showRendered && previewUrl ? previewUrl : sourcePreview.status === 'completed' && sourcePreview.version ? studioApi.compatibleSource(projectId, sourcePreview.version) : studioApi.source(projectId)} style={{...(windowed ? { top: '29.1667%', height: '42.1875%' } : {}), objectFit: windowed ? scene?.crop_x != null || scene?.crop_track?.length ? 'cover' : 'contain' : showRendered || draft.layout!=='crop' || frameModeAt(scene, currentTime)==='fit'?'contain':'cover', objectPosition:`${cropAt(scene, currentTime, draft.crop_x ?? .5)*100}% 50%`}} onClick={togglePlay} onLoadedMetadata={() => { const v = video.current; if (!v) return; if (showRendered) setRenderedDuration(v.duration); else if (scene) { setSourceDuration(v.duration); setSourceAspect(v.videoWidth / Math.max(1, v.videoHeight)); v.currentTime = pendingSeek.current ?? scene.start; setCurrentTime(v.currentTime); pendingSeek.current = null } }} onTimeUpdate={() => {const v=video.current; if(!v) return; setCurrentTime(v.currentTime); if (!showRendered) onTime?.(v.currentTime); else { let offset = v.currentTime; for (let i = 0; i < draft.scenes.length; i++) { const part = draft.scenes[i], length = part.end - part.start; if (offset < length || i === draft.scenes.length - 1) { setSelected(i); onTime?.(Math.min(part.end, part.start + offset)); break } offset -= length } } if(scene && !showRendered && v.currentTime >= scene.end) { const next = draft.scenes[selected + 1]; if (next && !v.paused) { pendingSeek.current = next.start; setSelected(selected + 1); v.currentTime = next.start; setCurrentTime(next.start) } else { v.pause(); if (Math.abs(v.currentTime - scene.end) > .005) v.currentTime = scene.end; setCurrentTime(scene.end) } }}} />
          {!showRendered && !draft.packaging && draft.subtitles && activeCue && <div className={`studio-caption-overlay studio-caption studio-caption--${draft.subtitle_style || 'clean'}`}>{activeCue.text}</div>}
          {!showRendered && !draft.packaging && selected===0 && draft.hook && !artworkStyle && <div className={`studio-hook studio-hook--${draft.title_style || 'plain'}`}>{draft.hook}</div>}
          {!showRendered && !draft.packaging && selected===0 && draft.hook && artworkStyle && <TitleArtwork projectId={projectId} draft={draft}/>}
          {!showRendered && draft.packaging && (['editorial', 'street'].includes(draft.packaging.template) ? <HtmlPackagingPreview video={video} draft={draft} time={playBase + currentTime - (scene?.start || 0)} /> : <PackagingPreview packaging={{ ...draft.packaging, cues: (draft.subtitle_cues ?? draft.packaging.cues).map(cue => ({ original: '', ...cue })) }} subtitles={draft.subtitles} sourceTime={currentTime} outputTime={playBase + currentTime - (scene?.start || 0)} aspect={frameAspect} />)}
        </div>
        <PlayerBar offset={Math.max(0, Math.min(showRendered ? currentTime : playBase + currentTime - (scene?.start || 0), playLength))} length={playLength} playing={playing} muted={muted}
          onToggle={togglePlay} onMute={() => setMuted(m => !m)}
          onSeek={offset => { if (showRendered) { if (video.current) video.current.currentTime = offset; setCurrentTime(offset) } else { let remaining = offset; for (const part of draft.scenes) { const size = part.end - part.start; if (remaining < size || part === draft.scenes[draft.scenes.length - 1]) { seekSource(Math.min(part.end - .01, part.start + remaining)); break } remaining -= size } } }} />
      </div><div className="studio-row studio-preview-foot">{workbench && !showRendered && <Btn size="sm" title={t('原片无法播放时，可生成兼容预览；原片不变，不调用模型。')} disabled={['queued', 'running'].includes(sourcePreview.status)} onClick={preparePreview}>{t('生成兼容预览')}</Btn>}<span className="studio-muted">{showRendered?t("实际渲染结果"):t("原片预览 · 成片取 {{range}} · 字幕、翻译以渲染结果为准", { range: scene ? `${fmtDuration(scene.start)}–${fmtDuration(scene.end)}` : "" })}</span>{previewUrl ? <Btn size="sm" onClick={() => setShowRendered(!showRendered)}>{showRendered?t("查看原片"):t("播放成片")}</Btn> : <Btn size="sm" disabled={!!active} onClick={render}>{active?t("正在渲染"):t("渲染预览")}</Btn>}</div></div>
  const prompt = <><div className="studio-prompt"><input aria-label={t("文案修改要求")} placeholder={t("告诉 AI 怎么改文案，例如：开头改成一个简短的问题")} value={instruction} onChange={e=>setInstruction(e.target.value)} /><Btn variant="cta" loading={busy==='rewrite'} disabled={!instruction.trim()} onClick={rewrite}>{t("改一版文案")}</Btn></div>
      {undo && <Btn variant="text" onClick={undoOnce}>{t("撤销上次修改")}</Btn>}</>
  const sceneControls = <details className="studio-details studio-source-details"><summary>{t("调整镜头")}{' '}<span className="ac-mono">{draft.scenes.length}</span>{' '}{t("· 顺序与起止点")}</summary>
        <Btn size="sm" disabled={draft.scenes.length >= 30} onClick={() => setPicker('append')}>{t("追加镜头")}</Btn>
        {draft.scenes.map((s,i)=><div className="studio-scene-row" key={s.id}><Btn size="sm" onClick={()=>{setSelected(i);setShowRendered(false)}}>{i+1}. {s.label}</Btn><label>{t("起点（秒）")}<input type="number" min={0} step={.1} value={s.start} onChange={e=>updateScene(i,{start:Number(e.target.value)})}/></label><label>{t("终点（秒）")}<input type="number" min={0} step={.1} value={s.end} onChange={e=>updateScene(i,{end:Number(e.target.value)})}/></label><div className="studio-actions"><Btn size="sm" onClick={() => setPicker(i)}>{t("替换")}</Btn><Btn size="sm" disabled={i===0} onClick={()=>patch({scenes:moveScene(draft,i,-1).scenes})}>{t("上移")}</Btn><Btn size="sm" disabled={i===draft.scenes.length-1} onClick={()=>patch({scenes:moveScene(draft,i,1).scenes})}>{t("下移")}</Btn><Btn size="sm" disabled={draft.scenes.length===1} onClick={()=>{patch({scenes:draft.scenes.filter((_,index)=>index!==i)});setSelected(0)}}>{t("移除")}</Btn></div></div>)}
      </details>
  const settings = <DraftSettingsPanel showCover={!workbench} draft={draft} patch={patch} sourceCues={cues} scene={scene} currentTime={editingTime} onShot={setShot}
        framing={framing} onAutoFrame={() => void autoFrame()} onInstallFraming={() => void installFraming()} onPortrait={applyPortrait}
        coverHref={previewUrl && currentJob ? `/project/${projectId}/publish/studio-${currentJob.job_id}` : undefined}
        onOpenCover={href => navigate(href)} />
  let clipTime = currentTime
  if (showRendered) {
    let offset = Math.max(0, currentTime)
    clipTime = draft.scenes[draft.scenes.length - 1].end - .001
    for (const item of draft.scenes) { const length = item.end - item.start; if (offset < length) { clipTime = item.start + offset; break } offset -= length }
  }
  const dock = <StudioDock active={activeEditor} projectId={projectId} draft={draft} workspace={workspace} language={language} library={library} preview={player} settings={<>{settings}<div className="cclip-settings-save"><p>{ct('applySettingsHint')}</p><Btn variant="cta" disabled={!!busy || externalLocked || !dirty} onClick={() => perform('save', async () => { await onSaveProject?.(); await save() })}>{ct('applySettings')}</Btn></div></>} prompt={prompt} scenes={sceneControls} color={color} currentJob={currentJob} time={clipTime} selected={selected} playing={playing} aspect={draft.aspect === 'portrait' ? 9 / 16 : draft.aspect === 'landscape' ? 16 / 9 : sourceAspect} auxiliary={auxiliary} initialInspector={initialInspector} publishClipId={publishClipId} sourceAssetId={sourceAssetId} sourceDuration={sourceDuration} sourceCues={cues} onAddRange={addRange} onDeleteOutput={onDeleteOutput} locked={!!busy || externalLocked} patch={patch} onSeek={seekSource} onSelect={setSelected} onSplit={splitScene} onTrim={trim} onRemoveRange={cutRange} onCaptionRanges={captionRanges} canSplit={!!scene && editingTime - scene.start >= .12 && scene.end - editingTime >= .12 && draft.scenes.length < 30} onDelete={() => { if (draft.scenes.length > 1) { patch({ scenes: draft.scenes.filter((_, index) => index !== selected) }); setSelected(0) } }} onUndo={undoOnce} canUndo={!!undo} onRedo={redoOnce} canRedo={!!redoDraft} onRefresh={() => { refresh(); onSaved?.() }} onNavigate={navigate} onCoverChanged={onCoverChanged} onSaveCover={save} />
  return <div className={`ac-page studio-editor-page${workbench ? ' cclip-clip-dock' : ''}${embedded ? ' cclip-embedded-editor' : ''}`}>
    {!embedded && <button className="ac-back" onClick={() => navigate(`/project/${projectId}`)}>{t("‹ 返回项目")}</button>}
    {workbench ? headerHost && createPortal(<><Btn disabled={!!busy || externalLocked} onClick={() => setShowVariant(true)}>{t('另存为新版本')}</Btn><Btn disabled={!!busy || externalLocked} onClick={() => perform('save', async () => { await onSaveProject?.(); await save() })}>{ct('saveProject')}</Btn><Btn variant="cta" disabled={!!busy || externalLocked} onClick={() => setShowExport(true)}>{translate(language, 'exportVideo')}</Btn></>, headerHost) : <>    <header className="studio-row studio-editor-head"><div><h1 className="ac-title">{draft.title}</h1><span className="studio-muted">{dirty ? (embedded ? ct('unsaved') : t("有修改未保存 · 本机暂存")) : t("草稿已保存")} · V{draft.revision} · {fmtDuration(draftDuration(draft))}</span></div><div className="studio-actions">{isCClip && !embedded && <Btn disabled={!!busy || externalLocked} onClick={() => perform('timeline', async () => { const current = await save(); navigate(`/project/${projectId}/timeline/${current.id}`) })}>{ct('fullTimeline')}</Btn>}<Btn disabled={!!busy || externalLocked} onClick={() => setShowVariant(true)}>{t("另存为新版本")}</Btn><Btn disabled={!!busy || !dirty} loading={busy==='save'} onClick={() => perform('save', async () => {await save()})}>{t("保存草稿")}</Btn><Btn variant="cta" disabled={!!busy || externalLocked} onClick={() => setShowExport(true)}>{t("导出成片")}</Btn></div></header>
</>}
    {loadError && <p className="studio-error">{t("任务状态暂时无法更新：")}{t(loadError)}</p>}
    {!workbench && !showRendered && (sourcePreview.status !== 'completed' || playbackError) && <details open={playbackError || ['queued', 'running', 'failed'].includes(sourcePreview.status)} className="studio-muted">
      <summary>{t('生成兼容预览')}</summary>
      <p>{t('原片无法播放时，可生成兼容预览；原片不变，不调用模型。')}</p>
      {sourcePreview.error && <p className="studio-error">{t(sourcePreview.error)}</p>}
      <Btn disabled={['queued', 'running'].includes(sourcePreview.status)} onClick={preparePreview}>{t(['queued', 'running'].includes(sourcePreview.status) ? '正在生成兼容预览，长视频可能需要几分钟…' : '生成兼容预览')}</Btn>
    </details>}
    {workbench ? dock : <fieldset disabled={!!busy || externalLocked} className="studio-fieldset"><div className="studio-editor-grid"><section className="studio-editor-main">{player}{prompt}{sceneControls}</section>{settings}</div></fieldset>}
    {!workbench && active && <div className="studio-render-state"><ProgressLine percent={active.percent}/><span className="studio-muted">{active.status==='queued'?t("等待渲染"):t("渲染成片")} · {active.percent}%</span></div>}
    {currentJob?.status==='failed' && <p className="studio-error" role="alert">{t(currentJob.error || '')}</p>}
    {currentJob?.result?.warnings?.map(w=><p className="studio-muted" key={w}>{t(w)}</p>)}
    {error && <p className="studio-error" role="alert">{error}</p>}<p className={workbench ? "cclip-editor-notice" : "studio-muted"} role="status">{t(notice)}</p>
    {picker !== null && <CandidatePicker projectId={projectId} mode={picker === 'append' ? 'append' : 'replace'} onClose={() => setPicker(null)} onChoose={candidate => {
      try {
        const next = applyCandidate(draft, candidate, picker, crypto.randomUUID())
        patch({ scenes: next.scenes }); setSelected(picker === 'append' ? draft.scenes.length : picker)
        setPicker(null); setNotice("镜头已更新，请保存后重新渲染。换镜头后请核对开头文案是否仍符合画面。")
      } catch(e) { setPicker(null); setError(t(errorText(e))) }
    }} />}
    <DraftVariantDialog open={showVariant} projectId={projectId} draft={draft} onClose={() => setShowVariant(false)} onCreated={created => { setShowVariant(false); onSaved?.()
      try { localStorage.removeItem(localKey) } catch { /* The new server draft is already durable. */ }
      navigate(`/project/${projectId}/studio/${created.id}`)
    }} />
    <Dialog open={!!suggestion} onClose={()=>setSuggestion(null)} title={t("查看文案修改")} description={t("确认后应用到当前草稿，镜头与声音保持原设置。")} footer={<div className="studio-actions"><Btn onClick={()=>setSuggestion(null)}>{t("保留原稿")}</Btn><Btn variant="cta" onClick={()=>{setUndo(draft);setDraft(suggestion);setSuggestion(null);setShowRendered(false)}}>{t("应用修改")}</Btn></div>}><p>{suggestion?.title}</p><p>{suggestion?.hook || t("无开头文字")}</p></Dialog>
    <Dialog open={showExport} onClose={()=>!busy && setShowExport(false)} title={t("导出成片")} description={t("保存当前修改并渲染；已有输出会保留在导出记录。")} footer={<div className="studio-actions"><Btn disabled={!!busy || externalLocked} onClick={()=>setShowExport(false)}>{t("关闭")}</Btn>{previewUrl && <Btn onClick={()=>navigate(`/project/${projectId}/publish/studio-${currentJob!.job_id}`)}>{isCClip ? ct("coverAndPublish") : t("发布这版成片")}</Btn>}{previewUrl ? <StudioDownloadLink className="ac-btn ac-btn--cta" projectId={projectId} jobId={currentJob!.job_id}/> : <Btn variant="cta" loading={busy==='render'||!!active} disabled={!!active} onClick={render}>{t("确认导出")}</Btn>}</div>}>
      <p className="studio-muted" role="note">{ct('exportEditHint')}</p><Btn onClick={() => setShowExport(false)}>{ct('reviewWorkbench')}</Btn>
      <Row label={t("格式")}>MP4 · 30 fps</Row><fieldset disabled={!!busy || externalLocked || !!active} className="studio-fieldset cclip-export-settings">{settings}</fieldset>
      {currentJob?.status==='completed' && !!currentJob.result?.warnings?.length && <div role="status" className="studio-muted">{currentJob.result.warnings.map(w=><p key={w}>{t(w)}</p>)}</div>}
      {active && <ProgressLine percent={active.percent}/>}<p className="studio-muted">{previewUrl?t("当前版本已渲染完成，可以直接下载。"):t("任务在后台继续，关闭面板不会取消渲染。")}</p>{error && <p className="studio-error">{error}</p>}{currentJob?.status==='failed'&&<p className="studio-error">{t(currentJob.error || '')}</p>}
    </Dialog>
  </div>
}
