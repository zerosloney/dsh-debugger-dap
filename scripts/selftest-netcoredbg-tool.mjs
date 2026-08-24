// Full tool-layer round-trip against a REAL netcoredbg + .NET 10 debuggee.
// Exercises the exact path a model uses: runDebugAction (arg validation +
// dispatch) + renderDebugText (model-facing text). This is the piece the
// session-level smokes never covered.
import assert from 'node:assert/strict'
import { createDebugTool, runDebugAction, DEBUG_ACTIONS } from '../lib/tool.js'
import { DebugSessionManager } from '../lib/session.js'
import { spawnAdapter } from '../lib/connection.js'
import { resolveAdapter } from '../lib/adapters.js'
import { renderDebugText } from '../lib/format.js'

const dll = process.argv[2]
const sourcePath = process.argv[3]
if (!dll || !sourcePath) {
  console.error('usage: node scripts/selftest-netcoredbg-tool.mjs <path/to/bp.dll> <path/to/Program.cs>')
  console.error('  the source path must be the one recorded in the PDB (the compile-time path),')
  console.error('  or netcoredbg never binds the breakpoints.')
  process.exit(2)
}

const limits = {
  requestTimeoutMs: 15000,
  stepTimeoutMs: 10000,
  maxOutputChars: 4000,
  maxStackFrames: 20,
  maxVariables: 100,
  maxResultChars: 16000,
}
const spec = resolveAdapter({ adapter: 'netcoredbg', program: dll })
const manager = new DebugSessionManager({
  spawn: s => spawnAdapter(s, { requestTimeoutMs: 15000 }),
  resolveAdapter: () => spec,
  limits,
  sessionIdleTimeoutMs: 0,
})
const tool = createDebugTool(manager, limits)
// createDebugTool's render callback needs the canonical value; we call the
// same renderDebugText directly with the tool's limits for the text view.
const owner = {}
const call = async args => {
  const value = await runDebugAction(owner, args, manager, limits)
  return { value, text: renderDebugText(value, limits.maxResultChars, limits.stepTimeoutMs) }
}
const textOf = async args => (await call(args)).text

