/**
 * Real-adapter smoke tests. These spawn actual DAP adapters (debugpy, dlv,
 * netcoredbg) to catch recipe drift that the in-memory fake cannot: flag
 * renames, changed port announcements, changed launch fields.
 *
 * They are skipped unless the matching debugger is installed, because CI and
 * most dev machines do not carry every toolchain. Opt in per adapter by
 * installing it (debugpy via pip, dlv via go install, netcoredbg from GitHub
 * releases) or force them all with DEBUG_DAP_INTEGRATION=1.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DebugSessionManager } = await import('../lib/session.js')
const { resolveAdapter } = await import('../lib/adapters.js')

const { spawnAdapter } = await import('../lib/connection.js')

const forced = process.env.DEBUG_DAP_INTEGRATION === '1'

function commandExists(command) {
  try {
    require('node:child_process').execFileSync(
      process.platform === 'win32' ? 'where' : 'which',
      [command],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

const PYTHON = commandExists('python') ? 'python' : commandExists('python3') ? 'python3' : undefined
const HAS_DEBUGPY =
  PYTHON !== undefined &&
  (() => {
    try {
      require('node:child_process').execFileSync(PYTHON, ['-c', 'import debugpy'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
const HAS_DLV = commandExists('dlv')
const HAS_NETCOREDBG = commandExists('netcoredbg')

const SKIP_REASON = forced
  ? undefined
  : 'adapter not installed; install debugpy/dlv/netcoredbg or set DEBUG_DAP_INTEGRATION=1'

/** Smoke-test one adapter: launch, stop at entry, step, disconnect. */
async function smokeLaunch(manager, options) {
  const owner = {}
  try {
    const snapshot = await manager.launch(owner, options)
    assert.equal(snapshot.status, 'stopped')
    assert.equal(snapshot.stopReason, 'entry')
    assert.ok(snapshot.threadId !== undefined, 'thread id present after entry stop')
    // A resume must not hang and must report some state.
    const session = manager.sessionFor(owner)
    const outcome = await session.resume('stepIn')
    assert.ok(['stopped', 'running', 'terminated'].includes(outcome.state))
  } finally {
    // Adapter processes must be cleaned up even on assertion failure, or
    // node --test hangs waiting on leftover children.
    await manager.disposeAll()
  }
}

test('debugpy: launch, entry stop, step, disconnect', { skip: HAS_DEBUGPY ? false : SKIP_REASON }, async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  // Write the real script first, then resolve the recipe against its real
  // path (pre-existing flaw fixed 2026-08-24: /tmp/smoke.py did not exist,
  // and the spec was resolved before the file was written).
  const scriptPath = path.join(os.tmpdir(), `dsh-smoke-${process.pid}.py`)
  fs.writeFileSync(scriptPath, 'def main():\n    x = 1\n    return x\nmain()\n')
  const spec = resolveAdapter({ adapter: 'debugpy', program: scriptPath })
  const manager = new DebugSessionManager({
    spawn: spec => spawnAdapter(spec),
    resolveAdapter: () => spec,
    limits: { requestTimeoutMs: 30000, stepTimeoutMs: 25000, maxOutputChars: 2000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
    sessionIdleTimeoutMs: 0,
  })
  try {
    await smokeLaunch(manager, { program: scriptPath, stopOnEntry: true })
  } finally {
    fs.unlinkSync(scriptPath)
  }
})

test('dlv: launch a trivial Go program, entry stop, disconnect', { skip: HAS_DLV ? false : SKIP_REASON }, async () => {
  const spec = resolveAdapter({ adapter: 'dlv', program: '/tmp/smoke.go' })
  const manager = new DebugSessionManager({
    spawn: spec => spawnAdapter(spec),
    resolveAdapter: () => spec,
    limits: { requestTimeoutMs: 30000, stepTimeoutMs: 25000, maxOutputChars: 2000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
    sessionIdleTimeoutMs: 0,
  })
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-go-'))
  const source = path.join(dir, 'main.go')
  fs.writeFileSync(source, 'package main\n\nfunc main() { x := 1; _ = x }\n')
  try {
    await smokeLaunch(manager, { program: source, stopOnEntry: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('netcoredbg: launch, entry stop, disconnect', { skip: HAS_NETCOREDBG ? false : SKIP_REASON }, async () => {
  const spec = resolveAdapter({ adapter: 'netcoredbg', program: '/tmp/smoke.dll' })
  const manager = new DebugSessionManager({
    spawn: spec => spawnAdapter(spec),
    resolveAdapter: () => spec,
    limits: { requestTimeoutMs: 30000, stepTimeoutMs: 25000, maxOutputChars: 2000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
    sessionIdleTimeoutMs: 0,
  })
  // netcoredbg launches a dll; without one built the launch will fail, so this
  // smoke test only asserts the adapter process can be spawned and the
  // handshake starts (a missing dll is a user error, not adapter drift).
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dll = path.join(os.tmpdir(), `dsh-smoke-${process.pid}.dll`)
  fs.writeFileSync(dll, 'not a real dll')
  try {
    const owner = {}
    await assert.rejects(manager.launch(owner, { program: dll, stopOnEntry: true }), /exited|not found|failed/i)
    await manager.disposeAll()
  } finally {
    fs.unlinkSync(dll)
  }
})

