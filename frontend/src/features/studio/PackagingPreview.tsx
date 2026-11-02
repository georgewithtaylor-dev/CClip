import type { CSSProperties } from 'react'
import type { Packaging } from './types'

const palettes: Record<string, [string, string]> = { azure: ['#5a8bff', '#1a1a19'], amber: ['#f2b544', '#1b1712'], coral: ['#ff6f59', '#1b1514'], mint: ['#46d3a6', '#111917'], lemon: ['#f4dc3c', '#141413'], rose: ['#ff7fa9', '#1b1418'], lilac: ['#b69cff', '#17151c'] }
export const packagingCanvas = (palette?: string | null) => (palettes[palette || 'azure'] || palettes.azure)[1]

/** Local draft preview in the ASS renderer's 1080x1920 coordinate system. */
export default function PackagingPreview({ packaging: pack, sourceTime, outputTime, aspect, subtitles }: { packaging: Packaging; sourceTime: number; outputTime: number; aspect: number; subtitles: boolean }) {
  const interview = pack.template === 'interview_zh'
  const style = pack.style || (interview ? 'classic' : 'pop')
  const cue = subtitles ? pack.cues.find(cue => cue.start <= sourceTime && sourceTime < cue.end) : undefined
  const title = interview || outputTime < 2.8
  const size = (px: number) => `${px / 1920 / aspect * 100}cqw`
  const captionY = interview ? pack.burned_captions ? 1400 : 1348 : style === 'cinematic' ? 1320 : 1400
  const pageSize = interview ? 14 : 11, chars = Array.from(cue?.text || '')
  const pageCount = Math.max(1, Math.ceil(chars.length / pageSize))
  const page = cue ? Math.min(pageCount - 1, Math.floor((sourceTime - cue.start) / Math.max(.02, cue.end - cue.start) * pageCount)) : 0
  const caption = chars.slice(page * pageSize, (page + 1) * pageSize).join('')
  const speaker = pack.speakers.find(speaker => sourceTime >= speaker.at && sourceTime < speaker.at + 3.2)
  const tag = pack.tags_enabled ? pack.tags.find(tag => sourceTime >= tag.at && sourceTime < tag.at + 1.8) : undefined
  return <div className={`studio-pack-preview studio-pack-${pack.template} studio-pack-${style}`} data-packaging-style={`${pack.template}:${style}`} style={{ '--pack-accent': (palettes[pack.palette || 'azure'] || palettes.azure)[0], '--pack-caption-size': size(style === 'boxed' ? 58 : interview ? 62 : style === 'cinematic' ? 64 : 82) } as CSSProperties}>
    {title && <div className="studio-pack-title" style={{ top: `${(interview ? 150 : 250) / 1920 * 100}%`, fontSize: size(interview ? 112 : 66), lineHeight: 1.34 }}>{pack.title_lines.map((line, index) => <div key={index} style={{ color: index === pack.title_accent_line ? 'var(--pack-accent)' : undefined, fontSize: interview && line.length > 9 ? size(1000 / line.length) : undefined }}>{line}</div>)}</div>}
    {cue && <div className="studio-pack-caption" style={{ top: `${captionY / 1920 * 100}%`, transform: pack.burned_captions && interview ? undefined : 'translate(-50%,-100%)' }}>{caption}</div>}
    {cue?.original && interview && !pack.burned_captions && <div className="studio-pack-original" style={{ top: '73.125%', fontSize: size(36) }}>{cue.original}</div>}
    {speaker && <div className="studio-pack-speaker" style={{ top: interview ? '90.6%' : '61.5%', fontSize: size(46) }}>{speaker.name}<small>{speaker.role}</small></div>}
    {tag && <div className="studio-pack-tag" style={{ fontSize: size(48) }}>{tag.text}</div>}
  </div>
}
