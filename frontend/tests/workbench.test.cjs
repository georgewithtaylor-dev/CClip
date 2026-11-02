const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript')
function load(name) {
  const file = path.resolve(__dirname, `../src/features/workbench/${name}.ts`), m = new Module(file, module)
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
  return m.exports
}
const m = load('model')
const project = () => ({ schemaVersion: 1, title: 'Synthetic fixture', source: { name: 'fixture.mp4', duration: 300, kind: 'demo' }, clips: [
  { id: 'a', name: 'a', start: 100, end: 110, color: 0 }, { id: 'b', name: 'b', start: 200, end: 210, color: 1 },
], cues: [{ id: 'one', start: 105, end: 108, text: 'Synthetic caption' }, { id: 'two', start: 201, end: 205, text: 'Another caption' }] })

test('source and output positions remain distinct, including repeated source footage', () => {
  const p = project()
  assert.equal(m.programPosition(p, 11).sourceTime, 201)
  assert.equal(m.sourcePosition(p, 201).time, 11)
  assert.equal(m.sourcePosition(p, 150), null)
  assert.equal(m.programPosition(p, 10).clip.id, 'b')
  assert.equal(m.programPosition(p, 20).sourceTime, 210)
  p.clips.push({ ...p.clips[0], id: 'repeat' })
  assert.equal(m.sourcePosition(p, 105, 'repeat').time, 25)
})

test('subtitles follow reordered, trimmed and deleted source spans', () => {
  const p = project()
  assert.deepEqual(m.outputCues(p).map(c => [c.start, c.end]), [[5, 8], [11, 15]])
  const trimmed = m.trimClip(p, 'a', 106, 110)
  assert.deepEqual(m.outputCues(trimmed).map(c => [c.start, c.end]), [[0, 2], [5, 9]])
  const reordered = m.moveClip(trimmed, 'b', -1)
  assert.deepEqual(m.outputCues(reordered).map(c => [c.start, c.end]), [[1, 5], [10, 12]])
  assert.match(m.exportSrt({ ...p, clips: [p.clips[1]] }), /00:00:01,000 --> 00:00:05,000/)
  assert.equal(p.clips[0].start, 100)
})

test('splitting preserves source coverage; undo and redo restore exact identities and captions', () => {
  const p = project(), original = JSON.stringify(p)
  const split = m.splitClip(p, 'a', 106, 'a2')
  assert.deepEqual(split.clips.map(c => [c.id, c.start, c.end]), [['a', 100, 106], ['a2', 106, 110], ['b', 200, 210]])
  assert.equal(m.duration(split), m.duration(p))
  let history = m.commit({ past: [], present: p, future: [] }, split)
  history = m.commit(history, { ...history.present, cues: history.present.cues.map(c => ({ ...c, text: 'edited' })) })
  assert.equal(m.duration(history.present), 20, 'editing text never changes media duration')
  const undone = m.undo(m.undo(history))
  assert.equal(JSON.stringify(undone.present), original)
  assert.equal(m.redo(m.redo(undone)).present.cues[0].text, 'edited')
  assert.equal(m.commit(m.undo(history), p).future.length, 0, 'a new edit invalidates redo')
})

test('invalid boundaries cannot enter the saved draft; an empty sequence remains recoverable', () => {
  const p = project()
  for (const [start, end] of [[-1, 3], [4, 4], [0, 301], [NaN, 5], [0, Infinity]]) assert.throws(() => m.trimClip(p, 'a', start, end))
  assert.throws(() => m.splitClip(p, 'a', 100, 'bad'))
  assert.throws(() => m.splitClip(p, 'a', 109.99, 'bad'))
  assert.equal(m.validateProject({ ...p, clips: [p.clips[0], p.clips[0]] }), false)
  assert.equal(m.validateProject({ ...p, source: { ...p.source, duration: '300' } }), false)
  assert.equal(m.validateProject({ ...p, clips: [null] }), false)
  const empty = m.commit({ past: [], present: p, future: [] }, { ...p, clips: [] })
  assert.equal(m.programPosition(empty.present, 0), null)
  assert.equal(m.exportSrt(empty.present), '')
  assert.equal(m.undo(empty).present.clips.length, 2)
})

test('new editor accepts more than 30 short segments and validates restored drafts', () => {
  const p = project()
  p.clips = Array.from({ length: 80 }, (_, index) => ({ id: `clip-${index}`, name: 'clip', start: index, end: index + .5, color: index % 4 }))
  assert.equal(m.validateProject(p), true)
  assert.equal(m.duration(p), 40)
  assert.equal(m.validateProject(JSON.parse(JSON.stringify(p))), true)
})

