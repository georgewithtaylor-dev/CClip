import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { Btn, Segmented } from '../ui'
import { coverApi, type CoverConfigView, type CoverView, type ManualCoverKit } from '../publish/coverApi'
import { copyText } from '../features/studio/outputShare'
import { formatTime } from '../features/workbench/model'
import type { Draft, Workspace } from '../features/studio/types'
import { isDesktopDownload, saveLocalFile } from '../features/studio/nativeDownload'
import { ct } from './messages'
import { CCLIP_SETTINGS_CLOSED } from './runtime'

export default function DraftCover({ projectId, draft, workspace, fallback, currentTime, onSave, onNavigate, onChanged, onRefresh }: {
  projectId: string; draft: Draft; workspace: Workspace; fallback?: string
  currentTime: number
  onSave: () => Promise<Draft>; onNavigate: (path: string) => void; onChanged: (url?: string) => void; onRefresh: () => void
}) {
  const initialPlatform = draft.platform_preset === 'xiaohongshu' ? 'xiaohongshu' : draft.platform_preset === 'youtube_long' ? 'youtube_long' : draft.platform_preset === 'bilibili' ? 'bilibili' : draft.aspect === 'portrait' ? 'douyin' : 'bilibili'
  const storedCover = workspace.cclip_draft_covers?.[draft.id]
  const platform = initialPlatform
  const [title, setTitle] = useState(draft.packaging?.title_lines.join(' ') || draft.title)
  const [subtitle, setSubtitle] = useState(''), [badge, setBadge] = useState('')
  const [frameTime, setFrameTime] = useState<number | null>(null)
  const [layout, setLayout] = useState<'fit' | 'crop'>('fit'), [position, setPosition] = useState<'top' | 'bottom'>('top')
  const [kind, setKind] = useState('general'), [sendReference, setSendReference] = useState(false)
  const [localTemplate, setLocalTemplate] = useState<'autoclip' | 'overlay'>('autoclip')
  const [palette, setPalette] = useState<string>(draft.packaging?.palette || 'azure')
  const [previewOn, setPreviewOn] = useState(false), [previewUrl, setPreviewUrl] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState(false)
  const [previewVersion, setPreviewVersion] = useState(0)
  const previousPlatform = useRef(platform)
  useEffect(() => {
    if (previousPlatform.current === platform) return
    previousPlatform.current = platform
    setCover(null); setPreviewOn(true); setHint('')
  }, [platform])
  const [config, setConfig] = useState<CoverConfigView | null>(null)
  const [cover, setCover] = useState<CoverView | null>(null), [working, setWorking] = useState(false), [hint, setHint] = useState('')
  const [manualOpen, setManualOpen] = useState(false), [manual, setManual] = useState<ManualCoverKit | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [manualFingerprint, setManualFingerprint] = useState('')
  const fingerprint = JSON.stringify([platform, title, subtitle, badge, kind, frameTime])
  const alive = useRef(true), edited = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let active = true, revision = 0
    const load = () => {
      const current = ++revision
      void coverApi.getConfig().then(value => {
        if (!active || current !== revision) return
        setConfig(value)
        if (!value.allow_send_frame) setSendReference(false)
      }).catch(() => { if (active && current === revision) { setConfig(null); setSendReference(false); setHint(ct('settingsRefreshFailed')) } })
    }
    load(); window.addEventListener(CCLIP_SETTINGS_CLOSED, load)
    return () => { active = false; revision++; window.removeEventListener(CCLIP_SETTINGS_CLOSED, load) }
  }, [])
  const target = `draft-${draft.id}`
  const jobs = Object.values(workspace.cclip_cover_jobs || {}).filter(job => job.clip_id === target && job.platform === platform)
  const running = jobs.some(job => ['queued', 'running'].includes(job.status))
  const signal = JSON.stringify(jobs.map(job => [job.job_id, job.status]))
  useEffect(() => {
    let active = true
    void coverApi.get(projectId, target, platform).then(value => {
      if (!active) return
      setCover(value.ok ? value : null)
      if (value.ok) {
        if (!edited.current) {
          setTitle(value.title || draft.title); setSubtitle(value.subtitle || ''); setBadge(value.badge || '')
          if (value.method !== 'uploaded') { setFrameTime(value.frame_time ?? null); setLayout(value.image_layout || 'fit'); setPosition(value.title_position || 'top'); setKind(value.content_type || 'general'); setLocalTemplate(value.local_template || (value.method === 'design' ? 'autoclip' : 'overlay')); setPalette(value.palette || draft.packaging?.palette || 'azure') }
        }
        onChangedRef.current(value.url || undefined)
      }
    }).catch(() => { if (active) setCover(null) })
    return () => { active = false }
  }, [projectId, target, platform, signal, draft.title])
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged
  const previewBody = JSON.stringify({ platform, title, subtitle, badge, frame_time: frameTime, local_template: localTemplate, palette, image_layout: layout, title_position: position })
  useEffect(() => { if (edited.current) setPreviewOn(true) }, [previewBody])
  useEffect(() => {
    if (!previewOn) return
    let active = true, objectUrl = ''
    const controller = new AbortController()
    setPreviewBusy(true); setPreviewError(false)
    const timer = window.setTimeout(() => {
      void coverApi.preview(projectId, target, JSON.parse(previewBody), controller.signal).then(blob => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob); setPreviewUrl(objectUrl)
      }).catch(() => { if (active) { setPreviewError(true); setPreviewUrl('') } }).finally(() => { if (active) setPreviewBusy(false) })
    }, 350)
    return () => { active = false; window.clearTimeout(timer); controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [previewOn, previewBody, projectId, target, previewVersion])
  const manualCurrent = !!manual && manual.platform === platform && manual.revision === draft.revision && manualFingerprint === fingerprint
  const prepareManual = async () => {
    if (working || running) return
    setWorking(true); setHint('')
    try {
      if (frameTime !== null && !draft.scenes.some(scene => frameTime >= scene.start && frameTime < scene.end)) { setHint(ct('coverFrameOutside')); return }
      const saved = await onSave()
      const value = await coverApi.manual(projectId, target, { revision: saved.revision, platform, title, subtitle, badge, content_type: kind, frame_time: frameTime })
      if (alive.current) { setManual(value); setManualFingerprint(fingerprint) }
    } catch { if (alive.current) setHint(ct('manualCoverFailed')) }
    finally { if (alive.current) { setWorking(false); onRefresh() } }
  }
  const downloadManual = async (relative: string) => {
    try {
      if (isDesktopDownload()) await saveLocalFile(relative.replace(/^\/api\/v1/, ''))
      else { const anchor = document.createElement('a'); anchor.href = relative; anchor.download = ''; anchor.click() }
      if (alive.current) setHint(ct('fileSaved'))
    } catch { if (alive.current) setHint(t('下载失败，请稍后重试')) }
  }
  const uploadCover = async (file?: File) => {
    if (!file || working || running) return
    if (file.size > 20 * 1024 * 1024) { setHint(ct('manualCoverFileHint')); return }
    setWorking(true); setHint('')
    try {
      const saved = await onSave()
      const value = await coverApi.upload(projectId, target, file, { revision: saved.revision, platform, title, subtitle, badge })
      if (alive.current) { setCover(value); setPreviewOn(false); edited.current = false; onChanged(value.url || undefined); setHint(ct('manualCoverUploaded')) }
    } catch { if (alive.current) setHint(ct('manualCoverUploadFailed')) }
    finally { if (alive.current) { setWorking(false); onRefresh() } }
  }
  const generate = async (local: boolean) => {
    if (working || running) return
    setWorking(true); setHint('')
    try {
      if (frameTime !== null && !draft.scenes.some(scene => frameTime >= scene.start && frameTime < scene.end)) { setHint(ct('coverFrameOutside')); return }
      if (!local) {
        const settings = await coverApi.getConfig(); setConfig(settings)
        if (!settings.enabled || !settings.configured) { setHint(ct('coverModelRequired')); return }
        if (sendReference && !settings.allow_send_frame) { setHint(ct('coverReferenceDisabled')); return }
        const recipient = settings.base_url || settings.provider
        const verification = settings.verification
        const checkConsent = verification ? ct('coverVerificationConsent').replace('{service}', `${verification.base_url || verification.provider} · ${verification.model}`) : ct('coverVerificationNone')
        if (!window.confirm(ct('coverRequestConsent').replace('{service}', recipient).replace('{reference}', ct(sendReference ? 'coverOneFrame' : 'coverNoFrame')) + '\n' + checkConsent)) return
      }
      await onSave()
      const result = await coverApi.start(projectId, target, { platform, title, subtitle, badge, content_type: kind, force_local: local,
        require_ai: !local, frame_time: frameTime, image_layout: layout, title_position: position, send_reference: !local && sendReference, local_template: localTemplate, palette })
      onRefresh()
      let value: CoverView | undefined
      if ('job_id' in result) {
        for (let index = 0; index < 180 && alive.current; index++) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          const job = await coverApi.job(result.job_id)
          if (job.status === 'completed') { value = job.result; break }
          if (['failed', 'cancelled'].includes(job.status)) throw new Error('cover_failed')
        }
      } else value = result
      if (!alive.current) return
      if (value?.url) { setCover(value); setPreviewOn(false); edited.current = false; onChanged(value.url); setHint(value.warning || '') }
      else setHint(t('正在生成封面'))
    } catch { if (alive.current) setHint(ct('coverFailureRetained')) }
    finally { if (alive.current) { setWorking(false); onRefresh() } }
  }
  const savedUrl = cover?.url || (storedCover?.platform === platform ? storedCover.url : platform === initialPlatform ? fallback : undefined)
  const url = previewOn && previewUrl ? previewUrl : savedUrl
  return <section className="cclip-draft-cover" data-draft-cover>
    <h3>{t('封面')}</h3>
    <div className="cclip-cover-editor">
    <div className="cclip-draft-cover-preview" data-local-preview={previewOn && !previewError} style={{ aspectRatio: platform === 'douyin' ? '9 / 16' : platform === 'xiaohongshu' ? '3 / 4' : platform === 'bilibili' ? '1146 / 717' : '16 / 9' }}>{url ? <img src={url} alt={t('封面')} /> : <span>{t(working || running ? '正在生成封面' : '还没有封面')}</span>}</div>
    <div className="cclip-cover-controls">
    <div className="cclip-cover-aspect">{ct('coverAspect')} · {platform === 'douyin' ? '9:16' : platform === 'xiaohongshu' ? '3:4' : platform === 'bilibili' ? '1146×717' : '16:9'}</div>
    <div className="cclip-cover-option"><span>{ct('coverLocalTemplate')}</span><select className="ac-input" aria-label={ct('coverLocalTemplate')} value={localTemplate} disabled={working || running} onChange={event => { edited.current = true; setLocalTemplate(event.target.value as 'autoclip' | 'overlay'); setPreviewOn(true) }}><option value="autoclip">{ct('coverTemplateAutoclip')}</option><option value="overlay">{ct('coverTemplateOverlay')}</option></select></div>
    {localTemplate === 'autoclip' && <div className="cclip-cover-option"><span>{ct('coverPalette')}</span><select className="ac-input" aria-label={ct('coverPalette')} value={palette} disabled={working || running} onChange={event => { edited.current = true; setPalette(event.target.value); setPreviewOn(true) }}>{(['azure', 'amber', 'coral', 'mint', 'lemon', 'rose', 'lilac'] as const).map(value => <option key={value} value={value}>{ct(`coverPalette_${value}`)}</option>)}</select></div>}
    <Btn size="sm" disabled={working || running || previewBusy} onClick={() => { setPreviewOn(true); setPreviewVersion(value => value + 1) }}>{ct('coverLocalPreview')}</Btn>
    {previewOn && <Btn size="sm" onClick={() => setPreviewOn(false)}>{ct('coverLocalPreviewCancel')}</Btn>}
    {previewOn && <p role="status">{ct(previewBusy ? 'coverLocalPreviewBusy' : previewError ? 'coverLocalPreviewFailed' : 'coverLocalPreviewUnsaved')}</p>}
    <label>{t('封面标题')}<input className="ac-input" disabled={working || running} aria-label={t('封面标题')} value={title} maxLength={200} onChange={event => { edited.current = true; setTitle(event.target.value) }} /></label>
    <label>{t('封面副标题')}<input className="ac-input" disabled={working || running} aria-label={t('封面副标题')} value={subtitle} maxLength={200} onChange={event => { edited.current = true; setSubtitle(event.target.value) }} /></label>
    <label>{t('封面角标')}<input className="ac-input" disabled={working || running} aria-label={t('封面角标')} value={badge} maxLength={80} onChange={event => { edited.current = true; setBadge(event.target.value) }} /></label>
    <div className="cclip-cover-frame"><span>{ct('coverFrame')}：{frameTime === null ? ct('coverRecommendedFrame') : formatTime(frameTime)}</span><Btn size="sm" disabled={working || running} onClick={() => {
      if (!draft.scenes.some(scene => currentTime >= scene.start && currentTime < scene.end)) { setHint(ct('coverFrameOutside')); return }
      edited.current = true; setFrameTime(currentTime); setHint('')
    }}>{ct('coverUseCurrentFrame')}</Btn><Btn size="sm" disabled={working || running} onClick={() => { edited.current = true; setFrameTime(null) }}>{ct('coverRecommendedFrame')}</Btn></div>
    {localTemplate === 'overlay' && <><div className="cclip-cover-option"><span>{ct('coverLocalLayout')}</span><Segmented disabled={working || running} size="sm" ariaLabel={ct('coverLocalLayout')} value={layout} onChange={value => { edited.current = true; setLayout(value as 'fit' | 'crop') }} options={[{ value: 'fit', label: ct('coverWholeFrame') }, { value: 'crop', label: ct('coverCropFrame') }]} /></div>
    <div className="cclip-cover-option"><span>{ct('coverTitlePosition')}</span><Segmented disabled={working || running} size="sm" ariaLabel={ct('coverTitlePosition')} value={position} onChange={value => { edited.current = true; setPosition(value as 'top' | 'bottom') }} options={[{ value: 'top', label: ct('coverTop') }, { value: 'bottom', label: ct('coverBottom') }]} /></div></>}
    <label>{ct('coverAiStyle')}<select className="ac-input" disabled={working || running} aria-label={ct('coverAiStyle')} value={kind} onChange={event => { edited.current = true; setKind(event.target.value) }}>{(['general', 'knowledge', 'interview', 'game', 'vlog'] as const).map(value => <option value={value} key={value}>{ct(`coverStyle_${value}`)}</option>)}</select></label>
    <p className="cclip-cover-model">{ct('coverImageModel')}：{config?.enabled && config.configured ? `${config.provider} · ${config.model || ct('coverProviderDefault')}` : ct('coverModelRequired')}</p>
    {config?.enabled && config.configured && <p className="cclip-cover-model">{ct('coverVerificationModel')}：{config.verification ? `${config.verification.base_url || config.verification.provider} · ${config.verification.model}` : ct('coverVerificationNone')}</p>}
    <label className="cclip-cover-reference"><input type="checkbox" checked={sendReference} disabled={!config?.allow_send_frame || working || running} onChange={event => setSendReference(event.target.checked)} />{ct('coverSendReference')}</label>
    {!config?.allow_send_frame && <p>{ct('coverReferenceDisabled')}</p>}
    {cover?.method && <p>{ct('coverCreatedWith')}：{ct(cover.method === 'uploaded' ? 'manualCoverUpload' : cover.method === 'model' || cover.method === 'model_bg' ? 'cloudCover' : 'localCover')}</p>}
    <p>{ct('coverPreviewHint')}</p>
    <div className="cclip-cover-actions"><Btn size="sm" disabled={working || running} onClick={() => void generate(true)}>{ct('localCover')}</Btn><Btn size="sm" disabled={working || running} onClick={() => void generate(false)}>{ct('cloudCover')}</Btn><Btn size="sm" onClick={() => onNavigate('/settings?section=cover')}>{t('封面设置')}</Btn>{savedUrl && !previewOn && <a className="ac-btn" href={savedUrl} download onClick={async event => { if (!isDesktopDownload()) return; event.preventDefault(); try { const targetUrl = new URL(savedUrl, window.location.origin); if (targetUrl.origin !== window.location.origin || !targetUrl.pathname.startsWith('/api/v1/')) throw new Error('invalid_download'); await saveLocalFile(targetUrl.pathname.slice('/api/v1'.length) + targetUrl.search); setHint(ct('fileSaved')) } catch { setHint(t('下载失败，请稍后重试')) } }}>{ct('downloadCover')}</a>}</div>
    <div className="cclip-cover-actions"><Btn size="sm" disabled={working || running} aria-expanded={manualOpen} onClick={() => setManualOpen(value => !value)}>{ct('manualCover')}</Btn></div>
    {manualOpen && <div className="cclip-manual-cover" data-manual-cover>
      <p>{ct('manualCoverHint')}</p>
      <Btn size="sm" disabled={working || running} onClick={() => void prepareManual()}>{ct('manualCoverPrepare')}</Btn>
      {manual && <>
        {!manualCurrent && <p role="status">{ct('manualCoverRefresh')}</p>}
        <label>{ct('manualCoverPrompt')}<textarea className="ac-input" aria-label={ct('manualCoverPrompt')} readOnly rows={6} value={manual.prompt} /></label>
        <div className="cclip-cover-actions"><Btn size="sm" onClick={async () => setHint(ct(await copyText(manual.prompt) ? 'manualCoverCopied' : 'manualCoverCopyFailed'))}>{ct('manualCoverCopy')}</Btn><Btn size="sm" onClick={() => void downloadManual(manual.prompt_url)}>{ct('manualCoverDownloadPrompt')}</Btn></div>
        <figure><img src={manual.frame_url} alt={ct('manualCoverReference')} /><figcaption>{ct('manualCoverReference')} · {formatTime(manual.frame_time)}</figcaption></figure>
        <Btn size="sm" onClick={() => void downloadManual(manual.frame_url)}>{ct('manualCoverDownloadFrame')}</Btn>
      </>}
      <p>{ct('manualCoverFileHint')}</p>
      <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label={ct('manualCoverUpload')} hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void uploadCover(file) }} />
      <Btn size="sm" disabled={working || running} onClick={() => uploadInput.current?.click()}>{ct('manualCoverUpload')}</Btn>
    </div>}
    {hint && <p role="status">{hint}</p>}
    </div></div>
  </section>
}
