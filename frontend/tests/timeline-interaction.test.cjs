const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript')
const cache = new Map()
function load(name) {
  const file = path.resolve(__dirname, '../src/features/workbench/' + name + '.ts')
  if (cache.has(file)) return cache.get(file).exports
  const m = new Module(file, module); cache.set(file, m)
  m.require = id => id.startsWith('./') ? load(id.slice(2)) : require(id)
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
  return m.exports
}
const { snapTime, snapMove, rangeLanes } = load('timelineInteraction')
test('magnet uses a pixel threshold, supports free motion, and never jumps across a long source', () => {
  assert.equal(snapTime(10.06, [10, 20], 100).time, 10)
  assert.equal(snapTime(10.09, [10, 20], 100).target, null)
  assert.equal(snapTime(10.06, [10, 20], 100, false).time, 10.06)
  assert.equal(snapTime(13, [10, 20], .1).target, null)
  assert.equal(snapTime(8, [], 100).time, 8)
})
test('body motion snaps either edge while keeping duration within the source', () => {
  const move = snapMove({ start: 3, end: 6 }, .96, [7], 100, { start: 0, end: 20 })
  assert.deepEqual(move, { start: 4, end: 7, target: 7 })
  const clamped = snapMove({ start: 3, end: 6 }, 99, [], 100, { start: 0, end: 20 })
  assert.equal(clamped.end, 20); assert.equal(clamped.end - clamped.start, 3)
})
test('overlapping and identical added ranges are separate visible lanes', () => {
  const { lanes, count } = rangeLanes([{ id: 'a', start: 0, end: 5 }, { id: 'b', start: 2, end: 6 }, { id: 'c', start: 2, end: 6 }, { id: 'd', start: 6, end: 8 }])
  assert.equal(count, 3); assert.equal(new Set(['a', 'b', 'c'].map(id => lanes.get(id))).size, 3)
  assert.equal(lanes.get('d'), 0)
})
