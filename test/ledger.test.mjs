/**
 * 调试会话台账（ledger）测试：单元（记录/查询/轮转/持久化）
 * + 集成（fake 适配器上的 session 事件 → 台账条目）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DebugLedger } from '../lib/ledger.js'
import { DebugSessionManager } from '../lib/session.js'
import { createFakeAdapter, standardScript } from '../helpers/fake-adapter.mjs'

function tmpLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-ledger-'))
  return { dir, path: join(dir, 'ledger.jsonl') }
}

// ---------- 单元：DebugLedger ----------

test('ledger: record 追加内存与 JSONL，条目带 seq/ts/sessionId/kind/detail', () => {
  const { dir, path } = tmpLedger()
  try {
    const ledger = DebugLedger.create({ path })
    ledger.record('dbg-1', 'session_start', { mode: 'launch', adapter: 'python -m debugpy.adapter' })
    ledger.record('dbg-1', 'breakpoint_hit', { reason: 'breakpoint', threadId: 1, file: '/w/app.py', line: 42 })
    ledger.record(undefined, 'request_error', { code: 'no_active_session' })

    const { entries } = ledger.query({})
    assert.equal(entries.length, 3)
    assert.equal(entries[0].seq, 1)
    assert.equal(entries[0].sessionId, 'dbg-1')
    assert.equal(entries[0].kind, 'session_start')
    assert.equal(entries[1].detail.line, 42)
    assert.equal(entries[2].sessionId, undefined)
    assert.ok(entries[0].ts.length > 0)

    // 持久化：每行一个合法 JSON
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) JSON.parse(line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: query 支持 sessionId/kind/since/limit 过滤', () => {
  const ledger = DebugLedger.create({ path: join(tmpdir(), `dsh-dap-q-${Date.now()}-${Math.random()}.jsonl`) })
  try {
    for (let i = 1; i <= 10; i += 1) {
      ledger.record(i % 2 === 0 ? 'dbg-a' : 'dbg-b', i % 3 === 0 ? 'exception' : 'stop', { n: i })
    }
    assert.equal(ledger.query({ sessionId: 'dbg-a' }).entries.length, 5)
    assert.equal(ledger.query({ kinds: ['exception'] }).entries.length, 3)
    assert.equal(ledger.query({ kinds: ['exception'], sessionId: 'dbg-a' }).entries.length, 1)
    assert.equal(ledger.query({ limit: 3 }).entries.length, 3)
    const tail = ledger.query({ limit: 3 }).entries
    assert.equal(tail.at(-1).detail.n, 10)
    // since 过滤（ts 为 ISO 字符串，字典序比较）
    const since = ledger.query({ limit: 100 }).entries[5].ts
    const after = ledger.query({ since }).entries
    assert.ok(after.length >= 4)
    // 超限截断标记
    const small = ledger.query({ limit: 4 })
    assert.equal(small.truncated, true)
    assert.equal(small.entries.length, 4)
  } finally {
    ledger.record // noop
  }
})

test('ledger: 文件超限轮转到 .1', () => {
  const { dir, path } = tmpLedger()
  try {
    writeFileSync(path, 'x'.repeat(100))
    const ledger = DebugLedger.create({ path, maxFileBytes: 50 })
    ledger.record('dbg-1', 'stop', {})
    assert.ok(readFileSync(`${path}.1`, 'utf8').length >= 100, '.1 应保留旧内容')
    assert.ok(readFileSync(path, 'utf8').includes('"stop"'), '新条目写入新文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 写入失败不影响后续记录（best-effort）', () => {
  const ledger = DebugLedger.create({ path: join('Z:\\definitely\\missing\\dir', 'ledger.jsonl') })
  ledger.record('dbg-1', 'session_start', {})
  assert.ok(ledger.writeFailureCount >= 0)
  // 内存查询仍可用
  assert.equal(ledger.query({}).entries.length, 1)
})

// ---------- 集成：fake 适配器 → 台账事件 ----------

function buildManagerWithLedger(script = standardScript(), ledgerPath) {
  const fake = createFakeAdapter(script)
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [] }),
    limits: {
      requestTimeoutMs: 5000,
      stepTimeoutMs: 5000,
      maxOutputChars: 40000,
      maxStackFrames: 20,
      maxVariables: 100,
      maxResultChars: 16000,
    },
    ledger: DebugLedger.create({ path: ledgerPath }),
  })
  return { manager, fake }
}

test('ledger 集成: launch→断点→命中→结束 全链路事件入账', async () => {
  const { dir, path } = tmpLedger()
  try {
    const script = standardScript({
      continue: (server, request) => {
        server.respond(request.seq, 'continue', { allThreadsContinued: false })
        server.emit('stopped', { reason: 'breakpoint', threadId: 1 })
      },
    })
    const { manager } = buildManagerWithLedger(script, path)
    const owner = {}
    await manager.launch(owner, { program: '/w/app.py' })
    const session = manager.sessionFor(owner)
    await session.setBreakpoints('/w/app.py', [{ line: 42 }])
    await session.resume('continue')

    // 等待断点命中的位置补全（recordStopLedger 是异步 best-effort）
    await new Promise(resolve => setTimeout(resolve, 100))

    const { entries } = manager.ledgerQuery({ sessionId: session.id })
    const kinds = entries.map(entry => entry.kind)
    assert.ok(kinds.includes('session_start'), `应含 session_start，实际: ${kinds.join(',')}`)
    assert.ok(kinds.includes('breakpoints_set'), `应含 breakpoints_set，实际: ${kinds.join(',')}`)
    assert.ok(kinds.includes('breakpoint_hit'), `应含 breakpoint_hit，实际: ${kinds.join(',')}`)
    const hit = entries.find(entry => entry.kind === 'breakpoint_hit')
    assert.equal(hit.detail.file, '/w/src/app.py')
    assert.equal(hit.detail.line, 42)
    assert.equal(hit.detail.function, 'doWork')

    await manager.disconnect(owner, session.id, true)
    const end = manager.ledgerQuery({ sessionId: session.id, kinds: ['session_end'] }).entries.at(-1)
    assert.equal(end.kind, 'session_end')
    assert.equal(end.detail.endReason, 'disconnect')
    assert.ok(end.detail.durationMs >= 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger 集成: 异常停机记录 exception 条目（带位置补全）', async () => {
  const { dir, path } = tmpLedger()
  try {
    const script = standardScript({
      continue: (server, request) => {
        server.respond(request.seq, 'continue', { allThreadsContinued: false })
        server.emit('stopped', { reason: 'exception', description: 'ZeroDivisionError: division by zero', threadId: 1 })
      },
    })
    const { manager } = buildManagerWithLedger(script, path)
    const owner = {}
    await manager.launch(owner, { program: '/w/app.py' })
    const session = manager.sessionFor(owner)
    const outcome = await session.resume('continue')
    assert.equal(outcome.snapshot.stopReason, 'exception')
    await new Promise(resolve => setTimeout(resolve, 100))

    const exception = manager.ledgerQuery({ sessionId: session.id, kinds: ['exception'] }).entries.at(-1)
    assert.equal(exception.kind, 'exception')
    assert.equal(exception.detail.description, 'ZeroDivisionError: division by zero')
    assert.equal(exception.detail.file, '/w/src/app.py')
    await manager.disconnect(owner, session.id, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger 集成: 适配器死亡（onClose）记 session_end/adapter_close；错误记 request_error', async () => {
  const { dir, path } = tmpLedger()
  try {
    const { manager, fake } = buildManagerWithLedger(standardScript(), path)
    const owner = {}
    await manager.launch(owner, { program: '/w/app.py' })
    const session = manager.sessionFor(owner)
    fake.server.die()
    await new Promise(resolve => setTimeout(resolve, 100))

    const end = manager.ledgerQuery({ sessionId: session.id, kinds: ['session_end'] }).entries.at(-1)
    assert.equal(end.detail.endReason, 'adapter_close')

    // request_error：无会话动作失败
    manager.recordError(new Error('boom'), session.id)
    const errorEntry = manager.ledgerQuery({ sessionId: session.id, kinds: ['request_error'] }).entries.at(-1)
    assert.equal(errorEntry.detail.message, 'boom')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger 集成: launch 失败（half-started）也记录 session_start 且不残留 session_end 之外的状态', async () => {
  const { dir, path } = tmpLedger()
  try {
    const script = standardScript({
      launch: (server, request) => {
        server.fail(request.seq, 'launch', 'adapter refused')
      },
    })
    const { manager } = buildManagerWithLedger(script, path)
    const owner = {}
    await assert.rejects(() => manager.launch(owner, { program: '/w/app.py' }))
    const { entries } = manager.ledgerQuery({})
    assert.ok(entries.some(entry => entry.kind === 'session_start'))
    // 失败会话被清理：disconnect 也尝试过（kill），session_end 由 disconnect 写入
    assert.ok(entries.some(entry => entry.kind === 'session_end'), '半启动会话也应记 session_end')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
