import { useEffect, useId, useRef, useState } from 'react'
import { defaultEditorPreferences, shortcutActions, validPreferences, type EditorPreferences } from './editorPreferences'
import type { MessageKey } from './strings'

export default function ShortcutSettings({ value, onSave, onClose, ui }: { value: EditorPreferences; onSave: (value: EditorPreferences) => Promise<void>; onClose: () => void; ui: (key: MessageKey) => string }) {
  const [draft, setDraft] = useState(value), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const title = useId()
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => previous?.focus()
  }, [])
  const labels = { split: 'split', markIn: 'markIn', markOut: 'markOut', bookmark: 'bookmark', snap: 'snap' } as const
  return <div className="wb-dialog-backdrop" onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') onClose()
    if (event.key === 'Tab') {
      const items = [...(box.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') || [])]
      const edge = event.shiftKey ? items[0] : items[items.length - 1]
      if (document.activeElement === edge) { event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0])?.focus() }
    }
  }}><section ref={box} className="wb-local-dialog wb-shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby={title}>
    <h2 id={title}>{ui('shortcutSettings')}</h2><p>{ui('shortcutSettingsHint')}</p>
    {shortcutActions.map(action => <label key={action}><span>{ui(labels[action])}</span><input aria-label={ui(labels[action])} value={draft[action].toUpperCase()} maxLength={1} onChange={event => setDraft({ ...draft, [action]: event.target.value.toLowerCase() })} /></label>)}
    <p>Space · Ctrl+Z · Ctrl+Shift+Z · Ctrl+S · Ctrl+Wheel</p>
    {!validPreferences(draft) && <p role="alert">{ui('invalidShortcut')}</p>}{error && <p role="alert">{error}</p>}
    <footer><button className="wb-button" onClick={() => setDraft({ ...defaultEditorPreferences, snapping: draft.snapping })}>{ui('resetShortcuts')}</button><button className="wb-button" onClick={onClose}>{ui('close')}</button><button className="wb-button wb-button-accent" disabled={busy || !validPreferences(draft)} onClick={() => { setBusy(true); void onSave(draft).then(onClose).catch(() => setError(ui('editorPreferencesFailed'))).finally(() => setBusy(false)) }}>{ui('saveEditorPreferences')}</button></footer>
  </section></div>
}
