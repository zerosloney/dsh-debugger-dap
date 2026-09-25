/**
 * Real debugpy closed-loop verification (e2e): mirrors the Goal Brief's
 * seven completion criteria.
 *
 * Run: node scripts/e2e-real.mjs (requires `pip install debugpy`)
 * Output: per-section logs + the full ledger JSONL + a process-leak check;
 * any assertion failure exits non-zero.
 *
 * Three sub-scenarios (deterministic order):
 *   A. debuggee.py: entry → breakpoint 13 → stack/scopes/variables → next/continue → evaluate → disconnect
 *   B. debuggee.py: entry → breakpoint 11 → stepIn into add → stepOut back to main → disconnect
 *   C. debuggee_exc.py: entry → exception breakpoint 'all' → ZeroDivisionError stop → disconnect
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'
import { DebugLedger } from '../lib/ledger.js'

const FIXTURES = join(process.cwd(), 'test', 'fixtures')
const LEDGER_PATH = join(process.cwd(), '.e2e-ledger.jsonl')
if (existsSync(LEDGER_PATH)) rmSync(LEDGER_PATH)

const LIMITS = {
  requestTimeoutMs: 20000,
  stepTimeoutMs: 20000,
  maxOutputChars: 40000,
  maxStackFrames: 20,
  maxVariables: 100,
  maxResultChars: 16000,
}

function countDebugpyAdapters() {
  try {
    // Filter by executable name: the wmic query string itself contains
    // 'debugpy.adapter' and would otherwise self-match.
    const out = execSync(
      "wmic process where \"name='python.exe'\" get commandline /format:csv",
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString()
    return out.split('\n').filter(line => line.includes('debugpy.adapter')).length
  } catch {
    return -1
  }
}

const baselineAdapters = countDebugpyAdapters()
console.log(`[0] debugpy.adapter baseline process count: ${baselineAdapters}`)

const manager = new DebugSessionManager({
  spawn: spec => spawnAdapter(spec, { requestTimeoutMs: 20000 }),
  resolveAdapter: options => resolveAdapter(options, {}),
  limits: LIMITS,
  sessionIdleTimeoutMs: 0,
  ledger: DebugLedger.create({ path: LEDGER_PATH }),
})
const owner = {}
const fixture = join(FIXTURES, 'debuggee.py')

try {

// ================= Scenario A: breakpoints / stack / variables / stepping / evaluate =================
console.log('\n=== [1] launch (debugpy, stopOnEntry) ===')
const snap = await manager.launch(owner, { program: fixture })
assert.equal(snap.status, 'stopped', 'launch must stop at entry')
assert.equal(snap.stopReason, 'entry', 'entry stop reason must be "entry"')
assert.ok(snap.threadId !== undefined, 'entry stop must carry a threadId')
console.log(`  ok: status=${snap.status} stopReason=${snap.stopReason} threadId=${snap.threadId}`)

const session = manager.sessionFor(owner)

console.log('\n=== [2] breakpoint: line 13 hit (source + line correct) ===')
const bps = await session.setBreakpoints(fixture, [{ line: 13 }])
assert.ok(bps.every(bp => bp.verified), `all breakpoints must be verified: ${JSON.stringify(bps)}`)
const hit = await session.resume('continue')
assert.equal(hit.state, 'stopped', 'continue must stop at the breakpoint')
assert.equal(hit.snapshot.stopReason, 'breakpoint', 'stop reason must be "breakpoint"')
assert.equal(hit.snapshot.frame?.line, 13, `hit line must be 13, got ${hit.snapshot.frame?.line}`)
assert.ok(
  hit.snapshot.frame?.path?.replaceAll('\\', '/').endsWith('test/fixtures/debuggee.py'),
  `source must point at the debuggee, got ${hit.snapshot.frame?.path}`,
)
console.log(`  ok: line=${hit.snapshot.frame?.line} source=${hit.snapshot.frame?.path}`)

console.log('\n=== [3] stackTrace / scopes / variables ===')
const frames = await session.stackTrace(10)
assert.ok(frames.some(frame => frame.name === 'main'), `stack must contain a main frame: ${frames.map(f => f.name).join(',')}`)
const scopes = await session.scopes(frames[0].id)
assert.ok(scopes.some(scope => scope.name === 'Locals'), `expected a Locals scope: ${scopes.map(s => s.name).join(',')}`)
const { variables } = await session.variables(scopes.find(s => s.name === 'Locals').variablesReference)
const byName = Object.fromEntries(variables.map(v => [v.name, v.value]))
assert.equal(byName.count, '1', `count must be 1, got ${byName.count}`)
assert.equal(byName.total, '42', `total must be 42, got ${byName.total}`)
assert.equal(byName.i, '0', `i must be 0, got ${byName.i}`)
console.log(`  ok: stack=${frames.map(f => f.name).join('>')} variables count=${byName.count} total=${byName.total} i=${byName.i}`)

console.log('\n=== [4] stepping (next) and evaluate ===')
const afterNext = await session.resume('next')
assert.equal(afterNext.state, 'stopped', 'next must stop')
assert.equal(afterNext.snapshot.stopReason, 'step', 'next stop reason must be "step"')
assert.notEqual(afterNext.snapshot.frame?.line, 13, 'next must leave line 13')
console.log(`  next: line ${hit.snapshot.frame?.line} -> ${afterNext.snapshot.frame?.line} (reason=${afterNext.snapshot.stopReason})`)

const again = await session.resume('continue')
assert.equal(again.state, 'stopped')
assert.equal(again.snapshot.stopReason, 'breakpoint')
assert.equal(again.snapshot.frame?.line, 13, 'the second breakpoint hit must be on line 13')
const evaluation = await session.evaluate('count + 41', undefined, 'repl')
assert.equal(evaluation.result, '42', `evaluate count+41 must be 42, got ${evaluation.result}`)
console.log(`  ok: continue hit line 13 again; evaluate("count + 41") = ${evaluation.result}`)

await manager.disconnect(owner, session.id, true)
console.log('  scenario A disconnected')

// ================= Scenario B: stepIn / stepOut =================
console.log('\n=== [5] stepping (stepIn / stepOut, entering add) ===')
const snapB = await manager.launch(owner, { program: fixture })
assert.equal(snapB.status, 'stopped')
const sessionB = manager.sessionFor(owner)
const bp11 = await sessionB.setBreakpoints(fixture, [{ line: 11 }])
assert.ok(bp11[0].verified, 'the line 11 breakpoint must be verified')
const toCall = await sessionB.resume('continue')
assert.equal(toCall.snapshot.frame?.line, 11, `must stop at line 11 (the add call), got ${toCall.snapshot.frame?.line}`)
const stepIn = await sessionB.resume('stepIn')
assert.equal(stepIn.state, 'stopped')
assert.equal(stepIn.snapshot.frame?.name, 'add', `stepIn must enter the add frame, got ${stepIn.snapshot.frame?.name}`)
assert.equal(stepIn.snapshot.frame?.line, 5, `stepIn must stop at line 5 of add, got ${stepIn.snapshot.frame?.line}`)
console.log(`  stepIn: entered ${stepIn.snapshot.frame?.name}@line ${stepIn.snapshot.frame?.line}`)
const stepOut = await sessionB.resume('stepOut')
assert.equal(stepOut.state, 'stopped')
assert.equal(stepOut.snapshot.frame?.name, 'main', `stepOut must return to the main frame, got ${stepOut.snapshot.frame?.name}`)
console.log(`  stepOut: back in ${stepOut.snapshot.frame?.name}@line ${stepOut.snapshot.frame?.line}`)
await manager.disconnect(owner, sessionB.id, true)
console.log('  scenario B disconnected')

// ================= Scenario C: exception break =================
console.log('\n=== [6] exception breakpoints (debuggee_exc.py) ===')
const excFixture = join(FIXTURES, 'debuggee_exc.py')
const excSnap = await manager.launch(owner, { program: excFixture })
assert.equal(excSnap.status, 'stopped', 'the exception scenario starts stopped at entry')
const excSession = manager.sessionFor(owner)
await excSession.setExceptionBreakpoints(['all'], undefined)
const excHit = await excSession.resume('continue')
assert.equal(excHit.state, 'stopped', 'the exception must stop the program')
assert.equal(excHit.snapshot.stopReason, 'exception', 'stop reason must be "exception"')
const info = await excSession.exceptionInfo(undefined)
assert.match(info.exceptionId, /ZeroDivisionError/, `exception must be ZeroDivisionError, got ${info.exceptionId}`)
console.log(`  ok: ${info.exceptionId} @ line ${excHit.snapshot.frame?.line}`)
await manager.disconnect(owner, excSession.id, true)
console.log('  scenario C disconnected')

// ================= Scenario 7: resource cleanup =================
console.log('\n=== [7] no leftover processes after disconnect ===')
await new Promise(resolve => setTimeout(resolve, 1500))
const remaining = countDebugpyAdapters()
assert.equal(remaining, baselineAdapters, `no debugpy.adapter processes may survive disconnect (baseline ${baselineAdapters}, now ${remaining})`)
console.log(`  ok: debugpy.adapter processes ${baselineAdapters} -> ${remaining}`)

// ================= Scenario 8: ledger =================
console.log('\n=== [8] debug session ledger (ledger.jsonl) ===')
const lines = readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map(line => JSON.parse(line))
console.log(`  ${lines.length} entries:`)
for (const entry of lines) {
  const detail = Object.keys(entry.detail).length > 0 ? JSON.stringify(entry.detail) : ''
  console.log(`  - [${entry.ts}] ${entry.sessionId} ${entry.kind} ${detail}`)
}
const kinds = new Set(lines.map(entry => entry.kind))
for (const kind of ['session_start', 'breakpoints_set', 'breakpoint_hit', 'exception', 'stop', 'session_end']) {
  assert.ok(kinds.has(kind), `ledger must contain ${kind} entries, got: ${[...kinds].join(',')}`)
}
const hits = lines.filter(entry => entry.kind === 'breakpoint_hit')
assert.ok(hits.some(entry => entry.detail.line === 13), 'breakpoint_hit entries must include line=13')
assert.ok(hits.some(entry => entry.detail.line === 11), 'breakpoint_hit entries must include line=11')
const exceptions = lines.filter(entry => entry.kind === 'exception')
assert.ok(exceptions.length >= 1 && exceptions[0].detail.line === 5, 'exception entries must include line=5')
const ends = lines.filter(entry => entry.kind === 'session_end')
assert.equal(ends.length, 3, 'all three sessions must record session_end')
console.log('  ok: ledger covers every key event kind; breakpoint/exception entries carry locations')

await manager.disposeAll()
console.log('\n===== E2E all checks passed =====')
} finally {
  // Clean up every adapter process on assertion failure too; no leftovers.
  await manager.disposeAll()
}
