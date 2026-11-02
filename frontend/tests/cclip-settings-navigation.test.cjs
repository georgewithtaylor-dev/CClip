const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(full = true) {
  const window = new EventTarget(), module = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/cclip/runtime.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, window, document: { querySelector: () => full ? { getAttribute: () => 'full' } : null },
    URLSearchParams, Event, CustomEvent, require: id => id === 'react-dom' ? { flushSync: f => f() } : { flushCClipPreferences: async () => {} },
  })
  return { window, navigate: module.exports.navigateCClip }
}

test('CClip settings open over dirty edits without navigating or asking to leave', () => {
  const app = load(), routes = [], sections = []
  app.window.addEventListener('cclip-before-navigate', () => assert.fail('Opening settings must not ask to discard project edits'))
  app.window.addEventListener('cclip-open-settings', e => sections.push(e.detail))
  assert.equal(app.navigate(p => routes.push(p), '/settings?section=cover'), true)
  assert.equal(app.navigate(p => routes.push(p), '/settings'), true)
  assert.deepEqual(sections, ['cover', 'ai'])
  assert.deepEqual(routes, [])
})

test('leaving the workspace still respects the existing dirty-project guard', () => {
  const app = load(), routes = []
  app.window.addEventListener('cclip-before-navigate', e => e.preventDefault())
  assert.equal(app.navigate(p => routes.push(p), '/'), false)
  assert.deepEqual(routes, [])
})

test('original AutoClip settings navigation retains its route behavior', () => {
  const app = load(false), routes = []
  app.window.addEventListener('cclip-open-settings', () => assert.fail('Original app must keep its settings page'))
  assert.equal(app.navigate(p => routes.push(p), '/settings?section=cover'), true)
  assert.deepEqual(routes, ['/settings?section=cover'])
})
