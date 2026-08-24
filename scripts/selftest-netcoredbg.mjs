// Real netcoredbg smoke through the plugin's session layer: launch the built
// .NET dll, stop at entry, step, inspect, disconnect. Run from the repo root.
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'

const dll = process.argv[2]
if (!dll) {
  console.error('usage: node scripts/selftest-netcoredbg.mjs <path/to/smoke.dll>')
  process.exit(2)
}

const spec = resolveAdapter({ adapter: 'netcoredbg', program: dll })
console.log('recipe:', JSON.stringify({ command: spec.command, args: spec.args, launchArgs: spec.launchArgs, stopOnEntryKey: spec.stopOnEntryKey }))

const manager = new DebugSessionManager({
  spawn: s => spawnAdapter(s, { requestTimeoutMs: 15000 }),
  resolveAdapter: () => spec,
  limits: { requestTimeoutMs: 15000, stepTimeoutMs: 10000, maxOutputChars: 4000, maxStackFrames: 20, maxVariables: 100, maxResultChars: 16000 },
  sessionIdleTimeoutMs: 0,
})

const owner = {}
try {
  const launched = await manager.launch(owner, { program: dll, cwd: undefined, stopOnEntry: true })
  console.log('launch:', launched.status, launched.stopReason, 'thread', launched.threadId)
  if (launched.status !== 'stopped' || launched.stopReason !== 'entry') throw new Error(`unexpected entry state: ${JSON.stringify(launched)}`)

  const session = manager.sessionFor(owner)
  const stepped = await session.resume('stepIn')
  console.log('stepIn ->', stepped.state, stepped.snapshot.stopReason, stepped.snapshot.frame?.name ?? '(no frame)')

  const threads = await session.threads()
  console.log('threads:', threads.length)
  const frames = await session.stackTrace(5)
  console.log('frames:', frames.length, frames[0]?.name ?? '')

  const evalResult = await session.evaluate('total', frames[0]?.id)
  console.log('evaluate total =', evalResult.result)

  await manager.disconnect(owner, undefined, true)
  console.log('disconnected cleanly')
  console.log('NETCOREDBG-REAL-SMOKE-PASS')
} finally {
  await manager.disposeAll()
}