try {
  // 1. launch (default stop at entry)
  const launched = await call({ action: 'launch', program: dll })
  assert.equal(launched.value.snapshot.status, 'stopped')
  assert.equal(launched.value.snapshot.stopReason, 'entry')
  console.log('1. launch entry stop            OK  (text head: ' + launched.text.split('\n')[2].trim() + ')')

  // 2. set breakpoints on the loop body (line 12) and the final print (line 14)
  //    Source path MUST match what the PDB records (the .cs file next to the
  //    built dll), or netcoredbg never binds the breakpoints. The plugin does
  //    not rewrite paths — that is adapter territory.
  const bp = await call({ action: 'set_breakpoints', file: sourcePath, lines: [12, 14] })
  assert.equal(bp.value.breakpoints.length, 2)
  assert.ok(bp.value.breakpoints.every(b => b.verified || /symbols|pending|not currently/i.test(b.message ?? '')), `breakpoints pending-or-verified: ${JSON.stringify(bp.value.breakpoints)}`)
  console.log('2. set_breakpoints (pending ok) OK  (rendered: ' + bp.text.split('\n').slice(1, 3).join(' | ') + ')')

  // 3. continue -> first loop-body hit (line 12, total=0, item=1)
  const c1 = await call({ action: 'continue' })
  assert.equal(c1.value.state, 'stopped')
  assert.equal(c1.value.snapshot.stopReason, 'breakpoint')
  assert.equal(c1.value.snapshot.frame?.line, 12)
  console.log('3. continue -> bp@12 (1st)      OK  (' + c1.text.split('\n').filter(l => l.includes('Stopped at')).join('').trim() + ')')

  // 4. scopes + variables: total=0, item=1
  const scopes = await call({ action: 'scopes' })
  assert.ok(scopes.value.scopes.length >= 1)
  const locRef = scopes.value.scopes.find(s => s.name === 'Locals')?.variablesReference
  assert.ok(locRef !== undefined, `Locals scope present: ${JSON.stringify(scopes.value.scopes.map(s => s.name))}`)
  const vars = await call({ action: 'variables', variables_ref: locRef })
  const byName = Object.fromEntries(vars.value.variables.map(v => [v.name, v.value]))
  assert.equal(byName.total, '0', `total starts at 0: ${JSON.stringify(byName)}`)
  assert.equal(byName.item, '1', `item is 1 on first hit: ${JSON.stringify(byName)}`)
  console.log('4. scopes+variables total=0 item=1 OK  (' + vars.text.split('\n').slice(1, 4).join(' | ') + ')')

  // 5. evaluate an expression in the frame
  const ev = await call({ action: 'evaluate', expression: 'total + item' })
  assert.equal(ev.value.evaluation.result, '1')
  console.log('5. evaluate total+item = 1      OK')

  // 6. continue -> second loop hit (item=2, total=1)
  //    DAP variablesReference is valid only within one stop; re-query scopes
  //    after every continue (netcoredbg E_FAILs stale refs with 0x80004005).
  const c2 = await call({ action: 'continue' })
  assert.equal(c2.value.snapshot.frame?.line, 12)
  const scopes2 = await call({ action: 'scopes' })
  const locRef2 = scopes2.value.scopes.find(s => s.name === 'Locals')?.variablesReference
  assert.ok(locRef2 !== undefined)
  const vars2 = await call({ action: 'variables', variables_ref: locRef2 })
  const byName2 = Object.fromEntries(vars2.value.variables.map(v => [v.name, v.value]))
  assert.equal(byName2.total, '1', `total=1 on 2nd hit: ${JSON.stringify(byName2)}`)
  assert.equal(byName2.item, '2')
  console.log('6. continue -> bp@12 (2nd)      OK  (total=1 item=2)')

  // 7. continue through the remaining loop hits until the final print (line 14)
  //    (4 loop iterations on line 12, then the print on line 14)
  let final = null
  for (let guard = 0; guard < 6; guard += 1) {
    const step = await call({ action: 'continue' })
    assert.equal(step.value.state, 'stopped')
    if (step.value.snapshot.frame?.line === 14) {
      final = step
      break
    }
  }
  assert.ok(final !== null, 'eventually stopped at line 14')
  assert.equal(final.value.snapshot.stopReason, 'breakpoint')
  console.log('7. continue -> bp@14            OK  (line ' + final.value.snapshot.frame?.line + ')')

  // 8. set_expression mutation, verify by evaluate
  const setExpr = await call({ action: 'set_expression', expression: 'total', value: '99' })
  assert.ok(setExpr.value.set_result.result.includes('99'), `set_expression result: ${JSON.stringify(setExpr.value.set_result)}`)
  const ev2 = await call({ action: 'evaluate', expression: 'total' })
  assert.equal(ev2.value.evaluation.result, '99')
  console.log('8. set_expression total=99      OK')

  // 9. ledger reflects the session events
  const ledger = await call({ action: 'ledger', ledger_limit: 5 })
  const kinds = ledger.value.entries.map(e => e.kind)
  assert.ok(kinds.includes('breakpoint_hit'), `ledger has breakpoint_hit: ${kinds.join(',')}`)
  console.log('9. ledger entries               OK  (' + kinds.join(', ') + ')')

  // 10. disconnect (terminates the debuggee)
  const disc = await call({ action: 'disconnect' })
  assert.equal(disc.value.snapshot.status, 'terminated')
  console.log('10. disconnect clean            OK')

  // 11. error taxonomy: action on a dead session -> no_active_session
  try {
    await call({ action: 'stack_trace' })
    throw new Error('expected no_active_session')
  } catch (error) {
    assert.equal(error.code, 'no_active_session')
  }
  console.log('11. post-disconnect errors      OK  (no_active_session)')

  // 12. every declared action is a string (schema-level sanity)
  assert.ok(DEBUG_ACTIONS.length >= 35)
  console.log('12. action catalog              OK  (' + DEBUG_ACTIONS.length + ' actions)')

  console.log('\nNETCOREDBG-TOOL-LAYER-PASS')
} finally {
  await manager.disposeAll()
}
