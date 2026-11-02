import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Workbench from '../features/workbench/Workbench'
import '../features/workbench/workbench.css'
import { LocalClient, type LocalRecord } from '../features/workbench/localApi'
import type { Project } from '../features/workbench/model'
import { cclipRequest, navigateCClip } from './runtime'
import { ct } from './messages'
import { languages, translate, type Language } from '../features/workbench/strings'
import { isDesktopDownload, saveLocalMediaUrl, saveCClipText } from '../features/studio/nativeDownload'
import { useWorkspace } from '../features/studio/useWorkspace'
import { StudioEditorPanel } from '../features/studio/StudioEditor'
import { resolveDraftTemplate } from '../features/studio/TemplateSetting'
import ExportHistory from '../features/studio/ExportHistory'
import ProjectCatalog from './ProjectCatalog'
import { studioApi } from '../features/studio/api'
import WorkspaceLayout from '../features/workbench/WorkspaceLayout'
import { WorkbenchNavigation } from './Navigation'
import { outputStart, outputGroups, timelineOutputs } from './outputs'
import { t } from '../i18n'
import WorkspaceTasks, { workspaceTasks, type WorkspaceTask } from './WorkspaceTasks'
import { platformLabel } from '../features/studio/platformLabel'
import './cclip.css'
import './theme.css'

type View = 'source' | 'outputs' | 'edit'
type OutputGroup = ReturnType<typeof outputGroups>[number]

