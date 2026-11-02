export interface Source {
  name: string
  duration: number
  kind: 'demo' | 'local'
  bytes?: number
  width?: number
  height?: number
  assetId?: string
}
export interface Clip { id: string; name: string; start: number; end: number; color: number; origin?: 'ai' | 'manual' }
export interface Cue { id: string; start: number; end: number; text: string }
export interface Bookmark { id: string; time: number; label: string }
export interface TimeRange { start: number; end: number }
export interface TimelineOutput extends TimeRange { id: string; draftId: string; label: string; status: string; lane: number; number?: number; color?: string }
export interface Project {
  schemaVersion: 1
  title: string
  source: Source
  clips: Clip[]
  cues: Cue[]
  highlights?: Clip[]
  demoTranscriptVersion?: 2
  bookmarks?: Bookmark[]
  localId?: string
  localRevision?: number
}
export interface History { past: Project[]; present: Project; future: Project[] }
export const STORAGE_KEY = 'autoclip.workbench.draft.v1'
export const MIN_CLIP = 0.12
export const duration = (project: Project) => project.clips.reduce((total, clip) => total + clip.end - clip.start, 0)
export const offsetOf = (project: Project, id: string) => {
  let offset = 0
  for (const clip of project.clips) {
    if (clip.id === id) return offset
    offset += clip.end - clip.start
  }
  return 0
}
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export function programPosition(project: Project, time: number) {
  let offset = 0
  const bounded = clamp(time, 0, duration(project))
  for (let index = 0; index < project.clips.length; index += 1) {
    const clip = project.clips[index]
    const length = clip.end - clip.start
    if (bounded < offset + length || index === project.clips.length - 1) {
      return { clip, index, offset, sourceTime: clip.start + clamp(bounded - offset, 0, length) }
    }
    offset += length
  }
  return null
}

export function sourcePosition(project: Project, time: number, preferredId?: string) {
  const candidates = project.clips.filter(clip => clip.start <= time && time < clip.end)
  const clip = candidates.find(candidate => candidate.id === preferredId) || candidates[0]
  return clip ? { clip, time: offsetOf(project, clip.id) + time - clip.start } : null
}

export function validateProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const p = value as Project
  if (p.schemaVersion !== 1 || typeof p.title !== 'string' || p.title.length > 200) return false
  if (!p.source || !['demo', 'local'].includes(p.source.kind) || typeof p.source.name !== 'string') return false
  if (!Number.isFinite(p.source.duration) || p.source.duration <= 0 || p.source.duration > 86400) return false
  if (p.source.bytes !== undefined && (!Number.isSafeInteger(p.source.bytes) || p.source.bytes < 0)) return false
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (p.source.assetId !== undefined && !uuid.test(p.source.assetId)) return false
  if (p.localId !== undefined && !uuid.test(p.localId)) return false
  if (p.localRevision !== undefined && (!Number.isSafeInteger(p.localRevision) || p.localRevision < 1)) return false
  if (!Array.isArray(p.clips) || !Array.isArray(p.cues) || p.clips.length > 10000 || p.cues.length > 50000) return false
  const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 100
  if (new Set(p.clips.map(clip => clip?.id)).size !== p.clips.length || new Set(p.cues.map(cue => cue?.id)).size !== p.cues.length) return false
  const validClip = (clip: Clip) => clip && validId(clip.id) && typeof clip.name === 'string' && clip.name.length <= 200
    && Number.isInteger(clip.color) && clip.color >= 0 && clip.color <= 3
    && Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0
    && clip.end - clip.start >= MIN_CLIP - 0.00001 && clip.end <= p.source.duration + 0.001
    && (clip.origin === undefined || clip.origin === 'ai' || clip.origin === 'manual')
  if (!p.clips.every(validClip)) return false
  if (p.highlights !== undefined && (!Array.isArray(p.highlights) || p.highlights.length > 10000
    || !p.highlights.every(clip => validClip(clip) && clip.origin !== 'manual') || new Set(p.highlights.map(clip => clip.id)).size !== p.highlights.length)) return false
  if (p.demoTranscriptVersion !== undefined && p.demoTranscriptVersion !== 2) return false
  if (p.bookmarks !== undefined && (!Array.isArray(p.bookmarks) || p.bookmarks.length > 10000
    || !p.bookmarks.every(mark => mark && validId(mark.id) && Number.isFinite(mark.time) && mark.time >= 0
      && mark.time <= p.source.duration && typeof mark.label === 'string' && mark.label.length <= 200)
    || new Set(p.bookmarks.map(mark => mark.id)).size !== p.bookmarks.length)) return false
  return p.cues.every(cue => cue && validId(cue.id) && typeof cue.text === 'string' && cue.text.length <= 10000
    && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start
    && cue.end <= p.source.duration + 0.001)
}

