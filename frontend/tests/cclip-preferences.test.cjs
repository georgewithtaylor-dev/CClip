const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load({ native = true, full = true, invoke = async () => ({}), saved = {} } = {}) {
  const values = new Map(Object.entries(saved)), events = []
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/cclip/preferences.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports, console: { warn() {} }, Event,
    document: { querySelector: () => full ? { getAttribute: () => 'full' } : null },
    window: { ...(native ? { __TAURI_INTERNALS__: {} } : {}), dispatchEvent: e => events.push(e.type) },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    require: name => name.includes('language') ? { supportedLanguages: ['zh','en','ja','ko','es','pt','ru','fr'] } : { invoke },
  })
  return { api: module.exports, values, events }
}

test('a new origin restores only validated UI preferences before application initialization', async () => {
  const x = load({ invoke: async command => { assert.equal(command, 'get_cclip_preferences'); return { theme: 'light', language: 'en', unexpected: 'ignored' } } })
  await x.api.restoreCClipPreferences()
  assert.deepEqual(Object.fromEntries(x.values), { 'autoclip-theme': 'light', 'autoclip.language': 'en' })
  const invalid = load({ invoke: async () => ({ theme: 'unknown', language: 'unknown' }) })
  await invalid.api.restoreCClipPreferences()
  assert.equal(invalid.values.size, 0)
})

test('queued writes preserve selection order and close flush waits for native persistence', async () => {
  const calls = []; let finish
  const blocked = new Promise(resolve => { finish = resolve })
  const x = load({ invoke: async (command, args) => { calls.push([command, JSON.parse(JSON.stringify(args))]); if (calls.length === 1) await blocked } })
  void x.api.saveCClipPreferences({ theme: 'light' })
  void x.api.saveCClipPreferences({ language: 'fr' })
  let flushed = false
  const flushing = x.api.flushCClipPreferences().then(() => { flushed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1); assert.equal(flushed, false)
  finish(); await flushing
  assert.deepEqual(calls.map(call => call[1].preferences), [{ theme: 'light' }, { language: 'fr' }])
})

test('unavailable persistence reports an error and permits a subsequent retry', async () => {
  let failed = true
  const x = load({ saved: { 'autoclip.language': 'ja' }, invoke: async () => { if (failed) throw Error('denied'); return {} } })
  await x.api.restoreCClipPreferences()
  assert.equal(x.values.get('autoclip.language'), 'ja')
  await x.api.saveCClipPreferences({ language: 'ja' })
  assert.deepEqual(x.events, ['cclip-preferences-error'])
  failed = false; await x.api.saveCClipPreferences({ theme: 'dark' })
  assert.equal(x.events.length, 1)
})

test('browser and original AutoClip do not invoke CClip native commands', async () => {
  for (const flags of [{ native: false }, { full: false }]) {
    const x = load({ ...flags, invoke: () => { throw Error('must not call') } })
    await x.api.restoreCClipPreferences(); await x.api.saveCClipPreferences({ language: 'zh' }); await x.api.flushCClipPreferences()
    assert.equal(x.events.length, 0)
  }
})
