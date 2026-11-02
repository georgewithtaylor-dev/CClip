import { useEffect, useState } from 'react'
import { Btn, Section } from '../ui'
import { cclipRequest } from './runtime'
import { ct } from './messages'

type Locations = { generated: string; downloads: string; legacyGenerated?: string[]; data?: string }
type Cache = { paths: string[]; bytes: number; files: number; busy: number; retained: number }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export default function StorageSettings() {
  const [value, setValue] = useState<Locations | null>(null)
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const [cache, setCache] = useState<Cache | null>(null)
  const load = () => { void cclipRequest<Locations>('/api/cclip/storage').then(setValue).catch(() => { setValue({ generated: '', downloads: '' }); setStatus(ct('storageFailed')) }) }
  const loadCache = () => cclipRequest<Cache>('/api/cclip/storage/cache').then(setCache)
  useEffect(() => { load(); void loadCache().catch(() => setStatus(ct('cacheFailed'))) }, [])
  const clear = async () => {
    setBusy(true); setStatus('')
    try {
      const result = await cclipRequest<Cache>('/api/cclip/storage/cache/clear', 'POST')
      setStatus(ct('cacheCleared').replace('{size}', size(result.bytes)).replace('{count}', String(result.busy + result.retained)))
      await loadCache()
    } catch { setStatus(ct('cacheFailed')) }
    finally { setBusy(false) }
  }
  const choose = async (key: 'generated' | 'downloads') => {
    setBusy(true); setStatus('')
    try {
      const result = await cclipRequest<{ path: string | null }>('/api/cclip/storage/choose', 'POST')
      if (result.path) setValue(current => current && { ...current, [key]: result.path! })
    } catch { setStatus(ct('storagePickerFailed')) }
    finally { setBusy(false) }
  }
  return <Section title={ct('storage')} description={ct('storageHint')}>
    {!value ? <Btn onClick={load}>{ct('storageRetry')}</Btn> : <form className="cclip-storage-form" onSubmit={event => {
      event.preventDefault(); setBusy(true); setStatus('')
      void cclipRequest<Locations>('/api/cclip/storage', 'PUT', { generated: value.generated, downloads: value.downloads })
        .then(saved => { setValue({ ...value, ...saved }); setStatus(ct('storageSaved')) })
        .catch(() => setStatus(ct('storageFailed'))).finally(() => setBusy(false))
    }}>
      {(['generated', 'downloads'] as const).map(key => <div className="cclip-storage-location" key={key}>
        <label htmlFor={`cclip-storage-${key}`}>{ct(key === 'generated' ? 'generatedFolder' : 'downloadsFolder')}</label>
        <strong className="cclip-storage-policy">{ct(key === 'generated' ? 'generatedKeep' : 'downloadsKeep')}</strong>
        <p>{ct(key === 'generated' ? 'generatedHint' : 'downloadsHint')}</p>
        <input className="ac-input" id={`cclip-storage-${key}`} required disabled={busy} value={value[key]} onChange={event => setValue({ ...value, [key]: event.target.value })} />
        <div><Btn size="sm" disabled={busy} onClick={() => void choose(key)}>{ct('chooseFolder')}</Btn><Btn size="sm" disabled={busy} onClick={() => {
          void cclipRequest(`/api/cclip/storage/open/${key}`, 'POST').catch(() => setStatus(ct('storageFailed')))
        }}>{ct('openSavedFolder')}</Btn></div>
      </div>)}
      <Btn type="submit" variant="cta" disabled={busy}>{ct('storageSave')}</Btn>
      <div className="cclip-storage-location">
        <strong>{ct('cacheFolder')}</strong><strong className="cclip-storage-policy">{ct('cacheSafe')}</strong>
        <p>{ct('cacheHint')}</p>
        {cache?.paths.map(path => <p className="cclip-storage-path" key={path}>{path}</p>)}
        <p>{ct('cacheSize').replace('{size}', size(cache?.bytes || 0))}</p>
        <div><Btn disabled={busy || !cache} onClick={() => void clear()}>{ct('clearCache')}</Btn><Btn disabled={busy} onClick={() => void loadCache().catch(() => setStatus(ct('cacheFailed')))}>{ct('storageRetry')}</Btn></div>
      </div>
      {value.data && <div className="cclip-storage-location"><strong>{ct('projectFolder')}</strong><strong className="cclip-storage-policy">{ct('projectKeep')}</strong><p className="cclip-storage-path">{value.data}</p></div>}
      <details open><summary>{ct('oldOutputFolders')}</summary><p>{ct('legacyKeep')}</p>{value.legacyGenerated?.map((path, index) => <div className="cclip-storage-history" key={path}><p className="cclip-storage-path">{path}</p><Btn size="sm" disabled={busy} onClick={() => {
        void cclipRequest(`/api/cclip/storage/open/${index === 0 ? 'previous-projects' : 'previous-workbench'}`, 'POST').catch(() => setStatus(ct('storageFailed')))
      }}>{ct('openSavedFolder')}</Btn></div>)}</details>
    </form>}
    {status && <p role="status">{status}</p>}
  </Section>
}
