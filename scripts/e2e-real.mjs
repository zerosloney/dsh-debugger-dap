/**
 * 真实 debugpy 会话闭环验证（e2e）：对应 Goal Brief 的七条完成标准。
 *
 * 运行：node scripts/e2e-real.mjs（需 `pip install debugpy`）
 * 输出：分节日志 + 台账 JSONL 全文 + 进程泄漏检查；断言失败即非零退出。
 *
 * 三个子场景（确定性顺序）：
 *   A. debuggee.py：入口 → 断点 13 → 栈/作用域/变量 → next/continue → evaluate → 断开
 *   B. debuggee.py：入口 → 断点 11 → stepIn 进入 add → stepOut 回 main → 断开
 *   C. debuggee_exc.py：入口 → 异常断点 all → 异常停机 ZeroDivisionError → 断开
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
    // 按可执行名过滤，避免 wmic 查询串自匹配（查询串本身含 'debugpy.adapter'）。
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
console.log(`[0] debugpy.adapter 基线进程数: ${baselineAdapters}`)

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

// ================= 场景 A：断点 / 栈 / 变量 / 单步 / 求值 =================
console.log('\n=== [1] launch（debugpy，stopOnEntry） ===')
const snap = await manager.launch(owner, { program: fixture })
assert.equal(snap.status, 'stopped', 'launch 后应停在入口')
assert.equal(snap.stopReason, 'entry', '入口停止 reason 应为 entry')
assert.ok(snap.threadId !== undefined, '入口停止应携带 threadId')
console.log(`  通过: status=${snap.status} stopReason=${snap.stopReason} threadId=${snap.threadId}`)

const session = manager.sessionFor(owner)

console.log('\n=== [2] 断点：line 13 命中（source + line 正确） ===')
const bps = await session.setBreakpoints(fixture, [{ line: 13 }])
assert.ok(bps.every(bp => bp.verified), `断点应全部 verified: ${JSON.stringify(bps)}`)
const hit = await session.resume('continue')
assert.equal(hit.state, 'stopped', 'continue 应停在断点')
assert.equal(hit.snapshot.stopReason, 'breakpoint', '停因应为 breakpoint')
assert.equal(hit.snapshot.frame?.line, 13, `命中行应为 13，实际 ${hit.snapshot.frame?.line}`)
assert.ok(
  hit.snapshot.frame?.path?.replaceAll('\\', '/').endsWith('test/fixtures/debuggee.py'),
  `source 应指向被测程序，实际 ${hit.snapshot.frame?.path}`,
)
console.log(`  通过: line=${hit.snapshot.frame?.line} source=${hit.snapshot.frame?.path}`)

console.log('\n=== [3] stackTrace / scopes / variables ===')
const frames = await session.stackTrace(10)
assert.ok(frames.some(frame => frame.name === 'main'), `栈中应含 main 帧: ${frames.map(f => f.name).join(',')}`)
const scopes = await session.scopes(frames[0].id)
assert.ok(scopes.some(scope => scope.name === 'Locals'), `应含 Locals 作用域: ${scopes.map(s => s.name).join(',')}`)
const { variables } = await session.variables(scopes.find(s => s.name === 'Locals').variablesReference)
const byName = Object.fromEntries(variables.map(v => [v.name, v.value]))
assert.equal(byName.count, '1', `count 应为 1，实际 ${byName.count}`)
assert.equal(byName.total, '42', `total 应为 42，实际 ${byName.total}`)
assert.equal(byName.i, '0', `i 应为 0，实际 ${byName.i}`)
console.log(`  通过: 栈=${frames.map(f => f.name).join('>')} 变量 count=${byName.count} total=${byName.total} i=${byName.i}`)

console.log('\n=== [4] 单步（next）与求值 ===')
const afterNext = await session.resume('next')
assert.equal(afterNext.state, 'stopped', 'next 后应停机')
assert.equal(afterNext.snapshot.stopReason, 'step', 'next 停因应为 step')
assert.notEqual(afterNext.snapshot.frame?.line, 13, 'next 应离开 line 13')
console.log(`  next: line ${hit.snapshot.frame?.line} -> ${afterNext.snapshot.frame?.line} (reason=${afterNext.snapshot.stopReason})`)

const again = await session.resume('continue')
assert.equal(again.state, 'stopped')
assert.equal(again.snapshot.stopReason, 'breakpoint')
assert.equal(again.snapshot.frame?.line, 13, '第二次断点命中应在 line 13')
const evaluation = await session.evaluate('count + 41', undefined, 'repl')
assert.equal(evaluation.result, '42', `evaluate count+41 应为 42，实际 ${evaluation.result}`)
console.log(`  通过: continue 再次命中 line 13；evaluate("count + 41") = ${evaluation.result}`)

await manager.disconnect(owner, session.id, true)
console.log('  场景 A 断开完成')

// ================= 场景 B：stepIn / stepOut =================
console.log('\n=== [5] 单步（stepIn / stepOut，进入 add 函数） ===')
const snapB = await manager.launch(owner, { program: fixture })
assert.equal(snapB.status, 'stopped')
const sessionB = manager.sessionFor(owner)
const bp11 = await sessionB.setBreakpoints(fixture, [{ line: 11 }])
assert.ok(bp11[0].verified, 'line 11 断点应 verified')
const toCall = await sessionB.resume('continue')
assert.equal(toCall.snapshot.frame?.line, 11, `应停在 line 11（add 调用行），实际 ${toCall.snapshot.frame?.line}`)
const stepIn = await sessionB.resume('stepIn')
assert.equal(stepIn.state, 'stopped')
assert.equal(stepIn.snapshot.frame?.name, 'add', `stepIn 应进入 add 帧，实际 ${stepIn.snapshot.frame?.name}`)
assert.equal(stepIn.snapshot.frame?.line, 5, `stepIn 应停在 add 第 5 行，实际 ${stepIn.snapshot.frame?.line}`)
console.log(`  stepIn: 进入 ${stepIn.snapshot.frame?.name}@line ${stepIn.snapshot.frame?.line}`)
const stepOut = await sessionB.resume('stepOut')
assert.equal(stepOut.state, 'stopped')
assert.equal(stepOut.snapshot.frame?.name, 'main', `stepOut 应回到 main 帧，实际 ${stepOut.snapshot.frame?.name}`)
console.log(`  stepOut: 回到 ${stepOut.snapshot.frame?.name}@line ${stepOut.snapshot.frame?.line}`)
await manager.disconnect(owner, sessionB.id, true)
console.log('  场景 B 断开完成')

// ================= 场景 C：异常中断 =================
console.log('\n=== [6] 异常断点（debuggee_exc.py） ===')
const excFixture = join(FIXTURES, 'debuggee_exc.py')
const excSnap = await manager.launch(owner, { program: excFixture })
assert.equal(excSnap.status, 'stopped', '异常场景从入口停止开始')
const excSession = manager.sessionFor(owner)
await excSession.setExceptionBreakpoints(['all'], undefined)
const excHit = await excSession.resume('continue')
assert.equal(excHit.state, 'stopped', '异常应导致停机')
assert.equal(excHit.snapshot.stopReason, 'exception', '停因应为 exception')
const info = await excSession.exceptionInfo(undefined)
assert.match(info.exceptionId, /ZeroDivisionError/, `异常应为 ZeroDivisionError，实际 ${info.exceptionId}`)
console.log(`  通过: ${info.exceptionId} @ line ${excHit.snapshot.frame?.line}`)
await manager.disconnect(owner, excSession.id, true)
console.log('  场景 C 断开完成')

// ================= 场景 7：资源清理 =================
console.log('\n=== [7] 断开后无残留进程 ===')
await new Promise(resolve => setTimeout(resolve, 1500))
const remaining = countDebugpyAdapters()
assert.equal(remaining, baselineAdapters, `断连后不应有残留 debugpy.adapter 进程（基线 ${baselineAdapters}，现在 ${remaining}）`)
console.log(`  通过: debugpy.adapter 进程 ${baselineAdapters} -> ${remaining}`)

// ================= 场景 8：台账 =================
console.log('\n=== [8] 调试会话台账（ledger.jsonl） ===')
const lines = readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map(line => JSON.parse(line))
console.log(`  共 ${lines.length} 条记录：`)
for (const entry of lines) {
  const detail = Object.keys(entry.detail).length > 0 ? JSON.stringify(entry.detail) : ''
  console.log(`  - [${entry.ts}] ${entry.sessionId} ${entry.kind} ${detail}`)
}
const kinds = new Set(lines.map(entry => entry.kind))
for (const kind of ['session_start', 'breakpoints_set', 'breakpoint_hit', 'exception', 'stop', 'session_end']) {
  assert.ok(kinds.has(kind), `台账应含 ${kind} 条目，实际: ${[...kinds].join(',')}`)
}
const hits = lines.filter(entry => entry.kind === 'breakpoint_hit')
assert.ok(hits.some(entry => entry.detail.line === 13), '断点命中条目应含 line=13')
assert.ok(hits.some(entry => entry.detail.line === 11), '断点命中条目应含 line=11')
const exceptions = lines.filter(entry => entry.kind === 'exception')
assert.ok(exceptions.length >= 1 && exceptions[0].detail.line === 5, '异常条目应含 line=5')
const ends = lines.filter(entry => entry.kind === 'session_end')
assert.equal(ends.length, 3, '三个会话都应记 session_end')
console.log('  通过: 台账包含全部关键事件种类，断点/异常条目带位置')

await manager.disposeAll()
console.log('\n===== E2E 全部通过 =====')
} finally {
  // 断言失败时也要清理全部适配器进程，避免残留。
  await manager.disposeAll()
}
