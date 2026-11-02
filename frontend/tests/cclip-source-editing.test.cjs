const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript')
function load(name) {
  const file = path.resolve(__dirname, '../src/' + name + '.ts'), m = new Module(file, module)
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
  return m.exports
}
const { mergeExternalProject } = load('features/workbench/mergeExternalProject')
const { trimScene, removeSceneRange } = load('features/studio/sceneEditing')

test('late recognition preserves unsaved manual work and each undo baseline', () => {
  const base = { localId: 'same', localRevision: 1, title: 'Before', source: { assetId: 'asset' }, clips: [], cues: [], bookmarks: [] }
  const manual = { id: 'manual', start: 8, end: 9, origin: 'manual' }
  const local = { ...base, title: 'My title', clips: [manual], bookmarks: [{ id: 'mark', time: 8 }] }
  const ai = { id: 'ai', start: 0, end: 4, origin: 'ai' }
  const remote = { ...base, localRevision: 2, clips: [ai], cues: [{ id: 'cue', text: 'Speech' }] }
  const result = mergeExternalProject(base, local, remote)
  assert.deepEqual(result.clips, [ai, manual]); assert.equal(result.title, 'My title'); assert.equal(result.localRevision, 2)
  assert.deepEqual(result.bookmarks, local.bookmarks)
  assert.deepEqual(mergeExternalProject(base, base, remote).clips, [ai])
  const edited = { ...remote, clips: [], cues: [{ id: 'cue', text: 'My correction' }] }
  assert.deepEqual(mergeExternalProject(remote, edited, { ...remote, localRevision: 3 }).clips, [])
  assert.equal(mergeExternalProject(remote, edited, remote).cues[0].text, 'My correction')
})

test('trimming and deleting source ranges preserve shot-relative crop timing', () => {
  const scene = { id: 'one', start: 10, end: 20, label: 'Synthetic', crop_track: [{ start: 0, crop_x: .2 }, { start: 3, crop_x: .8 }, { start: 7, crop_x: .4 }] }
  const trimmed = trimScene(scene, 14, 19)
  assert.deepEqual(trimmed.crop_track, [{ start: 0, crop_x: .8 }, { start: 3, crop_x: .4 }])
  const cut = removeSceneRange([scene], { start: 13, end: 17 }, () => 'right')
  assert.deepEqual(cut.map(s => [s.id, s.start, s.end]), [['one', 10, 13], ['right', 17, 20]])
  assert.deepEqual(cut[1].crop_track, [{ start: 0, crop_x: .4 }])
  assert.equal(scene.end, 20); assert.equal(scene.crop_track.length, 3)
  assert.deepEqual(removeSceneRange([scene], { start: 0, end: 30 }), [])
})