// Consecutive checked sentences form a continuous range, preserving their natural pauses.
// Non-consecutive selections remain separate clips; intervening unselected speech is excluded.
export function rangesFromCues(cues: Cue[], selectedIds: string[]): TimeRange[] {
  const selected = new Set(selectedIds)
  const ranges: TimeRange[] = []
  let previousSelected = false
  for (const cue of [...cues].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!selected.has(cue.id)) { previousSelected = false; continue }
    const previous = ranges[ranges.length - 1]
    if (previous && previousSelected) previous.end = Math.max(previous.end, cue.end)
    else ranges.push({ start: cue.start, end: cue.end })
    previousSelected = true
  }
  return ranges
}

export function appendManualClips(project: Project, ranges: TimeRange[], ids: string[], name: string): Project {
  if (!ranges.length || ranges.length !== ids.length || ranges.some(range => !Number.isFinite(range.start)
    || !Number.isFinite(range.end) || range.start < 0 || range.end > project.source.duration
    || range.end - range.start < MIN_CLIP)) throw new Error('invalidRange')
  const clips: Clip[] = ranges.map((range, index) => ({ ...range, id: ids[index], name: ranges.length > 1 ? `${name} ${index + 1}` : name, color: 1, origin: 'manual' }))
  const next = { ...project, clips: [...project.clips, ...clips] }
  if (!validateProject(next)) throw new Error('invalidProject')
  return next
}

export function removeSourceRanges(project: Project, ranges: TimeRange[]): Project {
  const cuts = ranges.filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start && range.end <= project.source.duration)
  const clips = project.clips.flatMap(clip => {
    let kept = [{ start: clip.start, end: clip.end }]
    for (const cut of cuts) kept = kept.flatMap(range => cut.end <= range.start || cut.start >= range.end ? [range] : [
      { start: range.start, end: Math.max(range.start, cut.start) }, { start: Math.min(range.end, cut.end), end: range.end },
    ].filter(item => item.end - item.start >= MIN_CLIP))
    const changed = kept.length !== 1 || kept[0].start !== clip.start || kept[0].end !== clip.end
    return kept.map((range, index) => ({ ...clip, ...range, origin: changed ? 'manual' as const : clip.origin, id: index === 0 ? clip.id : crypto.randomUUID() }))
  })
  const next = { ...project, clips }
  if (!validateProject(next)) throw new Error('invalidRange')
  return next
}

