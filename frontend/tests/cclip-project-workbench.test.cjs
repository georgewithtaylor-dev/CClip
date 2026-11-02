const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file) {
  const full = path.join(__dirname, '../src', file)
  const code = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const module = { exports: {} }
  const localRequire = name => name.startsWith('.') ? load(path.relative(path.join(__dirname, '../src'), path.resolve(path.dirname(full), name + '.ts'))) : require(name)
  vm.runInNewContext(code, { module, exports: module.exports, require: localRequire })
  return module.exports
}
const { timelineOutputs, outputGroups } = load('cclip/outputs.ts')
const draft = (id, scenes, revision = 1) => ({ id, title: id, scenes: scenes.map(([start, end], i) => ({ id: `scene-${i}`, start, end })), revision })

test('platform copies of the same content occupy one set of timeline positions', () => {
  const workspace = { drafts: [draft('douyin', [[10, 20], [50, 60]]), draft('xiaohongshu', [[10, 20], [50, 60]])], jobs: [] }
  const markers = timelineOutputs(workspace)
  assert.equal(markers.length, 2)
  const groups = outputGroups(workspace)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].drafts.length, 2)
  assert.equal(workspace.drafts.length, 2)
  assert.equal(markers[0].color, markers[1].color)
  assert.equal(outputGroups({ drafts: [workspace.drafts[0], draft('reordered', [[50, 60], [10, 20]])] }).length, 2)
})

test('every output scene remains on source time, including separated and overlapping platform versions', () => {
  const workspace = { drafts: [draft('a', [[10, 20], [50, 60]]), draft('b', [[10, 20]]), draft('c', [[21, 30]])], jobs: [] }
  const markers = timelineOutputs(workspace)
  assert.equal(markers.length, 4)
  const first = markers.find(item => item.draftId === 'a' && item.start === 10)
  const separated = markers.find(item => item.draftId === 'a' && item.start === 50)
  const overlap = markers.find(item => item.draftId === 'b')
  const later = markers.find(item => item.draftId === 'c')
  assert.equal(separated.end, 60)
  assert.notEqual(first.lane, overlap.lane)
  assert.ok(later.start > first.end)
})

test('an old rendered version is not shown as the current ready output', () => {
  const workspace = { drafts: [draft('updated', [[10, 20]], 2), draft('failed', [[40, 50]])], jobs: [{ draft_id: 'updated', revision: 1, status: 'completed', created_at: '2026-10-28' }], output_variants: [{ draft_id: 'failed', status: 'failed' }] }
  const markers = timelineOutputs(workspace)
  assert.equal(markers[0].status, 'updated')
  assert.equal(markers[1].status, 'failed')
})

test('new CClip project lifecycle messages have all eight nonempty translations', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/cclip/messages.ts'), 'utf8')
  for (const key of ['unsaved', 'outputs', 'sourceEdit', 'saveProjectHint', 'discardChanges', 'deleteProjectConfirm', 'saveProject', 'projectFiles', 'projectFileHint', 'splitPreview', 'splitPanels', 'splitTimeline', 'platformVersions', 'storage', 'generatedFolder', 'downloadsFolder', 'storageHint', 'storageFailed', 'editorSettings', 'editorGestures', 'frameAndCover', 'oneClick', 'oneClickHint', 'fileSaved', 'fileSavedAt']) {
    const row = source.split('\n').find(line => (line.includes(`['${key}',`) || line.includes(`["${key}",`)))
    assert.ok(row, key)
    const values = vm.runInNewContext(row.trim().replace(/,$/, ''))
    assert.equal(values.length, 9, key)
    assert.ok(values.every(value => typeof value === 'string' && value.length))
  }
})

test('all current source clips are listed before production; old outputs remain separate', () => {
  const clips = [{ id: 'one', name: 'One', start: 10, end: 20, origin: 'ai' }, { id: 'two', name: 'Two', start: 30, end: 40, origin: 'manual' }]
  const workspace = { drafts: [draft('old', [[10, 20]])], jobs: [], cclip_source_clips: { old: 'retired-source' }, cclip_retired_source_ids: ['retired-source'] }
  const groups = outputGroups(workspace, { clips })
  assert.equal(groups.filter(group => !group.archived).length, 2)
  assert.deepEqual(Array.from(groups.filter(group => !group.archived), group => group.number), [1, 2])
  assert.equal(groups[0].drafts.length, 0)
  assert.equal(groups.at(-1).drafts[0].id, 'old')
  assert.equal(groups.at(-1).archived, true)
  assert.equal(timelineOutputs(workspace, { clips }).length, 0)
})

test('mapped trimmed versions keep the source number; stale legacy links can be repaired', () => {
  const clips = [{ id: 'one', start: 0, end: 10, origin: 'ai' }, { id: 'two', start: 20, end: 30, origin: 'manual' }]
  const groups = outputGroups({ drafts: [draft('edited', [[1, 2], [4, 5]]), draft('legacy', [[20, 30]])], cclip_source_clips: { edited: 'one', legacy: 'missing-old-link' } }, { clips })
  assert.equal(groups.length, 2)
  assert.equal(groups[0].drafts[0].id, 'edited')
  assert.equal(groups[1].drafts[0].id, 'legacy')
  assert.equal(groups[1].number, 2)
  assert.equal(groups[1].origin, 'manual')
})
