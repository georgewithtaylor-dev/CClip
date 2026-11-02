import { apiConfigManager } from '../../utils/apiConfig'
import { cclipRequest, cclipSession, isCClip } from '../../cclip/runtime'

async function saveCClipFile(path: string) {
  const result = await cclipRequest<{ path: string; sizeBytes: number }>('/api/cclip/storage/save-file', 'POST', { path })
  if (!result || !Number.isFinite(result.sizeBytes) || result.sizeBytes <= 0) throw new Error('Empty media response')
  window.dispatchEvent(new CustomEvent('cclip-file-saved', { detail: result.path }))
  return result
}

export async function saveCClipText(name: string, text: string) {
  const result = await cclipRequest<{ path: string; sizeBytes: number }>('/api/cclip/storage/save-text', 'POST', { name, text })
  window.dispatchEvent(new CustomEvent('cclip-file-saved', { detail: result.path }))
  return result
}

export function isDesktopDownload() {
  return typeof window !== 'undefined' && !!((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)
}

/** Save a workbench export through the same native path used by Studio, including on Intel Mac. */
export async function saveLocalMediaUrl(relative: string) {
  if (!isDesktopDownload() || !isCClip || !relative.startsWith('/api/workbench/')) throw new Error('Invalid local download')
  await saveCClipFile(relative)
}

/** Save any file the local backend serves (name from its Content-Disposition) to Downloads. */
export async function saveLocalFile(path: string) {
  if (!isDesktopDownload()) throw new Error('Desktop runtime required')
  if (isCClip) { await saveCClipFile(path.startsWith('/api/') ? path : `/api/v1${path}`); return }
  if (!apiConfigManager.isReady() && !await apiConfigManager.waitForReady()) throw new Error('Backend not ready')
  const base = apiConfigManager.getBaseUrl().replace(/\/$/, '')
  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<{ size_bytes?: number; sizeBytes?: number }>('save_local_download', { url: `${base}${path}`, ...(isCClip ? { session: await cclipSession() } : {}) })
  const size = result?.size_bytes ?? result?.sizeBytes ?? 0
  if (!Number.isFinite(size) || size <= 0) throw new Error('Empty response')
}

/** Save an existing immutable export. No render request or content telemetry. */
export async function saveStudioExport(projectId: string, jobId: string) {
  if (!isDesktopDownload()) throw new Error('Desktop runtime required')
  if (isCClip) { await saveCClipFile(`/api/v1/studio/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(jobId)}/video?download=true`); return }
  if (!apiConfigManager.isReady() && !await apiConfigManager.waitForReady()) throw new Error('Backend not ready')
  const base = apiConfigManager.getBaseUrl().replace(/\/$/, '')
  const url = `${base}/studio/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(jobId)}/video?download=true`
  const { invoke } = await import('@tauri-apps/api/core')
  const result = await invoke<{ size_bytes?: number; sizeBytes?: number }>('save_local_download', { url, ...(isCClip ? { session: await cclipSession() } : {}) })
  const size = result?.size_bytes ?? result?.sizeBytes ?? 0
  if (!Number.isFinite(size) || size <= 0) throw new Error('Empty media response')
}
