import { useEffect, useState } from 'react'
import { LocalClient } from './localApi'

export const defaultEditorPreferences = { snapping: true, split: 's', markIn: 'i', markOut: 'o', bookmark: 'm', snap: 'n' }
export type EditorPreferences = typeof defaultEditorPreferences
export type ShortcutAction = Exclude<keyof EditorPreferences, 'snapping'>
export const shortcutActions: ShortcutAction[] = ['split', 'markIn', 'markOut', 'bookmark', 'snap']
export const validPreferences = (value: EditorPreferences) => shortcutActions.every(action => /^[a-z]$/.test(value[action])) && new Set(shortcutActions.map(action => value[action])).size === shortcutActions.length
let current = { ...defaultEditorPreferences }, started = false, generation = 0
let pending = Promise.resolve()
const client = new LocalClient()
const listeners = new Set<(value: EditorPreferences) => void>()
const publish = (value: EditorPreferences) => { current = value; listeners.forEach(listener => listener(value)) }
export function useEditorPreferences() {
  const [value, setValue] = useState(current)
  useEffect(() => {
    listeners.add(setValue)
    if (!started) {
      started = true
      const loadingGeneration = generation
      if (document.querySelector('meta[name="workbench-service"]')) {
        void client.connect().then(() => client.request<EditorPreferences>('/api/workbench/editor-preferences'))
          .then(value => { if (generation === loadingGeneration && validPreferences(value)) publish(value) }).catch(() => undefined)
      } else {
        try { const value = JSON.parse(localStorage.getItem('cclip.editor.preferences') || 'null'); if (value && validPreferences(value)) publish(value) } catch { /* Defaults remain usable. */ }
      }
    }
    return () => { listeners.delete(setValue) }
  }, [])
  const save = async (next: EditorPreferences) => {
    if (!validPreferences(next)) throw new Error('invalid_shortcuts')
    const previous = current, revision = ++generation
    publish({ ...next })
    const write = pending.catch(() => undefined).then(async () => {
    if (document.querySelector('meta[name="workbench-service"]')) {
      await client.connect()
      await client.request('/api/workbench/editor-preferences', 'PUT', next)
    } else localStorage.setItem('cclip.editor.preferences', JSON.stringify(next))
    })
    pending = write
    try { await write } catch (error) { if (generation === revision) publish(previous); throw error }
  }
  return [value, save] as const
}
