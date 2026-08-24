// 探针：打印 debugpy initialize 完整能力（找 exceptionBreakpointFilters）。
import { spawnAdapter } from '../lib/connection.js'

const spawned = spawnAdapter(
  { command: 'python', args: ['-m', 'debugpy.adapter'], launchArgs: {}, stopOnEntryKey: 'stopOnEntry' },
  { requestTimeoutMs: 10000 },
)
const body = await spawned.connection.send(
  'initialize',
  { adapterID: 'debugpy', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' },
  { timeoutMs: 10000 },
)
console.log('exceptionBreakpointFilters:', JSON.stringify(body?.exceptionBreakpointFilters))
console.log('supportsExceptionOptions:', body?.supportsExceptionOptions)
console.log('supportsExceptionInfoRequest:', body?.supportsExceptionInfoRequest)
process.exit(0)
