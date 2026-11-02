import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { formatTime, type Bookmark, type Cue } from './model'
import type { MessageKey } from './strings'

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string
interface Props {
  selectionColor?: string
  focusRequest?: { start: number; end: number; revision: number } | null
  cues: Cue[]
  time: number
  selectedIds: string[]
  ui: Translator
  onSeek: (cue: Cue) => void
  onSelect: (ids: string[]) => void
  onAdd?: (cues?: Cue[]) => void
  onImport?: () => void
  onRemove?: (cues: Cue[]) => void
  onKeep?: (cues: Cue[]) => void
  onEdit: (id: string, text: string) => void
  onDelete: (id: string) => void
  onDeleteSelected?: (ids: string[]) => void
  onDownload: () => void
  canDownload: boolean
  bookmarks: Bookmark[]
  onBookmark: (time: number, label: string) => void
  onBookmarkSeek: (time: number) => void
  onBookmarkEdit: (id: string, label: string) => void
  onBookmarkDelete: (id: string) => void
}

export default function TranscriptPanel({ selectionColor, focusRequest, cues, time, selectedIds, ui, onSeek, onSelect, onAdd, onImport, onRemove, onKeep, onEdit, onDelete, onDeleteSelected, onDownload, canDownload, bookmarks, onBookmark, onBookmarkSeek, onBookmarkEdit, onBookmarkDelete }: Props) {
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const lastChecked = useRef<string | null>(null)
  const lastFocus = useRef<Props['focusRequest']>(undefined)
  const ordered = useMemo(() => [...cues].sort((a, b) => a.start - b.start || a.end - b.end), [cues])
  const visible = ordered.filter(cue => cue.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const active = ordered.find(cue => cue.start <= time && time < cue.end)
  const selected = new Set(selectedIds)
  const finishEdit = (save = true) => {
    const cue = cues.find(item => item.id === editing?.id)
    if (save && editing && cue && editing.text !== cue.text) onEdit(cue.id, editing.text)
    setEditing(null)
  }

  useEffect(() => { if (!selectedIds.length) lastChecked.current = null }, [selectedIds.length])

  useEffect(() => {
    if (!follow || !active || !list.current) return
    const element = list.current.querySelector<HTMLElement>(`[data-transcript-id="${CSS.escape(active.id)}"]`)
    if (!element) return
    const container = list.current
    if (element.offsetTop < container.scrollTop || element.offsetTop + element.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * .35)
    }
  }, [active?.id, follow, query, showBookmarks])

  // Explicit clip selection also works during a speech gap, with playback follow
  // disabled, and when the same clip is selected again after manual browsing.
  useEffect(() => {
    if (!focusRequest || lastFocus.current === focusRequest) return
    const cue = ordered.find(item => item.start < focusRequest.end && item.end > focusRequest.start)
      || ordered.find(item => item.start >= focusRequest.start) || ordered[ordered.length - 1]
    if (!cue) return
    if (showBookmarks) { setShowBookmarks(false); return }
    if (!cue.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) { setQuery(''); return }
    const container = list.current
    const element = container?.querySelector<HTMLElement>(`[data-transcript-id="${CSS.escape(cue.id)}"]`)
    if (!container || !element) return
    container.scrollTop = Math.max(0, element.offsetTop - container.clientHeight * .15)
    lastFocus.current = focusRequest
  }, [focusRequest, ordered, query, showBookmarks])

  const check = (cue: Cue, shift: boolean) => {
    const next = new Set(selectedIds)
    if (shift && lastChecked.current) {
      const from = ordered.findIndex(item => item.id === lastChecked.current)
      const to = ordered.findIndex(item => item.id === cue.id)
      if (from >= 0 && to >= 0) ordered.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(item => next.add(item.id))
    } else if (next.has(cue.id)) next.delete(cue.id)
    else next.add(cue.id)
    lastChecked.current = cue.id
    onSelect([...next])
  }

  return <div className="wb-transcript-panel" onKeyDown={event => {
    if (event.key !== 'Delete' || event.defaultPrevented || editing || !onDeleteSelected || event.target instanceof Element && event.target.closest('textarea,input:not([type=checkbox]),[contenteditable=true]')) return
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-transcript-id]')?.dataset.transcriptId : undefined
    const ids = selectedIds.length ? selectedIds : row ? [row] : []
    if (!ids.length) return
    event.preventDefault(); event.stopPropagation(); onDeleteSelected(ids); onSelect([])
  }} style={{ '--clip-color': selectionColor || '#b4db89' } as CSSProperties}>
    <div className="wb-transcript-search"><input aria-label={ui('searchTranscript')} placeholder={ui('searchTranscript')} value={query} onChange={event => setQuery(event.target.value)} />{onImport && <button className="wb-text-button" onClick={onImport}>{ui('importSrt')} +</button>}<button className="wb-text-button" disabled={!canDownload} onClick={onDownload} aria-label={ui('downloadSrt')} title={ui('downloadSrt')}>↓ SRT</button></div>
    <div className="wb-bookmark-tools"><button className="wb-text-button" onClick={() => onBookmark(time, active?.text.trim().slice(0, 60) || ui('bookmark'))}>◇ {ui('markCurrent')} <kbd>M</kbd></button><button className={`wb-text-button ${showBookmarks ? 'is-active' : ''}`} onClick={() => setShowBookmarks(value => !value)}>{showBookmarks ? ui('backToTranscript') : ui('bookmarksCount', { count: bookmarks.length })}</button></div>
    {showBookmarks ? <div className="wb-bookmark-list" role="list" aria-label={ui('bookmarks')}>
      {[...bookmarks].sort((a, b) => a.time - b.time).map(mark => <article role="listitem" className="wb-bookmark-row" key={mark.id}>
        <button className="wb-bookmark-seek" aria-label={`${ui('jumpBookmark')} ${formatTime(mark.time)} ${mark.label}`} onClick={() => { onBookmarkSeek(mark.time); setShowBookmarks(false) }}>◆ {formatTime(mark.time)}</button>
        <input aria-label={`${ui('bookmarkName')} ${formatTime(mark.time)}`} key={`${mark.id}-${mark.label}`} defaultValue={mark.label} maxLength={200} onBlur={event => { if (event.target.value !== mark.label) onBookmarkEdit(mark.id, event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
        <button className="wb-text-button" aria-label={`${ui('deleteBookmark')} ${formatTime(mark.time)}`} onClick={() => onBookmarkDelete(mark.id)}>×</button>
      </article>)}
      {!bookmarks.length && <p className="wb-bookmark-empty">{ui('noBookmarks')}</p>}
    </div> : <div className="wb-transcript-list" ref={list} role="list" aria-label={ui('subtitles')}>
      {visible.map(cue => <article role="listitem" key={cue.id} data-transcript-id={cue.id} aria-current={active?.id === cue.id ? 'true' : undefined} className={`wb-transcript-row ${active?.id === cue.id ? 'is-current' : ''} ${selected.has(cue.id) ? 'is-checked' : ''}`}>
        <input className="wb-sentence-check" type="checkbox" aria-label={`${ui('checkSentence')} ${formatTime(cue.start)}`} checked={selected.has(cue.id)} readOnly onClick={event => check(cue, event.shiftKey)} />
        <button className="wb-transcript-seek" onClick={() => onSeek(cue)} title={`${formatTime(cue.start)} → ${formatTime(cue.end)}`} aria-label={`${formatTime(cue.start)} ${cue.text}`}><span className="wb-transcript-time">{formatTime(cue.start)}</span><span className="wb-transcript-text">{cue.text}</span></button>
        <div className="wb-sentence-actions"><button className="wb-transcript-edit" aria-label={`${ui('editSubtitle')} ${formatTime(cue.start)}`} onClick={() => { onSeek(cue); setEditing({ id: cue.id, text: cue.text }) }}>{ui('editSubtitle')}</button><button className={`wb-sentence-bookmark ${bookmarks.some(mark => Math.abs(mark.time - cue.start) < .05) ? 'is-marked' : ''}`} aria-label={`${ui('toggleBookmark')} ${formatTime(cue.start)}`} aria-pressed={bookmarks.some(mark => Math.abs(mark.time - cue.start) < .05)} title={ui('toggleBookmark')} onClick={() => onBookmark(cue.start, cue.text.trim().slice(0, 60))}>◆</button>{onAdd && <button className="wb-transcript-add" aria-label={`${ui('addSentence')} ${formatTime(cue.start)}`} title={ui('addSentence')} onClick={() => onAdd([cue])}>+</button>}</div>
        {editing?.id === cue.id && <div className="wb-transcript-editor">
          <textarea autoFocus aria-label={`${ui('subtitleText')} ${formatTime(cue.start)}`} maxLength={10000} rows={2} value={editing.text} onChange={event => setEditing({ id: cue.id, text: event.target.value })} onBlur={() => finishEdit()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); finishEdit(false) } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finishEdit() } }} />
          <div><button className="wb-text-button" onMouseDown={event => event.preventDefault()} onClick={() => finishEdit()}>{ui('finishSubtitle')}</button><button className="wb-text-button" onMouseDown={event => event.preventDefault()} onClick={() => finishEdit(false)}>{ui('cancelEdit')}</button><button className="wb-text-button" onMouseDown={event => event.preventDefault()} onClick={() => { setEditing(null); onDelete(cue.id) }}>{ui('deleteSubtitle')}</button></div>
        </div>}
      </article>)}
      {!visible.length && <div className="wb-no-captions"><p>{ui(cues.length ? 'noTranscriptMatches' : 'noSubtitles')}</p>{!cues.length && onImport && <button className="wb-button" onClick={onImport}>{ui('importSrt')}</button>}</div>}
    </div>}
    <div className="wb-transcript-footer"><span>{ui('selectedSentences', { count: selectedIds.length })}</span><label className="wb-follow-toggle"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />{ui('autoFollow')}</label><div className="wb-caption-selection-actions">{onRemove && <button className="wb-button" disabled={!selectedIds.length} onClick={() => onRemove(cues.filter(cue => selected.has(cue.id)))}>{ui('cutSelectedCaptions')}</button>}{onKeep && <button className="wb-button wb-button-accent" disabled={!selectedIds.length} onClick={() => onKeep(cues.filter(cue => selected.has(cue.id)))}>{ui('keepSelectedCaptions')}</button>}{onAdd && <button className="wb-button wb-button-accent" disabled={!selectedIds.length} onClick={() => onAdd()}>{ui('addSelection')}<span>+</span></button>}</div></div>
  </div>
}
