import { useEffect, useState } from 'react'
import { LocalClient } from './localApi'

interface Waveform { version: number; duration: number; step: number; hasAudio: boolean; peaks: number[] }
const cache = new Map<string, Promise<Waveform>>()
const client = new LocalClient()
export default function AudioWaveform({ url, origin, scale, visibleStart, visibleEnd, label, loadingLabel, unavailableLabel }: {
  url?: string; origin: number; scale: number; visibleStart: number; visibleEnd: number; label: string; loadingLabel: string; unavailableLabel: string
}) {
  const [data, setData] = useState<Waveform>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!url) return
    let live = true
    setData(undefined); setFailed(false)
    let task = cache.get(url)
    if (!task) {
      task = client.connect().then(() => client.request<Waveform>(url))
      cache.set(url, task)
      task.catch(() => cache.delete(url))
    }
    void task.then(value => { if (live) setData(value) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [url])
  if (!url) return null
  if (!data) return <span className="wb-waveform-state" role="status">{failed ? unavailableLabel : loadingLabel}</span>
  if (!data.hasAudio) return <span className="wb-waveform-state">{unavailableLabel}</span>
  const left = Math.max(0, (visibleStart - origin) * scale), right = Math.max(left, (visibleEnd - origin) * scale)
  const segments: string[] = []
  for (let x = left; x < right; x += 2) {
    const start = Math.max(0, Math.floor((origin + x / scale) / data.step))
    const end = Math.min(data.peaks.length, Math.max(start + 1, Math.ceil((origin + (x + 2) / scale) / data.step)))
    let peak = 0
    for (let i = start; i < end; i++) peak = Math.max(peak, data.peaks[i])
    const height = peak / 255 * 16
    segments.push(`M${(x - left).toFixed(1)},${(20 - height).toFixed(1)}v${(height * 2).toFixed(1)}`)
  }
  return <svg className="wb-waveform" role="img" aria-label={label} data-peaks={data.peaks.length} style={{ left, width: right - left }} height="40" viewBox={`0 0 ${Math.max(1, right - left)} 40`} preserveAspectRatio="none"><path d={segments.join('')} /></svg>
}