const demoHighlights: Clip[] = [
  { id: 'clip-a', name: '开场：让观众留下来', start: 134, end: 180, color: 0, origin: 'ai' },
  { id: 'clip-b', name: '一个容易忽略的小细节', start: 392, end: 437, color: 1, origin: 'ai' },
  { id: 'clip-c', name: '把方法变成下一步行动', start: 738, end: 790, color: 2, origin: 'ai' },
]
const extraDemoCues: Cue[] = [
  { id: 'source-01', start: 0, end: 13, text: '大家好，今天先聊聊分享内容时常遇到的问题。' },
  { id: 'source-02', start: 18, end: 34, text: '我们先把完整过程讲一遍，再回头看哪些地方最有价值。' },
  { id: 'source-03', start: 42, end: 58, text: '有些背景信息不一定精彩，却能帮助大家理解后面的例子。' },
  { id: 'source-04', start: 66, end: 82, text: '先想一想，观众打开这段视频的时候，最想知道什么。' },
  { id: 'source-05', start: 92, end: 111, text: '如果问题说得太宽泛，听的人可能很难抓住重点。' },
  { id: 'source-06', start: 118, end: 131, text: '所以我会先准备一个具体的问题，把今天的话题串起来。' },
  { id: 'source-07', start: 188, end: 204, text: '刚才讲了开场，下面补充一个在现场遇到的情况。' },
  { id: 'source-08', start: 212, end: 230, text: '有人问，准备得越充分，是不是就应该把所有材料都讲出来。' },
  { id: 'source-09', start: 236, end: 253, text: '我的看法是，准备可以多一些，表达的时候仍然要有所选择。' },
  { id: 'source-10', start: 264, end: 280, text: '这和做 presentation 很像，材料多并不等于表达清楚。' },
  { id: 'source-11', start: 294, end: 311, text: '我们可以先讲结论，再用一个大家熟悉的例子解释原因。' },
  { id: 'source-12', start: 324, end: 342, text: '如果听众还想了解细节，再把相关背景补充进去。' },
  { id: 'source-13', start: 355, end: 372, text: '刚才这几个问题，其实都和信息的顺序有关。' },
  { id: 'source-14', start: 445, end: 464, text: '说到这里，我们再看一个不太一样的场景。' },
  { id: 'source-15', start: 477, end: 495, text: '当观众已经了解背景，就可以把重点放在具体做法上。' },
  { id: 'source-16', start: 508, end: 528, text: '可以把步骤写成一张很短的 checklist，方便回头核对。' },
  { id: 'source-17', start: 542, end: 561, text: '每一步都说明要做什么，以及怎样判断已经完成。' },
  { id: 'source-18', start: 574, end: 592, text: '如果条件发生变化，方法也要跟着调整，不必机械照搬。' },
  { id: 'source-19', start: 606, end: 625, text: '大家也可以记录自己的例子，这样分享的时候会更自然。' },
  { id: 'source-20', start: 640, end: 659, text: '接下来留一点时间，把前面的内容连起来看。' },
  { id: 'source-21', start: 677, end: 696, text: '先明确问题，再组织信息，最后给出一个能执行的步骤。' },
  { id: 'source-22', start: 712, end: 730, text: '这里面没有固定模板，重要的是听众能理解并且用得上。' },
  { id: 'source-23', start: 801, end: 819, text: '方法讲完以后，大家最常问的是，第一步应该从哪里开始。' },
  { id: 'source-24', start: 834, end: 852, text: '我建议找一个很小的主题，先完整做一次，再观察结果。' },
  { id: 'source-25', start: 867, end: 884, text: '也可以请熟悉的人听一遍，看看哪些地方还需要补充说明。' },
  { id: 'source-26', start: 900, end: 919, text: '如果某一段解释得特别清楚，可以单独留下来，之后继续使用。' },
  { id: 'source-27', start: 939, end: 958, text: '回看时不只找最热闹的瞬间，也看看有没有容易被忽略的内容。' },
  { id: 'source-28', start: 977, end: 996, text: '比如一个完整的案例，有时比一句很短的结论更能帮助别人。' },
  { id: 'source-29', start: 1016, end: 1034, text: '当然，片段前后仍然要说得通，不能只留下半句话。' },
  { id: 'source-30', start: 1054, end: 1073, text: '我们今天提到的这些方法，都可以从小范围尝试开始。' },
  { id: 'source-31', start: 1092, end: 1111, text: '试过以后，再把有效的部分整理成适合自己的习惯。' },
  { id: 'source-32', start: 1130, end: 1148, text: '最后再回答一个问题，然后今天的分享就到这里。' },
  { id: 'source-33', start: 1161, end: 1177, text: '谢谢大家提出这些具体的问题，也欢迎下次继续交流。' },
  { id: 'source-34', start: 1185, end: 1200, text: '今天先到这里，我们下次再见。' },
]

// Add only newly introduced fictional material to an identifiable legacy demo.
// Imported SRTs, local recordings, edited existing sentences and removed old sentences are preserved.
export function prepareProject(project: Project): Project {
  const canonicalDemo = project.source.kind === 'demo' && project.source.name === '示例直播录屏.mp4' && project.source.duration === 1200
  const legacyDemoText = canonicalDemo && !project.demoTranscriptVersion && project.cues.length > 0
    && project.cues.every(cue => /^cue-[abc]\d+$/.test(cue.id))
  return {
    ...project,
    highlights: project.highlights ?? (canonicalDemo ? demoHighlights.map(clip => ({ ...clip })) : []),
    ...(legacyDemoText ? { cues: [...project.cues, ...extraDemoCues.map(cue => ({ ...cue }))].sort((a, b) => a.start - b.start), demoTranscriptVersion: 2 as const } : {}),
  }
}

export function commit(history: History, next: Project): History {
  if (!validateProject(next)) throw new Error('invalidProject')
  if (JSON.stringify(next) === JSON.stringify(history.present)) return history
  return { past: [...history.past.slice(-49), history.present], present: next, future: [] }
}
export function undo(history: History): History {
  if (!history.past.length) return history
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1], future: [history.present, ...history.future] }
}
export function redo(history: History): History {
  if (!history.future.length) return history
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) }
}

export function splitClip(project: Project, id: string, sourceTime: number, newId: string): Project {
  const clip = project.clips.find(item => item.id === id)
  if (!clip || !Number.isFinite(sourceTime) || sourceTime - clip.start < MIN_CLIP || clip.end - sourceTime < MIN_CLIP) throw new Error('splitBoundary')
  return { ...project, clips: project.clips.flatMap(item => item.id === id
    ? [{ ...item, end: sourceTime, origin: 'manual' as const }, { ...item, id: newId, start: sourceTime, origin: 'manual' as const }]
    : [item]) }
}
export function trimClip(project: Project, id: string, start: number, end: number): Project {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > project.source.duration || end - start < MIN_CLIP) throw new Error('invalidRange')
  return { ...project, clips: project.clips.map(clip => clip.id === id ? { ...clip, start, end, origin: 'manual' as const } : clip) }
}
export function moveClip(project: Project, id: string, step: -1 | 1): Project {
  const index = project.clips.findIndex(clip => clip.id === id)
  const target = index + step
  if (index < 0 || target < 0 || target >= project.clips.length) return project
  const clips = [...project.clips]
  clips[index] = { ...clips[index], origin: 'manual' }
  ;[clips[index], clips[target]] = [clips[target], clips[index]]
  return { ...project, clips }
}

