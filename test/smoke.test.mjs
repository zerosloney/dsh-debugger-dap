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

/** 测试用的真实 Python fixture（与 integration/smoke 共用）。 */
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
    // 用真实配方解析（含 launchArgs.program 等），避免手写 spec 遗漏字段
    // 导致 debugpy 收不到 program 而挂起（既有缺陷，2026-08-24 修复）。
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
    // 第 6 行（total = count + 41）：停在此行时 count=1 已定义，Locals 非空。
    // 第 5 行（count = 1）在赋值前停止，Locals 为空——既有断言缺陷，2026-08-24 修复。
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
    // 无论断言成败都清理：失败时也必须杀掉适配器进程，否则 node --test
    // 会因残留子进程一直等待（既有缺陷，2026-08-24 修复）。
    try {
      await manager.disconnect(owner, undefined, true)
    } catch {
      // 已断开或从未启动
    }
    await manager.disposeAll()
  }
})
