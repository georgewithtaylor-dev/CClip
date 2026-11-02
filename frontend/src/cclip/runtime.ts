import { flushSync } from 'react-dom'
import { flushCClipPreferences } from './preferences'

declare const __CCLIP_BUILD__: boolean
export const isCClip = typeof __CCLIP_BUILD__ !== 'undefined' ? __CCLIP_BUILD__ : typeof document !== 'undefined' && document.querySelector('meta[name="cclip-app"]')?.getAttribute('content') === 'full'
export const CCLIP_SETTINGS_CLOSED = 'cclip-settings-closed'
let connection: Promise<string> | undefined

export function cclipSession(): Promise<string> {
  if (!isCClip) return Promise.resolve('')
  if (!connection) {
    connection = fetch('/api/workbench/session', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Local session unavailable')
      const status = await response.json()
      return status.session as string
    }).catch(error => { connection = undefined; throw error })
  }
  return connection
}

export async function cclipRequest<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const session = await cclipSession()
  const response = await fetch(path, { method, headers: { 'x-workbench-session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(response.status === 409 ? 'revision_conflict_or_busy' : 'local_request_failed')
  return response.json() as Promise<T>
}

export function navigateCClip(navigate: (path: string) => void, path: string, options?: { withinProject: boolean; sameClip?: boolean }) {
  if (isCClip && /^\/settings(?:\?|$)/.test(path)) {
    window.dispatchEvent(new CustomEvent('cclip-open-settings', { detail: new URLSearchParams(path.split('?')[1] || '').get('section') || 'ai' }))
    return true
  }
  const event = new CustomEvent('cclip-before-navigate', { cancelable: true, detail: options })
  window.dispatchEvent(event)
  if (event.defaultPrevented) return false
  navigate(path)
  return true
}

export function installCClipCloseGuard(message: () => string, busyMessage: () => string, serviceMessage: () => string) {
  if (!isCClip || !('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return
  const desktop = window as Window & { __cclipCloseReady?: boolean; __cclipNeedsConfirm?: () => boolean }
  desktop.__cclipCloseReady = true
  window.addEventListener('cclip-close-request', async event => {
    event.stopImmediatePropagation()
    flushSync(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    const pending = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(pending)
    let active = false
    const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 2000)
    try { active = (await (await fetch('/api/cclip/activity', { signal: controller.signal })).json()).active } catch { /* A stopped backend must not prevent exit. */ }
    finally { window.clearTimeout(timer) }
    if ((!pending.defaultPrevented && !desktop.__cclipNeedsConfirm?.() && !active) || window.confirm(active ? busyMessage() : message())) {
      await flushCClipPreferences()
      try { await cclipRequest('/api/cclip/unsaved', 'DELETE') } catch { /* Abandoned edits are also collected on next startup. */ }
      window.location.href = 'cclip-close://approved'
    }
  })
  window.addEventListener('cclip-service-request', event => {
    const action = (event as CustomEvent<string>).detail
    if (['start', 'stop', 'restart'].includes(action) && window.confirm(serviceMessage())) window.location.href = `cclip-service://${action}`
  })
}
