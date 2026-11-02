import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { formatTime, type Project } from './model'
import { LocalClient, type AnalysisPreview, type LocalJob, type Readiness, type Suggestion } from './localApi'
import type { MessageKey } from './strings'
import LocalTaskProgress, { type LocalTaskActivity } from './LocalTaskProgress'

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string
export interface LocalServiceHandle { save: (project: Project) => Promise<Project | null>; export: (project: Project) => void; cancel: () => void; hasTask: () => boolean }
interface Props {
  headerProgress?: boolean
  locked?: boolean
  onProjects?: () => void
  onDownload?: (url: string) => Promise<void>
  onSettings?: () => void
  onActivity?: (activity: LocalTaskActivity | null) => void
  project: Project; selectedClipId?: string; ui: Translator; onReady: (ready: boolean) => void
  onOpen: (project: Project) => void; onResult: (project: Project) => void; onCleanup: (suggestions: Suggestion[]) => void
}

const LocalServiceControls = forwardRef<LocalServiceHandle, Props>(function LocalServiceControls({ project, selectedClipId, ui, onReady, onOpen, onResult, onCleanup, onDownload, onSettings, onActivity, onProjects, headerProgress = false, locked = false }, ref) {
  const isCClip = typeof document !== 'undefined' && document.querySelector('meta[name="cclip-app"]')?.getAttribute('content') === 'full'
  const client = useRef<LocalClient | null>(null)
  const latestProject = useRef(project); latestProject.current = project
  const resultHandler = useRef(onResult); resultHandler.current = onResult
  const [ready, setReady] = useState<Readiness | null>(null)
  const [message, setMessage] = useState<MessageKey | null>(null)
  const [panel, setPanel] = useState<'projects' | 'settings' | 'cleanup' | null>(() => window.location.hash === '#analysis-settings' ? 'settings' : null)
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([])
  const [job, setJob] = useState<LocalJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingKind, setPendingKind] = useState<LocalJob['kind'] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [burn, setBurn] = useState(true)
  const [exportScope, setExportScope] = useState<'program' | 'selected'>('program')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [model, setModel] = useState('deepseek-flash')
  const [key, setKey] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [prepared, setPrepared] = useState<Project | null>(null)
  const snapshot = useRef('')
  const pipeline = useRef(false)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const stopPipeline = () => { pipeline.current = false; setPipelineRunning(false) }

  useEffect(() => {
    if (document.querySelector('meta[name="workbench-service"]')?.getAttribute('content') !== 'enabled') return
    let live = true
    const connection = new LocalClient()
    void connection.connect().then(status => { if (live) { client.current = connection; setReady(status); onReady(true) } }).catch(() => { if (live) setMessage('serviceUnavailable') })
    return () => { live = false }
  }, [onReady])

  const error = (cause: unknown) => setMessage((cause as Error).message === 'revision_conflict_or_busy' ? 'saveConflict' : 'serviceError')
  const start = async (kind: LocalJob['kind'], value: Project, continuation = false) => {
    const connection = client.current
    if (!connection || !continuation && (pipeline.current || busy || job && ['queued', 'running'].includes(job.status))) return
    if (kind === 'export' && exportScope === 'selected' && !selectedClipId) { setMessage('chooseClip'); return }
    setPendingKind(kind); setBusy(true); setCancelling(false); setMessage(null); setPrepared(null)
    let startedTask = false
    try {
      const record = await connection.save(value)
      let consentId: string | undefined
      if (kind === 'analyze') {
        const settings = await connection.request<{ configured: boolean }>('/api/workbench/analysis-settings')
        if (!settings.configured) { if (onSettings) onSettings(); else setPanel('settings'); return }
        const preview = await connection.request<AnalysisPreview>(`/api/workbench/projects/${record.id}/analysis-preview`)
        if (!window.confirm(ui('analysisConsent', { url: preview.baseUrl, model: preview.model, count: preview.sentences, characters: preview.characters }) + '\n\n' + ui('analysisEdits'))) return
        consentId = (await connection.request<{ consentId: string }>(`/api/workbench/projects/${record.id}/analysis-consent`, 'POST', { revision: record.revision, approved: true })).consentId
      }
      snapshot.current = JSON.stringify(value)
      const started = await connection.request<LocalJob>(`/api/workbench/projects/${record.id}/jobs`, 'POST', { kind, revision: record.revision, burnSubtitles: burn, ...(kind === 'export' && exportScope === 'selected' ? { clipId: selectedClipId } : {}), ...(consentId ? { consentId } : {}) })
      setJob(started)
      startedTask = true
    } catch (cause) { error(cause) } finally { if (!startedTask) stopPipeline(); setBusy(false); setPendingKind(null) }
  }

  const cancel = () => {
    stopPipeline()
    if (!job || !['queued', 'running'].includes(job.status) || cancelling) return
    setCancelling(true)
    void client.current?.request(`/api/workbench/jobs/${job.id}/cancel`, 'POST', {}).catch(cause => { setCancelling(false); error(cause) })
  }

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return
    let live = true
    const timer = window.setInterval(() => { void client.current?.request<LocalJob>(`/api/workbench/jobs/${job.id}`).then(next => {
      if (!live) return
      setJob(next)
      if (next.status === 'completed') {
        const result = next.result
        if (result?.record) client.current?.bind(result.record)
        const candidate = result?.record?.project || result?.candidate
        if (candidate) {
          if (JSON.stringify(latestProject.current) === snapshot.current) resultHandler.current(candidate)
          else { stopPipeline(); setPrepared(candidate); setMessage('resultPending') }
        }
        if (pipeline.current) {
          if (candidate && next.kind === 'transcribe' && candidate.cues.length) void start('analyze', candidate, true)
          else if (candidate && next.kind === 'analyze' && candidate.clips.length) void start('cleanup', candidate, true)
          else if (result?.suggestions && JSON.stringify(latestProject.current) === snapshot.current) { onCleanup(result.suggestions); stopPipeline() }
          else stopPipeline()
        } else if (result?.suggestions) { setSuggestions(result.suggestions); setChecked([]); setPanel('cleanup') }
      }
      if (['failed', 'cancelled'].includes(next.status)) { stopPipeline(); if (next.status === 'failed') setMessage('taskFailed') }
    }).catch(error) }, 700)
    return () => { live = false; window.clearInterval(timer) }
  }, [job?.id, job?.status])

  useImperativeHandle(ref, () => ({
    save: async value => client.current && value.source.kind === 'local' ? (await client.current.save(value)).project : null,
    export: value => { void start('export', value) },
    cancel,
    hasTask: () => pipelineRunning || busy || downloading || !!job && ['queued', 'running'].includes(job.status),
  }))

  const running = locked || pipelineRunning || busy || downloading || !!job && ['queued', 'running'].includes(job.status)
  const activeJob = job && ['queued', 'running'].includes(job.status) ? job : null
  const activeKind = downloading ? 'export' : pendingKind || activeJob?.kind || null
  const phase = downloading ? 'saving' : cancelling && activeJob ? 'cancelling' : busy || activeJob?.status === 'queued' ? 'preparing' : 'running'
  const progress = !busy && !downloading && activeJob && Number.isFinite(activeJob.progress) ? activeJob.progress : null
  const cancellable = Boolean(activeJob) && !busy && !downloading
  useEffect(() => {
    onActivity?.(activeKind ? { kind: activeKind, phase, progress, cancellable } : null)
  }, [activeKind, phase, progress, cancellable, onActivity])
  const activity: LocalTaskActivity | null = activeKind ? { kind: activeKind, phase, progress, cancellable } : null
  const taskButton = (kind: LocalJob['kind'], label: MessageKey, disabled: boolean, hint?: MessageKey) => <div className={`wb-task-group ${activeKind === kind ? 'is-active' : ''}`}>
    <button type="button" className="wb-local-action" disabled={running || disabled} title={hint ? ui(hint) : undefined} onClick={() => void start(kind, project)}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === 'transcribe' ? <><path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z" /><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" /></> : kind === 'analyze' ? <><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 2v4M18 4h4" /></> : <><circle cx="5" cy="6" r="3" /><circle cx="5" cy="18" r="3" /><path d="m8 8 13 13M8 16 21 3" /></>}
      </svg>{ui(label)}
    </button>
    {!headerProgress && activity?.kind === kind && <LocalTaskProgress activity={activity} ui={ui} onCancel={cancel} />}
  </div>
  if (!ready && !message) return null
  return <>
    <div className="wb-local-controls">
      {ready && <><div className="wb-local-workflow">
        <button type="button" className="wb-local-action wb-one-click" disabled={running || !project.source.assetId || !ready.asrReady} title={ui('oneClickHint')} onClick={() => { if (pipeline.current) return; pipeline.current = true; setPipelineRunning(true); void start('transcribe', project, true) }}>✦ {ui('oneClick')}</button>
        {taskButton('transcribe', 'localTranscribe', !project.source.assetId || !ready.asrReady, !ready.asrReady ? 'asrNotReady' : undefined)}
        {taskButton('analyze', 'findHighlights', !project.source.assetId || !project.cues.length)}
        {taskButton('cleanup', 'cleanSpeech', !project.source.assetId || !project.clips.length, !project.clips.length ? 'emptySequence' : undefined)}
      </div>{!isCClip && <div className="wb-local-utilities">
        <button disabled={running} className="wb-local-secondary" onClick={() => { if (onProjects) { onProjects(); return } void client.current?.request<{ id: string; title: string }[]>('/api/workbench/projects').then(items => { setProjects(items); setPanel('projects') }).catch(error) }}>{ui('localProjects')}</button>
        <button className="wb-local-secondary" disabled={running} onClick={() => onSettings ? onSettings() : setPanel('settings')}>{ui('apiSettings')}</button>
      </div>}<div className="wb-export-options">
        <select className="wb-export-scope" disabled={running} aria-label={ui('exportScope')} value={exportScope} onChange={event => setExportScope(event.target.value as 'program' | 'selected')}><option value="program">{ui('exportProgram')}</option><option value="selected">{ui('exportSelected')}</option></select><label className="wb-burn-toggle"><input type="checkbox" disabled={running} checked={burn} onChange={event => setBurn(event.target.checked)} />{ui('burnSubtitles')}</label>
        {!onActivity && activity?.kind === 'export' && <LocalTaskProgress activity={activity} ui={ui} onCancel={cancel} />}
      </div></>}
      {job?.status === 'completed' && job.result?.download && (onDownload ? <button className="wb-text-button wb-local-download" disabled={downloading} onClick={() => {
        setDownloading(true); setMessage(null)
        void onDownload(job.result!.download!).then(() => setMessage('fileSaved')).catch(() => setMessage('serviceError')).finally(() => setDownloading(false))
      }}>{ui(downloading ? 'savingFile' : 'saveExport')}</button> : <a className="wb-local-download" href={job.result.download} download>{ui('saveExport')}</a>)}
      {message && <span className="wb-local-message" role="status">{ui(message)}</span>}
      {prepared && <button className="wb-text-button" onClick={() => { if (window.confirm(ui('replaceConfirm'))) { onResult(prepared); setPrepared(null); setMessage(null) } }}>{ui('loadResult')}</button>}
    </div>
    {panel && <div className="wb-modal-backdrop"><section className="wb-local-dialog" role="dialog" aria-modal="true" aria-label={ui(panel === 'projects' ? 'localProjects' : panel === 'settings' ? 'apiSettings' : 'cleanSpeech')}>
      <header><b>{ui(panel === 'projects' ? 'localProjects' : panel === 'settings' ? 'apiSettings' : 'cleanSpeech')}</b><button className="wb-text-button" aria-label={ui('close')} onClick={() => { setPanel(null); setKey('') }}>×</button></header>
      {panel === 'projects' ? <div className="wb-local-project-list">{projects.map(item => <button key={item.id} onClick={() => { if (!window.confirm(ui('replaceConfirm'))) return; void client.current?.open(item.id).then(value => { onOpen(value); setPanel(null) }).catch(error) }}>{item.title}</button>)}{!projects.length && <p>{ui('noLocalProjects')}</p>}</div>
        : panel === 'settings' ? <form onSubmit={event => { event.preventDefault(); void client.current?.request('/api/workbench/analysis-settings', 'POST', { baseUrl, model, apiKey: key }).then(() => { setKey(''); setPanel(null); setMessage('apiConfigured') }).catch(error) }}>
          <p>{ui('apiPrivacy')}</p><label>{ui('apiBaseUrl')}<input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoComplete="off" /></label><label>{ui('apiModel')}<input required value={model} onChange={event => setModel(event.target.value)} autoComplete="off" /></label><label>API Key<input required type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" /></label><button type="submit" className="wb-button wb-button-accent">{ui('save')}</button>
        </form> : <><p>{ui('cleanupHint')}</p><div className="wb-cleanup-list">{suggestions.map(item => <label key={item.id}><input type="checkbox" checked={checked.includes(item.id)} onChange={event => setChecked(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><span><b>{ui(item.kind)} · {formatTime(item.start)} → {formatTime(item.end)}</b>{item.text && <span>{item.text}</span>}</span></label>)}{!suggestions.length && <p>{ui('noCleanupSuggestions')}</p>}</div><button className="wb-button wb-button-accent" disabled={!checked.length || snapshot.current !== JSON.stringify(project)} onClick={() => { onCleanup(suggestions.filter(item => checked.includes(item.id))); setPanel(null) }}>{ui('applyCleanup')}</button></>}
    </section></div>}
  </>
})
export default LocalServiceControls