test('SRT imports preserve text and times, reject malformed/out-of-source input, and export milliseconds correctly', () => {
  const cues = m.parseSrt('\uFEFF1\r\n00:00:01,125 --> 00:00:02,250\r\n中英 mixed\r\n第二行\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nSecond', 10)
  assert.equal(cues[0].text, '中英 mixed\n第二行')
  assert.equal(cues[0].start, 1.125)
  assert.throws(() => m.parseSrt('1\n00:00:01,000 --> 00:00:12,000\nToo long', 10))
  assert.throws(() => m.parseSrt('1\n00:00:02,000 --> 00:00:01,000\nReversed', 10))
  assert.throws(() => m.parseSrt('', 10))
  const p = { ...project(), source: { name: 'fixture.mp4', kind: 'demo', duration: 10 }, clips: [{ id: 'x', name: 'x', start: 0, end: 10, color: 0 }], cues }
  assert.match(m.exportSrt(p), /00:00:01,125 --> 00:00:02,250/)
  assert.equal(m.formatTime(59.96, true), '00:01:00.0')
})

test('all eight workbench locales provide every message and preserve substitution values', () => {
  const { messages, languages, translate } = load('strings')
  assert.equal(languages.length, 8)
  for (const row of messages) {
    assert.equal(row.length, 9, row[0])
    assert.equal(new Set(messages.map(message => message[0])).size, messages.length)
    for (const [language] of languages) assert.ok(translate(language, row[0]).trim(), `${language}:${row[0]}`)
  }
  assert.match(translate('zh', 'clipCount', { count: 12 }), /12/)
})

test('independent entry cannot initialize the legacy app or third-party analytics', () => {
  const root = path.resolve(__dirname, '../src/features/workbench')
  for (const file of fs.readdirSync(root).filter(name => /\.tsx?$/.test(name))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /from\s+['"](?:\.\.\/|.*(?:analytics|sentry|services\/api))/i, file)
    if (file !== 'localApi.ts') assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/, file)
  }
  const api = fs.readFileSync(path.join(root, 'localApi.ts'), 'utf8')
  assert.match(api, /path\.startsWith\('\/api\/workbench\/'\)/)
  assert.match(api, /credentials: 'same-origin'/)
  const html = fs.readFileSync(path.resolve(__dirname, '../workbench.html'), 'utf8')
  assert.match(html, /connect-src 'self' ws:\/\/127\.0\.0\.1:3100;/)
  assert.match(html, /form-action 'none'/)
})

test('adjacent transcript sentences preserve pauses while non-adjacent choices form separate ranges', () => {
  const cues = [{ id: 'a', start: 10, end: 15 }, { id: 'b', start: 18, end: 24 }, { id: 'c', start: 30, end: 38 }]
  assert.deepEqual(m.rangesFromCues(cues, ['a', 'b']), [{ start: 10, end: 24 }])
  assert.deepEqual(m.rangesFromCues(cues, ['a', 'c']), [{ start: 10, end: 15 }, { start: 30, end: 38 }])
  assert.deepEqual(m.rangesFromCues([...cues].reverse(), ['b', 'a']), [{ start: 10, end: 24 }])
  assert.deepEqual(m.rangesFromCues(cues, ['missing']), [])
})

test('manual ranges outside AI choices can be added and undone without modifying the source or recommendations', () => {
  const original = { ...project(), highlights: [{ ...project().clips[0], origin: 'ai' }] }
  const next = m.appendManualClips(original, [{ start: 20, end: 40 }], ['manual'], 'Manual')
  assert.equal(next.clips.length, 3)
  assert.deepEqual(next.clips.at(-1), { id: 'manual', name: 'Manual', start: 20, end: 40, color: 1, origin: 'manual' })
  assert.equal(next.source, original.source)
  assert.equal(next.cues, original.cues)
  assert.equal(next.highlights, original.highlights)
  const history = m.commit({ past: [], present: original, future: [] }, next)
  assert.deepEqual(m.undo(history).present, original)
  assert.deepEqual(m.redo(m.undo(history)).present, next)
  assert.throws(() => m.appendManualClips(original, [{ start: -1, end: 2 }], ['bad'], 'bad'))
  assert.throws(() => m.appendManualClips(original, [{ start: 0, end: 2 }], [], 'bad'))
})

