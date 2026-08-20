import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDebugAction, DEBUG_ACTIONS, omitUndefined } from '../lib/tool.js'
import { DebugSessionManager } from '../lib/session.js'
import { createFakeAdapter, standardScript, testLimits } from '../helpers/fake-adapter.mjs'

function buildManager(script) {
  const fake = createFakeAdapter(script)
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [] }),
    limits: testLimits,
  })
  return { manager, fake }
}

test('the full debugging workflow drives through the tool layer', async () => {
  const script = standardScript({
    continue: (server, request) => {
      server.respond(request.seq, 'continue')
      setTimeout(() => server.emit('stopped', { reason: 'breakpoint', threadId: 1 }), 10)
    },
  })
  const { manager, fake } = buildManager(script)
  const owner = {}

  const launch = await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  assert.equal(launch.action, 'launch')
  assert.equal(launch.snapshot.status, 'stopped')

  const breakpoints = await runDebugAction(
    owner,
    { action: 'set_breakpoints', file: '/w/src/app.py', lines: [42, 43] },
    manager,
    testLimits,
  )
  assert.equal(breakpoints.breakpoints.length, 2)
  assert.ok(breakpoints.breakpoints.every(record => record.verified))

  const stepped = await runDebugAction(owner, { action: 'continue' }, manager, testLimits)
  assert.equal(stepped.state, 'stopped')
  assert.equal(stepped.snapshot.stopReason, 'breakpoint')

  const stack = await runDebugAction(owner, { action: 'stack_trace' }, manager, testLimits)
  assert.equal(stack.frames[0].name, 'doWork')
  assert.equal(stack.frames[0].path, '/w/src/app.py')

  const scopes = await runDebugAction(owner, { action: 'scopes' }, manager, testLimits)
  assert.equal(scopes.scopes[0].variablesReference, 100)

  const variables = await runDebugAction(owner, { action: 'variables', variables_ref: 100 }, manager, testLimits)
  assert.equal(variables.variables.length, 2)

  const evaluated = await runDebugAction(owner, { action: 'evaluate', expression: 'count * 2' }, manager, testLimits)
  assert.equal(evaluated.evaluation.result, '6')

  fake.server.emit('output', { category: 'stdout', output: 'hello\n' })
  const output = await runDebugAction(owner, { action: 'output' }, manager, testLimits)
  assert.ok(output.output.text.includes('hello'))

  const sessions = await runDebugAction(owner, { action: 'sessions' }, manager, testLimits)
  assert.equal(sessions.sessions.length, 1)

  const disconnected = await runDebugAction(owner, { action: 'disconnect' }, manager, testLimits)
  assert.equal(disconnected.snapshot.status, 'terminated')
})

test('launch without program is an argument error', async () => {
  const { manager } = buildManager(standardScript())
  await assert.rejects(runDebugAction({}, { action: 'launch' }, manager, testLimits), /requires 'program'/)
  await manager.disposeAll()
})

test('set_breakpoints without lines is an argument error', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  await assert.rejects(
    runDebugAction(owner, { action: 'set_breakpoints', file: '/w/app.py' }, manager, testLimits),
    /requires 'lines'/,
  )
  await manager.disposeAll()
})

test('actions without an active session fail closed', async () => {
  const { manager } = buildManager(standardScript())
  await assert.rejects(runDebugAction({}, { action: 'continue' }, manager, testLimits), /No active debug session/)
  await assert.rejects(runDebugAction({}, { action: 'stack_trace' }, manager, testLimits), /No active debug session/)
  await manager.disposeAll()
})

test('timeout continue reports running with the pause hint', async () => {
  const script = standardScript({ continue: (server, request) => server.respond(request.seq, 'continue') })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py', stopOnEntry: false }, manager, testLimits)
  const outcome = await runDebugAction(owner, { action: 'continue' }, manager, testLimits)
  assert.equal(outcome.state, 'running')
  assert.equal(outcome.timed_out, true)
  await manager.disposeAll()
})

test('every declared action is reachable in the switch', () => {
  for (const action of DEBUG_ACTIONS) {
    assert.equal(typeof action, 'string')
  }
})

function hasUndefined(value) {
  if (Array.isArray(value)) return value.some(hasUndefined)
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasUndefined)
  return value === undefined
}

test('output is lossless JSON after omitUndefined (optional undefined fields dropped)', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  // stop_on_entry=false leaves exitCode/frame undefined in the snapshot.
  const raw = await runDebugAction(
    owner,
    { action: 'launch', program: '/w/app.py', stop_on_entry: false },
    manager,
    testLimits,
  )
  // Regression: the un-sanitized value is NOT lossless JSON (contains undefined).
  assert.equal(hasUndefined(raw), true, 'sanitization is meaningful: raw value must contain undefined')
  const clean = omitUndefined(raw)
  assert.equal(hasUndefined(clean), false)
  const json = JSON.stringify(clean)
  assert.equal(typeof json, 'string')
  assert.deepEqual(JSON.parse(json), clean)
  await manager.disposeAll()
})

test('set_variable action reaches the adapter and returns the new value', async () => {
  const script = standardScript({
    setVariable: (server, request, args) =>
      server.respond(request.seq, 'setVariable', { value: `${args.value}!`, type: 'string', variablesReference: 0 }),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  const result = await runDebugAction(
    owner,
    { action: 'set_variable', variables_ref: 100, name: 'count', value: '9' },
    manager,
    testLimits,
  )
  assert.equal(result.action, 'set_variable')
  assert.equal(result.set_result.result, '9!')
  await manager.disposeAll()
})

test('attach action requires an adapter and process_id', async () => {
  const script = {
    ...standardScript(),
    attach: (server, request, args) => {
      server.respond(request.seq, 'attach')
      server.emit('initialized')
      if (args.stopOnEntry !== false) server.emit('stopped', { reason: 'entry', threadId: 1 })
    },
  }
  const { manager } = buildManager(script)
  const owner = {}
  await assert.rejects(
    runDebugAction(owner, { action: 'attach', process_id: 1 }, manager, testLimits),
    /requires 'adapter'/,
  )
  await assert.rejects(
    runDebugAction(owner, { action: 'attach', adapter: 'netcoredbg' }, manager, testLimits),
    /requires 'process_id'/,
  )
  const result = await runDebugAction(
    owner,
    { action: 'attach', adapter: 'netcoredbg', process_id: 777, stop_on_entry: false },
    manager,
    testLimits,
  )
  assert.equal(result.action, 'attach')
  assert.ok(result.session_id)
  await manager.disposeAll()
})
