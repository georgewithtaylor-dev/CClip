import { useEffect, useState } from 'react'
import { Btn, Section } from '../ui'
import { useEditorPreferences, defaultEditorPreferences, shortcutActions, validPreferences } from '../features/workbench/editorPreferences'
import { translate } from '../features/workbench/strings'
import { ct } from './messages'
import i18n from '../i18n'

export default function EditorSettings() {
  const [value, save] = useEditorPreferences()
  const [draft, setDraft] = useState(value), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  useEffect(() => setDraft(value), [value])
  const ui = (key: Parameters<typeof translate>[1]) => translate(i18n.language.split('-')[0] as Parameters<typeof translate>[0], key)
  const labels = { split: 'split', markIn: 'markIn', markOut: 'markOut', bookmark: 'bookmark', snap: 'snap' } as const
  return <Section title={ui('shortcutSettings')} description={ct('editorGestures')}>
    <div className="cclip-shortcut-fields">{shortcutActions.map(action => <label key={action}><span>{ui(labels[action])}</span><input className="ac-input" aria-label={ui(labels[action])} value={draft[action].toUpperCase()} maxLength={1} onChange={event => setDraft({ ...draft, [action]: event.target.value.toLowerCase() })} /></label>)}</div>
    {!validPreferences(draft) && <p role="alert">{ui('invalidShortcut')}</p>}
    <Btn onClick={() => setDraft({ ...defaultEditorPreferences, snapping: draft.snapping })}>{ui('resetShortcuts')}</Btn>
    <Btn variant="cta" disabled={busy || !validPreferences(draft)} onClick={() => { setBusy(true); setStatus(''); void save(draft).then(() => setStatus(ui('saveEditorPreferences'))).catch(() => setStatus(ui('editorPreferencesFailed'))).finally(() => setBusy(false)) }}>{ui('saveEditorPreferences')}</Btn>
    {status && <p role="status">{status}</p>}
  </Section>
}
