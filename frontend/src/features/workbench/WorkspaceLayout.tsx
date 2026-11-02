import { useRef, useState, type CSSProperties, type ReactNode } from 'react'

interface Props { preview: ReactNode; library: ReactNode; inspector: ReactNode; timeline: ReactNode; labels: [string, string, string] }
let remembered = [32, 43, 38]

/** Shared geometry for source editing and the selected finished clip. */
export default function WorkspaceLayout({ preview, library, inspector, timeline, labels }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState(() => [...remembered])
  const update = (index: number, value: number) => setSizes(current => {
    const next = [...current]; next[index] = Math.max(index === 1 ? 30 : 24, Math.min(index === 2 ? 65 : 56, value))
    remembered = next; return next
  })
  const separator = (index: number, horizontal = false) => <div className={`wb-resizer wb-resizer-${index}`} role="separator" tabIndex={0} aria-label={labels[index]} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuenow={Math.round(sizes[index])} aria-valuemin={index === 1 ? 30 : 24} aria-valuemax={index === 2 ? 65 : 56}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); update(index, sizes[index] + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -2 : 2)) } }}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId) || !box.current) return
      const rect = box.current.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * 100
      update(index, horizontal ? (rect.bottom - event.clientY) / rect.height * 100 : index === 0 ? x : (x - sizes[0]) / (100 - sizes[0]) * 100)
    }} />
  return <div className="wb-workspace-layout" ref={box} style={{ gridTemplateColumns: `minmax(230px,${sizes[0]}fr) 5px minmax(170px,${(100 - sizes[0]) * sizes[1] / 100}fr) 5px minmax(210px,${(100 - sizes[0]) * (100 - sizes[1]) / 100}fr)`, gridTemplateRows: `minmax(140px,${100 - sizes[2]}fr) 5px minmax(160px,${sizes[2]}fr)` } as CSSProperties}>
    <div className="wb-layout-preview">{preview}</div>{separator(0)}<div className="wb-layout-library">{library}</div>{separator(1)}<div className="wb-layout-inspector">{inspector}</div>{separator(2, true)}<div className="wb-layout-timeline">{timeline}</div>
  </div>
}