test('AI recommendations survive removing their clips from the edit and validate separately', () => {
  const p = m.demoProject()
  const empty = { ...p, clips: [] }
  assert.equal(m.validateProject(empty), true)
  assert.equal(empty.highlights.length, 3)
  assert.equal(m.validateProject({ ...p, highlights: [{ ...p.highlights[0], end: 99999 }] }), false)
  assert.equal(m.validateProject({ ...p, highlights: [p.highlights[0], p.highlights[0]] }), false)
  assert.equal(m.validateProject({ ...p, highlights: [{ ...p.highlights[0], origin: 'manual' }] }), false)
  assert.equal(m.validateProject({ ...p, clips: [{ ...p.clips[0], origin: 'unknown' }] }), false)
})

test('the complete fictional transcript includes speech outside every AI-picked range', () => {
  const p = m.demoProject()
  assert.equal(p.source.duration, 1200)
  assert.equal(p.cues[0].start, 0)
  assert.equal(p.cues.at(-1).end, 1200)
  assert.ok(p.cues.some(cue => cue.start === 212 && !p.highlights.some(clip => clip.start <= cue.start && cue.start < clip.end)))
  assert.ok(p.cues.length > 40)
})

test('legacy demo enrichment preserves edits and deleted old sentences, and never mixes fictional text into imports', () => {
  const current = m.demoProject()
  const legacyCues = current.cues.filter(cue => cue.id.startsWith('cue-') && cue.id !== 'cue-a2').map(cue => ({ ...cue, text: cue.id === 'cue-a1' ? 'User edit' : cue.text }))
  const legacy = { ...current, cues: legacyCues, highlights: undefined, demoTranscriptVersion: undefined }
  const upgraded = m.prepareProject(legacy)
  assert.equal(upgraded.cues.find(cue => cue.id === 'cue-a1').text, 'User edit')
  assert.equal(upgraded.cues.some(cue => cue.id === 'cue-a2'), false)
  assert.ok(upgraded.cues.some(cue => cue.id === 'source-08'))
  assert.equal(legacy.cues.length, legacyCues.length)
  assert.equal(m.prepareProject(upgraded).cues.length, upgraded.cues.length)
  const afterDelete = { ...upgraded, cues: upgraded.cues.filter(cue => cue.id !== 'source-08') }
  assert.equal(m.prepareProject(afterDelete).cues.some(cue => cue.id === 'source-08'), false)
  const imported = { ...legacy, cues: [{ id: 'srt-0', start: 0, end: 10, text: 'Imported' }] }
  assert.deepEqual(m.prepareProject(imported).cues, imported.cues)
  const local = { ...legacy, source: { ...legacy.source, kind: 'local' } }
  assert.deepEqual(m.prepareProject(local).cues, local.cues)
  assert.equal(m.prepareProject(local).highlights.length, 0)
  assert.equal(m.validateProject(upgraded), true)
})

test('bookmarks survive JSON save and undo, while invalid or duplicated source positions are rejected', () => {
  const p = project()
  const marked = { ...p, bookmarks: [{ id: 'marker', time: 150, label: 'Review this context' }] }
  assert.equal(m.validateProject(JSON.parse(JSON.stringify(marked))), true)
  const history = m.commit({ past: [], present: p, future: [] }, marked)
  assert.deepEqual(m.redo(m.undo(history)).present.bookmarks, marked.bookmarks)
  for (const time of [-1, 301, NaN, Infinity]) assert.equal(m.validateProject({ ...marked, bookmarks: [{ ...marked.bookmarks[0], time }] }), false)
  assert.equal(m.validateProject({ ...marked, bookmarks: marked.bookmarks.concat(marked.bookmarks) }), false)
})

test('cleanup cuts only selected source ranges, keeps full transcript and bookmarks, and is reversible', () => {
  const p = { ...project(), bookmarks: [{ id: 'm', time: 105, label: 'Keep note' }] }
  const next = m.removeSourceRanges(p, [{ start: 103, end: 106 }, { start: 107, end: 108 }])
  assert.deepEqual(next.clips.map(c => [c.start, c.end]), [[100, 103], [106, 107], [108, 110], [200, 210]])
  assert.equal(next.cues, p.cues)
  assert.equal(next.bookmarks, p.bookmarks)
  assert.equal(m.duration(next), 16)
  assert.equal(m.undo(m.commit({ past: [], present: p, future: [] }, next)).present, p)
})