export default function WorkbenchPage({ initialView = 'source' }: { initialView?: View }) {
  const { i18n } = useTranslation()
  const { id, draftId, clipId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const view = (['outputs', 'edit'].includes(params.get('view') || '') ? params.get('view') : initialView) as View
  const originalRoute = location.pathname.startsWith('/project/')
  const [project, setProject] = useState<Project | null>(null)
  const [editingProject, setEditingProject] = useState<Project>()
  const [origin, setOrigin] = useState<string>()
  const [linkedDraft, setLinkedDraft] = useState<string>()
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState(false)
  const [importing, setImporting] = useState(false)
  const [reload, setReload] = useState(0)
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null)
  const [clipDirty, setClipDirty] = useState(false)
  const [editorOpened, setEditorOpened] = useState(view !== 'source')
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({})
  const [removalBusy, setRemovalBusy] = useState(false)
  const [removalUndo, setRemovalUndo] = useState<string | null | undefined>(undefined)
  const [outputError, setOutputError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const saveClip = useRef<(() => Promise<unknown>) | null>(null)
  const rememberClip = useCallback((save: (() => Promise<unknown>) | null) => { saveClip.current = save }, [])
  useEffect(() => { if (view !== 'source') setEditorOpened(true) }, [view])
  const saveProject = useRef<() => Promise<void>>(async () => undefined)
  const rememberSave = useCallback((save: () => Promise<void>) => { saveProject.current = save }, [])
  const [coverStamp, setCoverStamp] = useState(0)
  const [panelTime, setPanelTime] = useState(0)
  const [seekRequest, setSeekRequest] = useState<{ time: number; serial: number }>()
  const { workspace, refresh } = useWorkspace(origin)
  const [editorTasks, setEditorTasks] = useState<WorkspaceTask[]>([])
  const rememberTasks = useCallback((tasks: WorkspaceTask[]) => { setEditorTasks(tasks); refresh() }, [refresh])
  useEffect(() => { setRemovalUndo(undefined); setOutputError(''); setHistoryOpen(false) }, [origin])
  const videoInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const packagingChanged = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!importing) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [importing])
  useEffect(() => {
    let live = true
    setError(false); setProject(null); setEditingProject(undefined)
    const open = async () => {
      if (!id) { setOrigin(undefined); return }
      if (originalRoute) {
        if (live) setOrigin(id)
        const record = await cclipRequest<LocalRecord>(`/api/cclip/projects/${encodeURIComponent(id)}/timeline`, 'POST', { draftId: null })
        if (live) { setOrigin(id); setLinkedDraft(undefined); setSaved(true); packagingChanged.current = false }
        return record.project
      }
      const client = new LocalClient(); await client.connect()
      const value = await client.open(id)
      const context = await cclipRequest<{ projectId: string | null; draftId: string | null; saved: boolean }>(`/api/cclip/workbench/${id}/context`)
      if (live) { setOrigin(context.projectId || undefined); setLinkedDraft(context.draftId || undefined); setSaved(context.saved) }
      return context.projectId ? (await cclipRequest<LocalRecord>(`/api/cclip/projects/${context.projectId}/timeline`, 'POST', { draftId: null })).project : value
    }
    void open().then(value => { if (live && value) setProject(value) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [id, originalRoute, reload])
  useEffect(() => {
    if (!id || !originalRoute || project || workspace.analysis?.status !== 'running') return
    const timer = window.setInterval(() => setReload(value => value + 1), 4000)
    return () => window.clearInterval(timer)
  }, [id, originalRoute, project, workspace.analysis?.status])
  useEffect(() => {
    if (!project?.localId) return
    const localId = project.localId
    return () => { void cclipRequest(`/api/cclip/workbench/${localId}/unsaved`, 'DELETE').catch(() => undefined) }
  }, [project?.localId])

  const sourceSignal = JSON.stringify([workspace.analysis?.status, workspace.generation?.status, workspace.drafts.length])
  useEffect(() => {
    if (!origin || !project?.localId) return
    let live = true
    let timer: number | undefined
    let attempt = 0
    const sync = () => { void cclipRequest<LocalRecord>(`/api/cclip/projects/${origin}/timeline`, 'POST', { draftId: null })
      .then(record => { if (live) { setProject(current => current?.localId === record.id ? record.project : current); refresh() } })
      .catch(() => { if (live) timer = window.setTimeout(sync, Math.min(15000, 1500 * 2 ** Math.min(attempt++, 4))) }) }
    sync()
    return () => { live = false; window.clearTimeout(timer) }
  }, [origin, project?.localId, sourceSignal, refresh])
  const groups = outputGroups(workspace, editingProject || project || undefined)
  const selectedId = (originalRoute ? (draftId !== 'source' ? draftId : undefined) : params.get('draft') || linkedDraft)
  const selectedDraft = selectedId ? workspace.drafts.find(item => item.id === selectedId) : groups.find(group => !group.archived)?.drafts[0]
  const selectedGroup = groups.find(group => group.drafts.some(item => item.id === selectedDraft?.id))
  const undoRemoval = removalUndo === undefined ? workspace.cclip_removed_output_group?.undoId : removalUndo
  const outputProcessing = workspace.jobs.some(job => ['queued', 'running'].includes(job.status)) || ['queued', 'running'].includes(workspace.analysis?.status || '') || ['screening', 'production', 'rendering'].includes(workspace.generation?.status || '')
  const go = (path: string, withinProject = false, sameClip = false) => navigateCClip(navigate, path, { withinProject, sameClip })
  const path = (mode: View, targetDraft = selectedDraft?.id, extra = '') => {
    const base = originalRoute ? `/project/${id}/timeline/${targetDraft || 'source'}` : `/workbench/${id}`
    return `${base}?view=${mode}${!originalRoute && targetDraft ? '&draft=' + encodeURIComponent(targetDraft) : ''}${extra}`
  }
  const switchView = (mode: View) => { go(path(mode), true, true); setCoverStamp(Date.now()); refresh() }
  const openDraft = (value: string) => {
    const target = workspace.drafts.find(item => item.id === value)
    if (target) setPanelTime(outputStart(target))
    go(path('edit', value), true, value === selectedDraft?.id)
  }
  const openTool = (target: string) => {
    const editor = target.match(/^\/project\/([^/]+)\/(?:studio|timeline)\/([^/?]+)/)
    if (editor && editor[1] === origin) { openDraft(editor[2]); return }
    if (origin && target === `/project/${origin}`) { switchView('edit'); return }
    if (origin && target.includes('/publish')) { switchView('edit'); return }
    go(target)
  }
  const removeOutput = async (group: OutputGroup) => {
    if (!origin || removalBusy || !window.confirm(ct('deleteOutputConfirm'))) return
    setRemovalBusy(true); setOutputError('')
    try {
      if (clipDirty && group.drafts.some(draft => draft.id === selectedDraft?.id)) {
        if (!saveClip.current) throw new Error('editor_not_ready')
        await saveClip.current()
      }
      const latest = await studioApi.get(origin)
      const identifiers = new Set(group.drafts.map(draft => draft.id))
      const drafts = group.drafts.map(item => { const draft = latest.drafts.find(draft => draft.id === item.id); if (!draft) throw new Error('revision_conflict_or_busy'); return { id: draft.id, revision: draft.revision } })
      const result = await cclipRequest<{ undoId: string }>(`/api/cclip/projects/${origin}/outputs/remove`, 'POST', { drafts })
      setRemovalUndo(result.undoId); refresh()
      if (identifiers.has(selectedDraft?.id || '')) go(path('edit', latest.drafts.find(draft => !identifiers.has(draft.id))?.id || ''), true, true)
    } catch (error) { setOutputError(ct((error as Error).message === 'revision_conflict_or_busy' ? 'outputBusy' : 'outputDeleteFailed')); refresh() }
    finally { setRemovalBusy(false) }
  }
  const restoreOutput = async () => {
    if (!origin || !undoRemoval || removalBusy) return
    setRemovalBusy(true); setOutputError('')
    try {
      const result = await cclipRequest<{ draftId: string }>(`/api/cclip/projects/${origin}/outputs/restore`, 'POST', { undoId: undoRemoval })
      setRemovalUndo(null); refresh()
      if (!workspace.drafts.length) go(path('edit', result.draftId), true, true)
    } catch (error) { setOutputError(ct((error as Error).message === 'revision_conflict_or_busy' ? 'outputBusy' : 'outputRestoreFailed')); refresh() }
    finally { setRemovalBusy(false) }
  }
  useEffect(() => {
    if (!undoRemoval || clipDirty || removalBusy || view === 'source') return
    const undoDeletedOutput = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true],[role=dialog]')) return
      event.preventDefault(); event.stopImmediatePropagation(); void restoreOutput()
    }
    window.addEventListener('keydown', undoDeletedOutput, true)
    return () => window.removeEventListener('keydown', undoDeletedOutput, true)
  })
  const output = async (value: Project, clip?: string) => {
    if (!value.localId || !value.localRevision) throw new Error('unsaved')
    const linked = await cclipRequest<{ projectId: string; draftId: string }>(`/api/cclip/workbench/${value.localId}/platform-drafts`, 'POST', { revision: value.localRevision, ...(clip ? { clipId: clip } : {}) })
    setOrigin(linked.projectId); setLinkedDraft(linked.draftId)
    go(path('edit', linked.draftId), true)
    refresh()
  }
  const markSaved = async (value: Project) => {
    await cclipRequest(`/api/cclip/workbench/${value.localId}/saved`, 'POST', { revision: value.localRevision })
    setSaved(true)
  }
  const importVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || importing) return
    setImporting(true); setError(false)
    try {
      const client = new LocalClient(); await client.connect(); const imported = await client.import(file)
      if (alive.current) navigate(`/workbench/${imported.localId}`)
    } catch { if (alive.current) setError(true) } finally { if (alive.current) setImporting(false) }
  }
  if (!id) return <main className="cclip-home cclip-project-hub"><header className="cclip-hub-actions"><input ref={videoInput} type="file" accept="video/*,.mp4,.mov,.mkv,.webm" hidden onChange={event => void importVideo(event)} /><button className="ac-btn ac-btn--cta" disabled={importing} onClick={() => videoInput.current?.click()}>{ct(importing ? 'importing' : 'chooseVideo')}</button>{error && <p role="alert">{ct('importFailed')}</p>}</header><ProjectCatalog /></main>
  if (!project) return <div className="cclip-loading" role="status"><p>{ct(error ? 'sourceNotReady' : 'loading')}</p><button className="ac-btn" onClick={() => setReload(value => value + 1)}>{t('重试')}</button><button className="ac-btn" onClick={() => navigate('/workbench')}>{ct('home')}</button></div>
  const language = languages.some(([code]) => code === i18n.language) ? i18n.language as Language : 'en'
  const renderCard = (group: OutputGroup) => {
    const item = group.drafts.find(draft => draft.id === selectedDraft?.id) || group.drafts[0]
    const variants = workspace.output_variants?.filter(variant => group.drafts.some(draft => draft.id === variant.draft_id)) || []
    const variant = variants.find(value => value.draft_id === item?.id) || variants[0]
    const cover = item ? coverUrls[item.id] || workspace.cclip_draft_covers?.[item.id]?.url || (variant ? studioApi.variantCover(origin!, variant.id, coverStamp) : '') : ''
    const start = item ? outputStart(item) : group.source?.start || 0
    const title = item?.title || group.source?.name || ''
    const frame = `/api/workbench/assets/${project.source.assetId}/thumbnail?time=${start}`
    const open = async () => {
      if (item) { openDraft(item.id); return }
      try {
        const client = new LocalClient(); await client.connect()
        await output(await client.open(project.localId!), group.source?.id)
      } catch { setOutputError(ct('outputBusy')) }
    }
    return <article className={`cclip-output-card${selectedGroup?.key === group.key ? ' is-active' : ''}`} key={group.key} data-source-id={group.source?.id} data-archived={group.archived || undefined} style={{ borderLeftColor: group.color, '--clip-color': group.color } as CSSProperties}><button className="cclip-output-select" onClick={() => void open()}><span className="cclip-output-number">{group.archived ? '·' : String(group.number).padStart(2, '0')}</span><img key={cover || frame} className="cclip-output-cover" src={cover || frame} alt={t('封面')} loading="lazy" onError={event => { if (!event.currentTarget.dataset.fallback) { event.currentTarget.dataset.fallback = '1'; event.currentTarget.src = frame } }} /><span className="cclip-output-copy"><b>{title}</b><span>{[...new Set(variants.map(value => platformLabel(value.strategy_id)))].join(' · ') || (item?.platform_preset ? platformLabel(item.platform_preset) : t('成片草稿'))}</span><span className="cclip-output-origin">{translate(language, group.origin === 'ai' ? 'aiPicks' : 'manualClip')}</span><span>{Math.floor(start / 60)}:{String(Math.floor(start % 60)).padStart(2, '0')}{item ? ` · ${t('{{count}} 段', { count: item.scenes.length })}` : ` · ${ct('prepareOutput')}`}</span></span></button>{item && <button className="cclip-output-delete" disabled={removalBusy || outputProcessing} title={ct('deleteClip')} aria-label={`${ct('deleteClip')} ${title}`} onClick={() => void removeOutput(group)}>×</button>}</article>
  }
  const currentGroups = groups.filter(group => !group.archived), archivedGroups = groups.filter(group => group.archived)
  const library = <><div className="wb-panel-title"><h2>{ct('outputs')}</h2>{undoRemoval && <button className="wb-text-button cclip-output-undo" disabled={removalBusy} onClick={() => void restoreOutput()}>{ct('undoOutputRemoval')}</button>}<span>{currentGroups.length}</span></div>{outputError && <p className="cclip-output-error" role="alert">{outputError}</p>}{selectedGroup && selectedGroup.drafts.length > 0 && <label className="cclip-version-picker">{ct('platformVersions')}<select aria-label={ct('platformVersions')} value={selectedDraft?.id} onChange={event => openDraft(event.target.value)}>{selectedGroup.drafts.map((item, index) => { const variant = workspace.output_variants?.find(value => value.draft_id === item.id); return <option key={item.id} value={item.id}>{variant ? platformLabel(variant.strategy_id) : item.platform_preset ? platformLabel(item.platform_preset) : t('成片草稿')} · {index + 1} · V{item.revision}</option> })}</select></label>}<div className="cclip-output-list">{currentGroups.map(renderCard)}{!currentGroups.length && <p>{t('暂时没有可用成片')}</p>}{archivedGroups.length > 0 && <details className="cclip-archived-outputs" open={selectedGroup?.archived || undefined}><summary>{ct('archivedOutputs')} · {archivedGroups.length}</summary>{archivedGroups.map(renderCard)}</details>}</div>{!selectedDraft && workspace.jobs.length > 0 && <div className="cclip-clip-tools"><button className="wb-button" onClick={() => setHistoryOpen(true)}>{t('导出记录')}</button></div>}</>
  const panel = !editorOpened ? undefined : selectedDraft && origin ? <StudioEditorPanel key={selectedDraft.id} projectId={origin} draftId={selectedDraft.id} embedded workbench externalLocked={removalBusy} activeEditor={view !== 'source'} initialDraft={resolveDraftTemplate(selectedDraft, workspace)} sourceAssetId={project.source.assetId} onDeleteOutput={selectedGroup ? () => void removeOutput(selectedGroup) : undefined} onTasks={rememberTasks} onSaveReady={rememberClip} onDirtyChange={setClipDirty} onCoverChanged={url => { if (url) setCoverUrls(current => ({ ...current, [selectedDraft.id]: url })); setCoverStamp(Date.now()) }} language={language} library={library} color={selectedGroup?.color} headerHost={headerHost} onSaveProject={() => saveProject.current()}  onNavigate={openTool}  publishClipId={params.get('clip') || clipId} onSaved={() => { packagingChanged.current = true; refresh(); setCoverStamp(Date.now()) }} onTime={setPanelTime} seekRequest={seekRequest} />
    : <WorkspaceLayout preview={<div className="wb-empty-preview">{ct('outputHint')}</div>} library={library} inspector={<div className="cclip-panel-empty"><button className="wb-button" onClick={() => switchView('source')}>{ct('sourceEdit')}</button></div>} timeline={<div />} labels={[ct('splitPreview'), ct('splitPanels'), ct('splitTimeline')]} />
  return <WorkbenchNavigation.Provider value={openTool}><div className="cclip-workbench"><Workbench key={`${project.localId}:${reload}`} initialProject={project} onProjectChange={setEditingProject} initialSaved={saved} language={language}
    onHome={() => go('/workbench')} workspacePanelActive={view !== 'source'} hasPanelChanges={clipDirty} onSavePanel={() => saveClip.current?.() || Promise.resolve()} onPanelHeaderHost={setHeaderHost} onSaveReady={rememberSave} onPlatform={output} onSaved={markSaved}
    workspaceTasks={<WorkspaceTasks tasks={[...new Map([...workspaceTasks(workspace), ...editorTasks].map(task => [task.id, task])).values()]} />}
    onOpened={value => { if (value.localId && value.localId !== project.localId) navigate(`/workbench/${value.localId}`) }}
    onTextDownload={saveCClipText} onSettings={() => go('/settings?section=analysis')} onDownload={isDesktopDownload() ? saveLocalMediaUrl : undefined}
    workspacePanel={panel} workspaceLibrary={library} onShowOutputs={() => switchView('edit')} onEditSource={() => { if (view !== 'source') switchView('source') }} outputsLabel={ct('outputs')}
    timelineOutputs={timelineOutputs(workspace, editingProject || project)} onOutput={openDraft} panelTime={panelTime} onPanelSeek={time => { setPanelTime(time); setSeekRequest({ time, serial: Date.now() }) }}
  />{origin && <ExportHistory projectId={origin} jobs={workspace.jobs} open={historyOpen} onClose={() => setHistoryOpen(false)} />}</div></WorkbenchNavigation.Provider>
}
