const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

test('CClip built entry removes the blocked network font import while preserving local CSS', () => {
  const file = path.join(__dirname, '../vite.cclip.config.ts')
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', '__moduleUrl')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, URL, process: { env: {} }, __moduleUrl: pathToFileURL(file).href,
    require: id => id === 'vite' ? { defineConfig: value => value } : id === '@vitejs/plugin-react' ? () => ({ name: 'react' }) : require(id),
  })
  const plugin = module.exports.default.plugins.find(plugin => plugin.name === 'cclip-local-fonts')
  assert.ok(plugin, 'the full build must remove the CSP-blocked remote font stylesheet')
  const original = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8')
  assert.ok(original.includes('fonts.googleapis.com'), 'legacy stylesheet remains unchanged')
  const transformed = plugin.transform(original, 'C:\\workspace\\frontend\\src\\index.css?direct')
  assert.ok(!transformed.includes('fonts.googleapis.com'))
  assert.ok(transformed.includes('@import "tailwindcss"'))
  assert.ok(transformed.includes('system-ui,-apple-system,sans-serif'))
  assert.equal(plugin.transform(original, '/another/stylesheet.css'), undefined)
})
