import { useEffect, useRef, useState, type RefObject } from 'react'
import { cclipSession } from '../../cclip/runtime'
import type { Draft } from './types'

type TemplateWindow = Window & { setData?: (data: unknown) => void; renderFrame?: (time: number) => void }
export default function HtmlPackagingPreview({ draft, time, video }: { draft: Draft; time: number; video: RefObject<HTMLVideoElement | null> }) {
  const frame = useRef<HTMLIFrameElement>(null), box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState([1, 1]), [data, setData] = useState<unknown>(), [ready, setReady] = useState(0)
  const snapshot = JSON.stringify(draft)
  const template = draft.packaging?.template
  useEffect(() => {
    const element = box.current
    if (!element) return
    const resize = () => setSize([element.clientWidth / 720, element.clientHeight / 1280])
    const observer = new ResizeObserver(resize); observer.observe(element); resize()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void cclipSession().then(session => fetch('/api/workbench/template-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-session': session }, body: snapshot, signal: controller.signal }))
        .then(async response => { if (!response.ok) throw new Error('preview'); return response.json() }).then(setData).catch(() => undefined)
    }, 100)
    return () => { clearTimeout(timer); controller.abort() }
  }, [snapshot])
  useEffect(() => {
    const target = frame.current?.contentWindow as TemplateWindow | null
    if (data && target?.setData) { target.setData(data); target.renderFrame?.(time) }
  }, [data, ready, time])
  useEffect(() => {
    const media = video.current, document = frame.current?.contentDocument
    if (!media || !document?.body || !ready) return
    // WebView2 paints an iframe's transparent canvas white. Composite the
    // already-decoded video inside that canvas; never start a second decoder.
    const canvas = document.createElement('canvas')
    canvas.width = 720; canvas.height = 1280
    canvas.dataset.videoBackdrop = 'true'
    canvas.style.cssText = 'position:absolute;inset:0;z-index:-1;width:720px;height:1280px;pointer-events:none'
    const isolation = document.body.style.isolation
    document.body.style.isolation = 'isolate'; document.body.prepend(canvas)
    const context = canvas.getContext('2d')
    let callback: number | undefined, animation: number | undefined, stopped = false
    const draw = () => {
      const bounds = box.current?.getBoundingClientRect(), rect = media.getBoundingClientRect()
      if (!context || media.readyState < 2 || !media.videoWidth || !bounds?.width || !bounds.height) return
      const style = getComputedStyle(media)
      const x = (rect.left - bounds.left) * 720 / bounds.width, y = (rect.top - bounds.top) * 1280 / bounds.height
      const width = rect.width * 720 / bounds.width, height = rect.height * 1280 / bounds.height
      if (!width || !height) return
      const scale = (style.objectFit === 'cover' ? Math.max : Math.min)(width / media.videoWidth, height / media.videoHeight)
      const w = media.videoWidth * scale, h = media.videoHeight * scale
      const position = (style.objectPosition || '50% 50%').split(' ').map(value => Number.parseFloat(value) / 100)
      context.fillStyle = '#000'; context.fillRect(0, 0, 720, 1280)
      context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip()
      context.drawImage(media, x + (width - w) * position[0], y + (height - h) * (position[1] ?? .5), w, h)
      context.restore()
    }
    const next = () => {
      if (stopped) return
      draw()
      if (media.requestVideoFrameCallback) callback = media.requestVideoFrameCallback(next)
      else animation = requestAnimationFrame(next)
    }
    const observer = new ResizeObserver(draw); observer.observe(media)
    media.addEventListener('loadeddata', draw); media.addEventListener('seeked', draw)
    next()
    return () => {
      stopped = true
      if (callback !== undefined) media.cancelVideoFrameCallback(callback)
      if (animation !== undefined) cancelAnimationFrame(animation)
      observer.disconnect(); media.removeEventListener('loadeddata', draw); media.removeEventListener('seeked', draw)
      canvas.remove(); document.body.style.isolation = isolation
    }
  }, [ready, template, video, snapshot])
  return <div className="studio-html-pack-preview" ref={box} data-packaging-style={template}><iframe key={template} ref={frame} title={template} src={`/api/workbench/template-assets/${template}/index.html`} onLoad={() => setReady(value => value + 1)} tabIndex={-1} style={{ transform: `scale(${size[0]},${size[1]})` }} /></div>
}