export function outputCues(project: Project): Cue[] {
  let offset = 0
  return project.clips.flatMap(clip => {
    const cues = project.cues.filter(cue => cue.text.trim() && cue.start < clip.end && cue.end > clip.start)
      .map(cue => ({ ...cue, id: `${clip.id}:${cue.id}`, start: offset + Math.max(cue.start, clip.start) - clip.start, end: offset + Math.min(cue.end, clip.end) - clip.start }))
      .sort((a, b) => a.start - b.start)
    offset += clip.end - clip.start
    return cues
  })
}
export function formatTime(time: number, decimals = false) {
  const total = Math.round(Math.max(0, time) * (decimals ? 10 : 1))
  const seconds = decimals ? Math.floor(total / 10) : total
  const result = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':')
  return result + (decimals ? `.${total % 10}` : '')
}
function srtTime(time: number) {
  const ms = Math.round(Math.max(0, time) * 1000)
  const sec = Math.floor(ms / 1000)
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(n => String(n).padStart(2, '0')).join(':') + `,${String(ms % 1000).padStart(3, '0')}`
}
export function exportSrt(project: Project) {
  return outputCues(project).map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n')
}
export function parseSrt(text: string, sourceDuration: number): Cue[] {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/)
  const cues = blocks.map((block, index) => {
    const lines = block.split('\n')
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift()
    const match = lines.shift()?.match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s*-->\s*(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s*$/)
    if (!match) throw new Error('invalidSrt')
    const values = match.slice(1).map(Number)
    const start = values[0] * 3600 + values[1] * 60 + values[2] + values[3] / 1000
    const end = values[4] * 3600 + values[5] * 60 + values[6] + values[7] / 1000
    const content = lines.join('\n').trim()
    if (!content || content.length > 10000 || end <= start || end > sourceDuration + 0.001) throw new Error('invalidSrt')
    return { id: `srt-${index}`, start, end, text: content }
  })
  if (cues.length > 50000) throw new Error('invalidSrt')
  return cues.sort((a, b) => a.start - b.start)
}

// Fictional demonstration content, unrelated to the user's private test recordings.
export function demoProject(): Project {
  return {
    schemaVersion: 1,
    title: '直播精剪 · 示例项目',
    source: { name: '示例直播录屏.mp4', duration: 1200, kind: 'demo', width: 1080, height: 1920 },
    clips: demoHighlights.map(clip => ({ ...clip })),
    highlights: demoHighlights.map(clip => ({ ...clip })),
    demoTranscriptVersion: 2,
    cues: [
      { id: 'cue-a1', start: 134, end: 142, text: '一场直播，值得留下的不止一个瞬间。' },
      { id: 'cue-a2', start: 142, end: 151, text: '先把观众最关心的问题说清楚。' },
      { id: 'cue-a3', start: 151, end: 161, text: '把真正有价值的内容，放在前面。' },
      { id: 'cue-a4', start: 161, end: 171, text: '好的开场，是让人愿意继续听下去。' },
      { id: 'cue-a5', start: 171, end: 180, text: '接下来，我们用一个例子说说。' },
      { id: 'cue-b1', start: 392, end: 404, text: '有时候，差别就藏在一个小细节里。' },
      { id: 'cue-b2', start: 404, end: 416, text: '先讲清楚为什么，再讲怎么做。' },
      { id: 'cue-b3', start: 416, end: 427, text: 'Keep it simple，让信息更容易被记住。' },
      { id: 'cue-b4', start: 427, end: 437, text: '这也是我们今天最想分享的经验。' },
      { id: 'cue-c1', start: 738, end: 753, text: '最后，把今天的方法变成一个小行动。' },
      { id: 'cue-c2', start: 753, end: 767, text: '从最容易完成的那一步开始。' },
      { id: 'cue-c3', start: 767, end: 780, text: '试一试，再根据结果慢慢调整。' },
      { id: 'cue-c4', start: 780, end: 790, text: '让每一次分享，都留下值得回看的内容。' },
      ...extraDemoCues.map(cue => ({ ...cue })),
    ].sort((a, b) => a.start - b.start),
  }
}

export const clipColor = (index: number) => ['#b4db89', '#9bb8ef', '#c0a5dc', '#e0c177', '#7fcbb8', '#e3a5aa', '#93c1db', '#d2af83', '#e9a66c', '#c3cf6c', '#69c4dc', '#c599e9', '#ed92c2', '#70c99a', '#b8bfe9', '#d4b9aa'][Math.max(0, index) % 16]
