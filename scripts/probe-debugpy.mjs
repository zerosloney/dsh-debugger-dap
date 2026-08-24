// 探针：直接 spawn python -m debugpy.adapter 并做 DAP initialize，定位握手卡点。
import { spawnAdapter } from '../lib/connection.js'

const spec = { command: 'python', args: ['-m', 'debugpy.adapter'], launchArgs: {}, stopOnEntryKey: 'stopOnEntry' }
const spawned = spawnAdapter(spec, { requestTimeoutMs: 10000 })
const conn = spawned.connection
const t0 = Date.now()
try {
  const body = await conn.send(
    'initialize',
    { adapterID: 'debugpy', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' },
    { timeoutMs: 10000 },
  )
  console.log('initialize OK after', Date.now() - t0, 'ms')
  console.log('capabilities keys:', Object.keys(body ?? {}).slice(0, 12).join(', '))
  console.log('supportsConfigurationDoneRequest:', body?.supportsConfigurationDoneRequest)
} catch (error) {
  console.log('initialize FAILED after', Date.now() - t0, 'ms:', error.message)
  console.log('adapter stderr tail:', spawned.stderrTail())
}
process.exit(0)
