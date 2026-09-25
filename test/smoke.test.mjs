/**
 * Real-adapter smoke tests. Skipped by default: they need an actual debugger
 * (debugpy) on PATH. Run explicitly with `node --test test/smoke.test.mjs`
 * after `pip install debugpy` to catch built-in recipe drift that the
 * in-memory fake adapter cannot (field renames, handshake changes, etc.).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { accessSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'

/** Real Python fixture used by the tests (shared with integration/smoke). */
function fixturePath() {
  return join(process.cwd(), 'test', 'fixtures', 'hello.py')
}

/** Whether a command resolves on PATH (bare-name probe only). */
function commandExists(command) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const directories = (process.env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0)
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, command + extension))
        return true
      } catch {
        // try the next candidate
      }
    }
  }
  return false
}

/** Probe one python candidate for a debugpy module, resolving to its output. */
function probePython(command) {
  return new Promise(resolve => {
    let settled = false
    const done = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const child = spawn(command, ['-c', 'import debugpy; print(debugpy.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => done(null), 5000)
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString() })
    child.on('exit', () => done(out.trim()))
    child.on('error', () => done(null))
  })
}

/** Resolve the python interpreter that has debugpy installed. */
async function findPythonWithDebugpy() {
  for (const candidate of ['python', 'python3']) {
    if (!commandExists(candidate)) continue
    const version = await probePython(candidate)
    if (version !== null && version.length > 0) return candidate
  }
  return undefined
}

const python = await findPythonWithDebugpy()

test('real debugpy launch, breakpoint, continue round-trip', { skip: python === undefined ? 'debugpy not installed (pip install debugpy)' : false }, async () => {
  const manager = new DebugSessionManager({
    spawn: spec => spawnAdapter(spec, { requestTimeoutMs: 15000 }),
    // Resolve through the real recipe (launchArgs.program etc.): a hand-written
    // spec could omit fields and leave debugpy hanging without a program
    // (pre-existing flaw fixed 2026-08-24).
    resolveAdapter: () => resolveAdapter({ adapter: 'debugpy', program: fixturePath() }),
    limits: {
      requestTimeoutMs: 15000,
      stepTimeoutMs: 15000,
      maxOutputChars: 40000,
      maxStackFrames: 20,
      maxVariables: 100,
      maxResultChars: 16000,
    },
    sessionIdleTimeoutMs: 0,
  })
  const owner = {}
  const fixture = fixturePath()
  try {
    const snapshot = await manager.launch(owner, { program: fixture })
    assert.equal(snapshot.status, 'stopped')
    const session = manager.sessionFor(owner)
    // Line 6 (total = count + 41): stopping there has count=1 defined, so
    // Locals is non-empty. Line 5 (count = 1) stops before the assignment
    // with empty Locals (pre-existing assertion flaw fixed 2026-08-24).
    await session.setBreakpoints(fixture, [{ line: 6 }])
    const outcome = await session.resume('continue')
    assert.equal(outcome.state, 'stopped')
    assert.equal(outcome.snapshot.stopReason, 'breakpoint')
    const frames = await session.stackTrace(5)
    assert.ok(frames.length > 0)
    const scopes = await session.scopes(frames[0].id)
    assert.ok(scopes.length > 0)
    const { variables } = await session.variables(scopes[0].variablesReference)
    assert.ok(variables.length > 0)
  } finally {
    // Clean up regardless of assertion outcome: a failed run must still kill
    // the adapter processes, or node --test waits forever on leftover
    // children (pre-existing flaw fixed 2026-08-24).
    try {
      await manager.disconnect(owner, undefined, true)
    } catch {
      // already disconnected or never started
    }
    await manager.disposeAll()
  }
})
