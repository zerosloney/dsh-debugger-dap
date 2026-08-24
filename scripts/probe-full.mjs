// 全链路探针：manager + debugpy 真实会话，逐步打日志，定位挂起点。
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'
import { join } from 'node:path'

const fixture = join(process.cwd(), 'test', 'fixtures', 'hello.py')
const spec = resolveAdapter({ adapter: 'debugpy', program: fixture })
console.log('adapter spec:', JSON.stringify(spec))

const manager = new DebugSessionManager({
  spawn: s => spawnAdapter(s, { requestTimeoutMs: 15000 }),
  resolveAdapter: () => spec,
  limits: {
    requestTimeoutMs: 15000, stepTimeoutMs: 15000, maxOutputChars: 40000,
    maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000,
  },
  sessionIdleTimeoutMs: 0,
})
const owner = {}

const step = (name, fn) => {
  const t0 = Date.now()
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`STALL at: ${name} (>30s)`)), 30000)),
  ]).then(r => { console.log(`OK ${name} (${Date.now() - t0}ms)`); return r }, e => { console.log(`FAIL ${name}: ${e.message}`); throw e })
}

try {
  const snap = await step('launch', () => manager.launch(owner, { program: fixture }))
  console.log('  status:', snap.status, 'stopReason:', snap.stopReason, 'threadId:', snap.threadId)
  const session = manager.sessionFor(owner)

  const bps = await step('setBreakpoints', () => session.setBreakpoints(fixture, [{ line: 3 }]))
  console.log('  verified:', bps.map(b => `${b.line}:${b.verified}`).join(', '))

  const outcome = await step('continue', () => session.resume('continue'))
  console.log('  state:', outcome.state, 'stopReason:', outcome.snapshot.stopReason, 'exitCode:', outcome.snapshot.exitCode)

  const frames = await step('stackTrace', () => session.stackTrace(5))
  console.log('  frames:', frames.map(f => `${f.name}@${f.path}:${f.line}`).join(' | '))

  const scopes = await step('scopes', () => session.scopes(frames[0]?.id))
  const vars = await step('variables', () => session.variables(scopes[0]?.variablesReference ?? 0))
  console.log('  vars:', vars.variables.map(v => `${v.name}=${v.value}`).join(', '))

  await step('disconnect', () => manager.disconnect(owner, undefined, true))
  console.log('ALL OK')
} catch (error) {
  console.log('FLOW FAILED:', error.message)
}
await step('disposeAll', () => manager.disposeAll())
process.exit(0)
