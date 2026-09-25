// Replica of smoke.test.mjs (with step logging), run standalone to locate hangs.
import { existsSync } from 'node:fs'
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'
import { join } from 'node:path'

const fixture = join(process.cwd(), 'test', 'fixtures', 'hello.py')
console.log('cwd:', process.cwd())
console.log('fixture exists:', existsSync(fixture))

const manager = new DebugSessionManager({
  spawn: spec => spawnAdapter(spec, { requestTimeoutMs: 15000 }),
  resolveAdapter: () => resolveAdapter({ adapter: 'debugpy', program: fixture }),
  limits: { requestTimeoutMs: 15000, stepTimeoutMs: 15000, maxOutputChars: 40000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
  sessionIdleTimeoutMs: 0,
})
const owner = {}
const t0 = Date.now()
console.log('launching...')
const snapshot = await manager.launch(owner, { program: fixture })
console.log(`launch OK (${Date.now() - t0}ms):`, snapshot.status, snapshot.stopReason)
const session = manager.sessionFor(owner)
console.log('setBreakpoints line 5...')
const bps = await session.setBreakpoints(fixture, [{ line: 5 }])
console.log('bps:', JSON.stringify(bps))
console.log('continue...')
const outcome = await session.resume('continue')
console.log(`continue OK (${Date.now() - t0}ms):`, outcome.state, outcome.snapshot.stopReason)
const frames = await session.stackTrace(5)
console.log('frames:', frames.length)
const scopes = await session.scopes(frames[0].id)
console.log('scopes:', scopes.length)
const { variables } = await session.variables(scopes[0].variablesReference)
console.log('variables:', variables.length)
await manager.disconnect(owner, undefined, true)
await manager.disposeAll()
console.log('ALL DONE', Date.now() - t0, 'ms')
process.exit(0)
