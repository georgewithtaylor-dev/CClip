import { supportedLanguages, type LanguagePreference } from '../i18n/language'

type Preferences = { theme?: 'light' | 'dark'; language?: LanguagePreference }
let pending: Promise<void> = Promise.resolve()

function nativeCClip() {
  return document.querySelector('meta[name="cclip-app"]')?.getAttribute('content') === 'full'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

// Load before i18n and ThemeProvider initialize; a new backend port has a fresh localStorage origin.
export async function restoreCClipPreferences() {
  if (!nativeCClip()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const preferences = await invoke<Preferences>('get_cclip_preferences')
    if (preferences.theme === 'light' || preferences.theme === 'dark') localStorage.setItem('autoclip-theme', preferences.theme)
    if (preferences.language === 'system' || supportedLanguages.includes(preferences.language as typeof supportedLanguages[number])) {
      localStorage.setItem('autoclip.language', preferences.language!)
    }
  } catch (error) { console.warn('Could not restore CClip preferences', error) }
}

export function saveCClipPreferences(preferences: Preferences): Promise<void> {
  if (!nativeCClip()) return Promise.resolve()
  pending = pending.then(async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_cclip_preferences', { preferences })
  }).catch(error => {
    console.warn('Could not save CClip preferences', error)
    window.dispatchEvent(new Event('cclip-preferences-error'))
  })
  return pending
}

export function flushCClipPreferences() { return pending }
