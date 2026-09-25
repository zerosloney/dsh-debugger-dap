/**
 * Debug ledger tests: unit (record/query/rotation/persistence) plus
 * integration (session events on the fake adapter → ledger entries).
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

// ---------- Unit: DebugLedger ----------

test('ledger: record appends to memory and JSONL with seq/ts/sessionId/kind/detail', () => {
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

    // Persistence: one valid JSON document per line.
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) JSON.parse(line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: query filters by sessionId/kind/since/limit', () => {
  const path = join(tmpdir(), `dsh-dap-q-${Date.now()}-${Math.random()}.jsonl`)
  const ledger = DebugLedger.create({ path })
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
    // since filter (ts is an ISO string; lexicographic comparison).
    const since = ledger.query({ limit: 100 }).entries[5].ts
    const after = ledger.query({ since }).entries
    assert.ok(after.length >= 4)
    // Truncation flag past the limit.
    const small = ledger.query({ limit: 4 })
    assert.equal(small.truncated, true)
    assert.equal(small.entries.length, 4)
  } finally {
    rmSync(path, { force: true })
  }
})

test('ledger: file past the size cap rotates to .1', () => {
  const { dir, path } = tmpLedger()
  try {
    writeFileSync(path, 'x'.repeat(100))
    const ledger = DebugLedger.create({ path, maxFileBytes: 50 })
    ledger.record('dbg-1', 'stop', {})
    assert.ok(readFileSync(`${path}.1`, 'utf8').length >= 100, '.1 must keep the old content')
    assert.ok(readFileSync(path, 'utf8').includes('"stop"'), 'the new entry lands in the fresh file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: write failures never block later records (best-effort)', () => {
  const ledger = DebugLedger.create({ path: join('Z:\\definitely\\missing\\dir', 'ledger.jsonl') })
  ledger.record('dbg-1', 'session_start', {})
  assert.ok(ledger.writeFailureCount >= 0)
  // In-memory queries keep working.
  assert.equal(ledger.query({}).entries.length, 1)
})

// ---------- Integration: fake adapter → ledger events ----------

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

test('ledger integration: launch → breakpoints → hit → end events recorded', async () => {
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

    // Give the breakpoint-hit location enrichment a moment (recordStopLedger is async best-effort).
    await new Promise(resolve => setTimeout(resolve, 100))

    const { entries } = manager.ledgerQuery({ sessionId: session.id })
    const kinds = entries.map(entry => entry.kind)
    assert.ok(kinds.includes('session_start'), `expected session_start, got: ${kinds.join(',')}`)
    assert.ok(kinds.includes('breakpoints_set'), `expected breakpoints_set, got: ${kinds.join(',')}`)
    assert.ok(kinds.includes('breakpoint_hit'), `expected breakpoint_hit, got: ${kinds.join(',')}`)
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

test('ledger integration: exception stop records an exception entry (with location enrichment)', async () => {
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

test('ledger integration: adapter death (onClose) records session_end/adapter_close; failures record request_error', async () => {
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

    // request_error: a session-scoped action failure.
    manager.recordError(new Error('boom'), session.id)
    const errorEntry = manager.ledgerQuery({ sessionId: session.id, kinds: ['request_error'] }).entries.at(-1)
    assert.equal(errorEntry.detail.message, 'boom')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger integration: failed launch (half-started) still records session_start and a clean session_end', async () => {
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
    // The failed session is torn down: disconnect ran (including kill) and wrote session_end.
    assert.ok(entries.some(entry => entry.kind === 'session_end'), 'half-started sessions must record session_end too')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
