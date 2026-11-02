const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/workbench', name), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require })
  return module.exports
}
const Progress = load('LocalTaskProgress.tsx').default
const { translate, languages } = load('strings.ts')
const render = (activity, language = 'zh') => renderToStaticMarkup(React.createElement(Progress, {
  activity: { kind: 'transcribe', phase: 'running', progress: 65, cancellable: true, ...activity },
  ui: (key, values) => translate(language, key, values), onCancel() {},
}))

test('every UI language identifies the operation, accessible progress and cancellation', () => {
  for (const [language] of languages) {
    const html = render({}, language)
    assert.ok(html.includes('role="status"'))
    assert.ok(html.includes('value="65"'))
    assert.ok(html.includes(translate(language, 'cancelTask')))
    assert.ok(!html.includes('undefined'))
  }
})

test('preparation and native saving have indeterminate progress rather than a false zero percent', () => {
  for (const [phase, label] of [['preparing', 'preparingTask'], ['saving', 'savingFile']]) {
    const html = render({ phase, progress: 0, cancellable: false })
    assert.ok(html.includes(translate('zh', label)))
    assert.ok(!html.includes('value="0"'))
    assert.ok(!html.includes('<button'))
  }
})

test('cancellation remains visible and cannot be clicked repeatedly; invalid progress stays bounded', () => {
  const html = render({ phase: 'cancelling' })
  assert.match(html, /<button[^>]*disabled=""/)
  assert.ok(html.includes(translate('zh', 'cancellingTask')))
  assert.ok(render({ progress: 150 }).includes('value="100"'))
  assert.ok(render({ progress: -5 }).includes('value="0"'))
  assert.ok(!render({ progress: NaN }).includes('value="NaN"'))
})
