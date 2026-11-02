const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript')
const file = path.resolve(__dirname, '../src/features/studio/sceneEditing.ts'), mod = new Module(file, module)
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
const { editSceneRanges, addSceneRange } = mod.exports
const scene = { id: 'first', label: 'First', start: 10, end: 25, evidence: '', crop_x: .4, crop_track: [{ start: 0, crop_x: .2 }, { start: 5, crop_x: .8 }, { start: 12, crop_x: .5 }] }
test('cutting overlapping caption selections removes source once and retains framing for both pieces', () => {
  const original = JSON.stringify(scene)
  const next = editSceneRanges([scene], [{ start: 12, end: 16 }, { start: 14, end: 18 }], false, () => 'right')
  assert.deepEqual(next.map(s => [s.id, s.start, s.end]), [['first', 10, 12], ['right', 18, 25]])
  assert.deepEqual(next[1].crop_track, [{ start: 0, crop_x: .8 }, { start: 4, crop_x: .5 }])
  assert.equal(JSON.stringify(scene), original)
})
test('keeping disjoint caption selections preserves reordered scenes and their boundaries', () => {
  const early = { ...scene, id: 'early', start: 0, end: 8, crop_track: null }
  const next = editSceneRanges([scene, early], [{ start: 1, end: 5 }, { start: 12, end: 16 }, { start: 16, end: 19 }], true)
  assert.deepEqual(next.map(s => [s.id, s.start, s.end]), [['first', 12, 19], ['early', 1, 5]])
  assert.deepEqual(next[0].crop_track, [{ start: 0, crop_x: .2 }, { start: 3, crop_x: .8 }])
})
test('caption selections outside kept scenes cannot bring a deleted gap back', () => {
  const pieces = [{ ...scene, start: 10, end: 12 }, { ...scene, id: 'last', start: 20, end: 25 }]
  assert.deepEqual(editSceneRanges(pieces, [{ start: 11, end: 22 }], true).map(s => [s.start, s.end]), [[11, 12], [20, 22]])
  assert.deepEqual(editSceneRanges(pieces, [{ start: 0, end: 30 }], false), [])
  assert.equal(editSceneRanges(pieces, [{ start: NaN, end: 30 }], true), pieces)
})

test('adding content already kept does not duplicate playback or reset speaker framing', () => {
  const scenes = [scene]
  assert.equal(addSceneRange(scenes, { start: 12, end: 18 }, scene), scenes)
  assert.deepEqual(scenes[0].crop_track, scene.crop_track)
})

test('adding a bridge merges the connected overlap without reordering unrelated shots', () => {
  const untouched = { ...scene, id: 'separate', start: 40, end: 45 }
  const late = { ...scene, id: 'late', start: 20, end: 25 }
  const early = { ...scene, id: 'early', start: 5, end: 10 }
  const middle = { ...scene, id: 'middle', start: 10, end: 15 }
  const scenes = [late, untouched, early, middle], before = JSON.stringify(scenes)
  const result = addSceneRange(scenes, { start: 14, end: 21 }, early)
  assert.deepEqual(result.map(s => [s.id, s.start, s.end]), [['late', 5, 25], ['separate', 40, 45]])
  assert.equal(result[0].crop_track, null)
  assert.equal(result[1], untouched)
  assert.equal(JSON.stringify(scenes), before)
})

test('adding a disjoint source range appends it once and leaves existing scenes unchanged', () => {
  const result = addSceneRange([scene], { start: 30, end: 35 }, scene, () => 'added')
  assert.equal(result[0], scene)
  assert.deepEqual([result[1].id, result[1].start, result[1].end, result[1].crop_track], ['added', 30, 35, null])
})

test('invalid added ranges cannot corrupt the kept timeline', () => {
  const scenes = [scene]
  for (const range of [{ start: NaN, end: 20 }, { start: 10, end: Infinity }, { start: 5, end: 5.01 }]) {
    assert.equal(addSceneRange(scenes, range, scene), scenes)
  }
})
