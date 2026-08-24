// 探针：debugpy 异常断点过滤器能力 + setExceptionBreakpoints(['all']) 是否生效。
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'
import { join } from 'node:path'

const fixture = join(process.cwd(), 'test', 'fixtures', 'debuggee_exc.py')
const manager = new DebugSessionManager({
  spawn: s => spawnAdapter(s, { requestTimeoutMs: 15000 }),
  resolveAdapter: o => resolveAdapter(o, {}),
  limits: { requestTimeoutMs: 15000, stepTimeoutMs: 15000, maxOutputChars: 40000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
  sessionIdleTimeoutMs: 0,
})
const owner = {}
const snap = await manager.launch(owner, { program: fixture })
console.log('launch:', snap.status, snap.stopReason)
const caps = snap.capabilities ?? {}
console.log('exception filters 声明:', JSON.stringify(caps))

const session = manager.sessionFor(owner)
// 直接发原始请求看响应
try {
  const body = await session.connection.send(
    'setExceptionBreakpoints',
    { filters: ['all'] },
    { timeoutMs: 10000 },
  )
  console.log('setExceptionBreakpoints OK:', JSON.stringify(body))
} catch (e) {
  console.log('setExceptionBreakpoints FAILED:', e.message)
}
const outcome = await session.resume('continue')
console.log('continue →', outcome.state, outcome.snapshot.stopReason, 'exitCode:', outcome.snapshot.exitCode)
await manager.disconnect(owner, session.id, true)
process.exit(0)
