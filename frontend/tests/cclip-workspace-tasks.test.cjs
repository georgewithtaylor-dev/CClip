const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/cclip/WorkspaceTasks.tsx'), 'utf8')
const moduleValue = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  module: moduleValue, exports: moduleValue.exports,
  require: name => name === './messages' ? { ct: key => key } : require(name),
})
const { workspaceTasks } = moduleValue.exports
test('shared progress includes other clips and cover work after rendering', () => {
  const tasks = workspaceTasks({ jobs: [{ job_id: 'other-clip', title: 'Other', percent: 43, status: 'running' }, { job_id: 'done', status: 'completed' }],
    analysis: { status: 'running', percent: 12 }, cclip_cover_jobs: { cover: { job_id: 'cover', status: 'running' } }, source_preview: { status: 'queued' } })
  assert.equal(tasks.length, 4)
  assert.equal(tasks.find(task => task.id === 'other-clip').progress, 43)
  assert.equal(tasks.find(task => task.id === 'cover').progress, undefined)
  assert.equal(tasks.find(task => task.id === 'source-preview').progress, undefined)
  assert.ok(!tasks.some(task => task.id === 'done'))
})
test('every new task and cover action label has eight translations', () => {
  const text = fs.readFileSync(path.join(__dirname, '../src/cclip/messages.ts'), 'utf8')
  for (const key of ['prepareOutput', 'archivedOutputs', 'renderTask', 'analyzeTask', 'coverTask', 'prepareOutputTask', 'previewTask', 'framingTask', 'cancelTask', 'coverPreviewHint', 'cloudCover', 'cloudCoverConsent']) {
    const row = text.split('\n').find(line => line.includes(`['${key}',`))
    const values = vm.runInNewContext(row.trim().replace(/,$/, ''))
    assert.equal(values.length, 9, key); assert.ok(values.every(value => value.length))
  }
})