test('local client serializes saves after undo and rejects any nonlocal API path', async () => {
  const { LocalClient } = load('localApi')
  const originalFetch = global.fetch, calls = []
  let revision = 0
  const id = '12345678-1234-1234-1234-123456789abc'
  const p = { ...project(), source: { ...project().source, assetId: id, kind: 'local' } }
  global.fetch = async (url, options) => {
    calls.push([url, options])
    if (url.endsWith('/session')) return { ok: true, json: async () => ({ session: 'fixture-session', mediaReady: true, asrReady: true }) }
    const body = JSON.parse(options.body)
    if (options.method === 'PUT') assert.equal(body.revision, revision)
    revision++
    return { ok: true, json: async () => ({ id, revision, project: { ...(body.project || body), localId: id, localRevision: revision } }) }
  }
  try {
    const client = new LocalClient()
    await client.connect()
    await Promise.all([client.save(p), client.save({ ...p, title: 'New name' }), client.save(p)])
    assert.equal(revision, 3)
    assert.equal(calls.filter(([, options]) => options.method === 'POST').length, 1)
    assert.equal(calls[1][1].headers['x-workbench-session'], 'fixture-session')
    await assert.rejects(client.request('https://outside.invalid'), /invalid_endpoint/)
  } finally { global.fetch = originalFetch }
})

test('relinking an old local draft keeps its edits and bookmarks and creates a fresh machine binding', async () => {
  const { LocalClient } = load('localApi')
  const originalFetch = global.fetch, calls = []
  const oldId = '12345678-1234-1234-1234-123456789abc', newId = '22345678-1234-1234-1234-123456789abc'
  const file = new File(['synthetic'], 'fixture.mp4', { type: 'video/mp4' })
  const previous = { ...project(), source: { ...project().source, kind: 'local', bytes: file.size, assetId: oldId }, localId: oldId, localRevision: 8,
    bookmarks: [{ id: 'note', time: 150, label: 'Preserve this note' }] }
  global.fetch = async (url, options) => {
    calls.push([url, options])
    if (url.endsWith('/assets')) return { ok: true, json: async () => ({ name: file.name, kind: 'local', bytes: file.size, duration: 300, width: 144, height: 256, assetId: newId, hasAudio: true, codec: 'h264' }) }
    const body = JSON.parse(options.body)
    assert.equal(body.localId, undefined)
    return { ok: true, json: async () => ({ id: newId, revision: 1, project: { ...body, localId: newId, localRevision: 1 } }) }
  }
  try {
    const loaded = await new LocalClient().import(file, previous)
    assert.deepEqual(loaded.clips, previous.clips)
    assert.deepEqual(loaded.cues, previous.cues)
    assert.deepEqual(loaded.bookmarks, previous.bookmarks)
    assert.equal(loaded.source.assetId, newId)
    assert.equal(loaded.localRevision, 1)
    assert.equal(calls[1][1].method, 'POST')
    assert.equal(previous.source.assetId, oldId)
  } finally { global.fetch = originalFetch }
})

test('new video imports start with an empty edit sequence instead of silently including the full recording', async () => {
  const { LocalClient } = load('localApi'), originalFetch = global.fetch
  const id = '32345678-1234-1234-1234-123456789abc', file = new File(['synthetic'], 'fixture.mp4', { type: 'video/mp4' })
  global.fetch = async (url, options) => {
    if (url.endsWith('/assets')) return { ok: true, json: async () => ({ name: file.name, bytes: file.size, duration: 300, width: 144, height: 256, assetId: id }) }
    const body = JSON.parse(options.body)
    return { ok: true, json: async () => ({ id, revision: 1, project: { ...body, localId: id, localRevision: 1 } }) }
  }
  try { const imported = await new LocalClient().import(file); assert.equal(imported.source.duration, 300); assert.deepEqual(imported.clips, []) }
  finally { global.fetch = originalFetch }
})

test('editing AI clips makes them explicit manual selections before another analysis', () => {
  const p = { ...project(), clips: project().clips.map(clip => ({ ...clip, origin: 'ai' })) }
  assert.equal(m.trimClip(p, 'a', 101, 109).clips[0].origin, 'manual')
  assert.ok(m.splitClip(p, 'a', 105, 'new').clips.slice(0, 2).every(clip => clip.origin === 'manual'))
  assert.equal(m.moveClip(p, 'a', 1).clips.find(clip => clip.id === 'a').origin, 'manual')
  const cleaned = m.removeSourceRanges(p, [{ start: 103, end: 106 }])
  assert.equal(cleaned.clips[0].origin, 'manual'); assert.equal(cleaned.clips.at(-1).origin, 'ai')
  assert.equal(p.clips[0].origin, 'ai')
})
