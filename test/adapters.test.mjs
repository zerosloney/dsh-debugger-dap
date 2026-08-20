import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAdapter, AdapterUnavailableError } from '../lib/adapters.js'

const pythonPresent = command => command === 'python'
const nothing = () => false

test('program extension guesses the adapter', () => {
  const spec = resolveAdapter({ program: '/w/app.py' }, undefined, pythonPresent)
  assert.equal(spec.command, 'python')
  assert.deepEqual(spec.args, ['-m', 'debugpy.adapter'])
})

test('explicit adapter id wins over the extension guess', () => {
  const spec = resolveAdapter({ adapter: 'dlv', program: '/w/app.py' }, undefined, () => true)
  assert.equal(spec.command, 'dlv')
  assert.deepEqual(spec.args, ['dap'])
})

test('unknown extension without an adapter id lists what is available', () => {
  assert.throws(
    () => resolveAdapter({ program: '/w/app.bin' }, undefined, pythonPresent),
    /Pass 'adapter' explicitly \(available: debugpy\)/,
  )
})

test('missing adapter on PATH surfaces the install hint', () => {
  assert.throws(
    () => resolveAdapter({ program: '/w/app.py' }, undefined, nothing),
    /pip install debugpy/,
  )
  assert.throws(() => resolveAdapter({ adapter: 'dlv', program: '/w/x' }, undefined, nothing), /go install/)
})

test('unknown adapter id points at the config', () => {
  assert.throws(() => resolveAdapter({ adapter: 'gdb', program: '/w/x' }, undefined, pythonPresent), /Unknown adapter 'gdb'/)
})

test('config rows add adapters and override built-ins', () => {
  const config = {
    'js-debug': { command: 'node', args: ['/opt/js-debug/src/dapDebugServer.js'] },
    debugpy: { command: '/venv/bin/python', args: ['-m', 'debugpy.adapter'] },
  }
  const custom = resolveAdapter({ adapter: 'js-debug', program: '/w/x' }, config, () => false)
  assert.equal(custom.command, 'node')
  assert.deepEqual(custom.args, ['/opt/js-debug/src/dapDebugServer.js'])

  const overridden = resolveAdapter({ adapter: 'debugpy', program: '/w/a.py' }, config, () => false)
  assert.equal(overridden.command, '/venv/bin/python')
})

test('config launchArgs are carried into the resolved spec', () => {
  const config = {
    'js-debug': { command: 'node', args: ['x.js'], launchArgs: { justMyCode: true, request: 'attach' } },
  }
  const spec = resolveAdapter({ adapter: 'js-debug', program: '/w/x' }, config, () => false)
  assert.deepEqual(spec.launchArgs, { justMyCode: true, request: 'attach' })
})

test('built-in netcoredbg recipe carries coreclr launch args and stopAtEntry', () => {
  const spec = resolveAdapter({ adapter: 'netcoredbg', program: '/w/app.dll' }, undefined, () => true)
  assert.equal(spec.command, 'netcoredbg')
  assert.deepEqual(spec.args, ['--interpreter=vscode'])
  assert.deepEqual(spec.launchArgs, { type: 'coreclr' })
  assert.equal(spec.stopOnEntryKey, 'stopAtEntry')
})

test('.dll and .exe extensions guess netcoredbg', () => {
  assert.equal(resolveAdapter({ program: '/w/App.dll' }, undefined, () => true).command, 'netcoredbg')
  assert.equal(resolveAdapter({ program: '/w/App.exe' }, undefined, () => true).command, 'netcoredbg')
})

test('missing netcoredbg surfaces the install hint', () => {
  assert.throws(
    () => resolveAdapter({ adapter: 'netcoredbg', program: '/w/x' }, undefined, nothing),
    /Samsung\/netcoredbg/,
  )
})

test('an explicit netcoredbg config override inherits the recipe stopAtEntry key', () => {
  const config = { netcoredbg: { command: 'D:/tools/netcoredbg' } }
  const spec = resolveAdapter({ adapter: 'netcoredbg', program: '/w/app.dll' }, config, () => false)
  assert.equal(spec.command, 'D:/tools/netcoredbg')
  assert.equal(spec.stopOnEntryKey, 'stopAtEntry')
  assert.deepEqual(spec.launchArgs, { type: 'coreclr' })
  assert.deepEqual(spec.args, [])
})
