import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DebugSessionManager, DebugError } from '../lib/session.js'
import { createFakeAdapter, standardScript, testLimits } from '../helpers/fake-adapter.mjs'

function buildManager(script, limits = testLimits) {
  const fake = createFakeAdapter(script)
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [] }),
    limits,
  })
  return { manager, fake }
}

test('launch with stopOnEntry stops at entry with location', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  const snapshot = await manager.launch(owner, { program: '/w/app.py' })
  assert.equal(snapshot.status, 'stopped')
  assert.equal(snapshot.stopReason, 'entry')
  assert.equal(snapshot.threadId, 1)
  assert.equal(snapshot.frame?.name, 'doWork')
  assert.equal(snapshot.frame?.path, '/w/src/app.py')
  assert.equal(snapshot.frame?.line, 42)
  await manager.disposeAll()
})

test('launch handshake orders initialize → launch → initialized → configurationDone', async () => {
  const { manager, fake } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py' })
  const commands = fake.server.received.map(request => request.command)
  // No 'threads' round trip: the stopped event carries threadId, so the
  // entry-stop location refresh goes straight to stackTrace.
  assert.deepEqual(commands, ['initialize', 'launch', 'configurationDone', 'stackTrace'])
  await manager.disposeAll()
})

test('deferred start response (debugpy-style) resolves after configurationDone', async () => {
  // debugpy answers `launch` only once `configurationDone` has arrived
  // (launch → initialized → configurationDone → launch response). The
  // manager must not deadlock waiting for the start response first.
  const pendingLaunch = []
  const script = standardScript({
    launch: (server, request) => {
      pendingLaunch.push({ server, seq: request.seq })
      server.emit('initialized')
      if (request.arguments?.stopOnEntry !== false) {
        server.emit('stopped', { reason: 'entry', threadId: 1 })
      }
    },
    configurationDone: (server, request) => {
      server.respond(request.seq, 'configurationDone')
      for (const pending of pendingLaunch.splice(0)) {
        pending.server.respond(pending.seq, 'launch')
      }
    },
  })
  const { manager, fake } = buildManager(script)
  const owner = {}
  const snapshot = await manager.launch(owner, { program: '/w/app.py' })
  assert.equal(snapshot.status, 'stopped')
  assert.equal(snapshot.stopReason, 'entry')
  assert.deepEqual(
    fake.server.received.map(request => request.command),
    ['initialize', 'launch', 'configurationDone', 'stackTrace'],
  )
  // configurationDone must be sent before the start response is awaited:
  // the adapter would never have answered launch otherwise.
  const commands = fake.server.received.map(request => request.command)
  assert.ok(commands.indexOf('launch') < commands.indexOf('configurationDone'))
  await manager.disposeAll()
})

test('deferred start response with stopOnEntry=false reports running', async () => {
  const pendingLaunch = []
  const script = standardScript({
    launch: (server, request) => {
      pendingLaunch.push({ server, seq: request.seq })
      server.emit('initialized')
    },
    configurationDone: (server, request) => {
      server.respond(request.seq, 'configurationDone')
      for (const pending of pendingLaunch.splice(0)) {
        pending.server.respond(pending.seq, 'launch')
      }
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  const snapshot = await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  assert.equal(snapshot.status, 'running')
  await manager.disposeAll()
})

test('launch without stopOnEntry reports running', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  const snapshot = await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  assert.equal(snapshot.status, 'running')
  await manager.disposeAll()
})

test('continue resolves stopped at the next breakpoint location', async () => {
  const script = standardScript({
    continue: (server, request) => {
      server.respond(request.seq, 'continue', { allThreadsContinued: false })
      setTimeout(() => server.emit('stopped', { reason: 'breakpoint', threadId: 1 }), 10)
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const session = manager.sessionFor(owner)
  const outcome = await session.resume('continue')
  assert.equal(outcome.state, 'stopped')
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.snapshot.stopReason, 'breakpoint')
  assert.equal(outcome.snapshot.frame?.line, 42)
  await manager.disposeAll()
})

test('continue handles immediate synchronous stopped event without timing out', async () => {
  const script = standardScript({
    continue: (server, request) => {
      // Emit stopped immediately before responding to continue
      server.emit('stopped', { reason: 'breakpoint', threadId: 1 })
      server.respond(request.seq, 'continue', { allThreadsContinued: false })
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const session = manager.sessionFor(owner)
  const outcome = await session.resume('continue')
  assert.equal(outcome.state, 'stopped')
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.snapshot.stopReason, 'breakpoint')
  assert.equal(outcome.snapshot.frame?.line, 42)
  await manager.disposeAll()
})


test('continue past the wait deadline reports running without killing the session', async () => {
  // continue responds but never emits stopped: the step deadline governs.
  const script = standardScript({ continue: (server, request) => server.respond(request.seq, 'continue') })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const session = manager.sessionFor(owner)
  const outcome = await session.resume('continue')
  assert.equal(outcome.state, 'running')
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.snapshot.status, 'running')
  await manager.disposeAll()
})

test('terminated event ends the wait with exit code', async () => {
  const script = standardScript({
    continue: (server, request) => {
      server.respond(request.seq, 'continue')
      setTimeout(() => {
        server.emit('exited', { exitCode: 0 })
        server.emit('terminated')
      }, 10)
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const outcome = await manager.sessionFor(owner).resume('continue')
  assert.equal(outcome.state, 'terminated')
  assert.equal(outcome.snapshot.exitCode, 0)
  await manager.disposeAll()
})

test('resume right after an unnoticed exit names the exit instead of missing threads', async () => {
  // The debuggee finished while the tool call was in flight and the
  // `terminated` event has not folded yet: the adapter answers `threads`
  // with an empty list. The error must name the exit (and its code), not a
  // bare "no threads".
  const script = standardScript({
    launch: (server, request) => {
      server.respond(request.seq, 'launch')
      server.emit('initialized')
      setTimeout(() => {
        server.emit('exited', { exitCode: 7 })
        server.emit('terminated')
      }, 20)
    },
    threads: (server, request) => server.respond(request.seq, 'threads', { threads: [] }),
    continue: (server, request) => server.respond(request.seq, 'continue'),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  await assert.rejects(
    manager.sessionFor(owner).resume('continue'),
    error => {
      assert.ok(error instanceof DebugError)
      assert.equal(error.code, 'no_thread')
      assert.match(error.message, /already exited/)
      assert.match(error.message, /Exit code 7/)
      return true
    },
  )
  await manager.disposeAll()
})

test('resume after an exit surfaces the exit when the adapter fails threads outright', async () => {
  // netcoredbg-style: `threads` fails with an opaque adapter error while the
  // debuggee is exiting; the folded termination must win over that raw error.
  const script = standardScript({
    launch: (server, request) => {
      server.respond(request.seq, 'launch')
      server.emit('initialized')
      setTimeout(() => {
        server.emit('exited', { exitCode: 3 })
        server.emit('terminated')
      }, 20)
    },
    threads: (server, request) => server.fail(request.seq, 'threads', "Failed command 'threads' : 0x80004005"),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  await assert.rejects(
    manager.sessionFor(owner).resume('continue'),
    error => {
      assert.ok(error instanceof DebugError)
      assert.equal(error.code, 'no_thread')
      assert.match(error.message, /already exited/)
      assert.match(error.message, /Exit code 3/)
      return true
    },
  )
  await manager.disposeAll()
})

test('setBreakpoints maps adapter verification and line moves', async () => {
  const script = standardScript({
    setBreakpoints: (server, request) =>
      server.respond(request.seq, 'setBreakpoints', {
        breakpoints: [
          { verified: true, line: 43 },
          { verified: false, message: 'unresolved' },
        ],
      }),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py' })
  const records = await manager.sessionFor(owner).setBreakpoints('/w/src/app.py', [
    { line: 42 },
    { line: 100 },
  ])
  assert.deepEqual(records, [
    { line: 42, verified: true, message: undefined, actualLine: 43 },
    { line: 100, verified: false, message: 'unresolved', actualLine: undefined },
  ])
  await manager.disposeAll()
})

test('inspection actions map scopes, variables, and evaluation', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py' })
  const session = manager.sessionFor(owner)
  const scopes = await session.scopes(undefined)
  assert.equal(scopes[0].name, 'Locals')
  assert.equal(scopes[0].variablesReference, 100)
  const { variables, omitted } = await session.variables(100)
  assert.equal(variables.length, 2)
  assert.equal(variables[1].variablesReference, 101)
  assert.equal(omitted, 0)
  const evaluation = await session.evaluate('count * 2', undefined, undefined)
  assert.equal(evaluation.result, '6')
  await manager.disposeAll()
})

test('output events fill a bounded ring readable from the tail', async () => {
  const { manager, fake } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  for (let index = 0; index < 30; index += 1) {
    fake.server.emit('output', { category: 'stdout', output: `line-${index.toString().padStart(2, '0')}\n` })
  }
  const session = manager.sessionFor(owner)
  const page = session.readOutput({ maxChars: 120 })
  assert.ok(page.text.includes('line-29'), `tail should include the newest line: ${page.text}`)
  assert.ok(!page.text.includes('line-00'), 'head should have scrolled out')
  assert.equal(page.truncated, false)
  assert.ok(page.totalChars >= page.text.length)
  await manager.disposeAll()
})

test('ownership: foreign sessions are rejected, other owners unaffected', async () => {
  const { manager } = buildManager(standardScript())
  const ownerA = {}
  const ownerB = {}
  await manager.launch(ownerA, { program: '/w/app.py', stopOnEntry: false })
  assert.throws(() => manager.sessionFor(ownerB), DebugError)
  const activeA = manager.sessionFor(ownerA)
  assert.throws(() => manager.sessionFor(ownerB, activeA.id), /belongs to another agent/)
  assert.throws(() => manager.sessionFor({}), /No active debug session/)
  assert.equal(manager.list(ownerA).length, 1)
  assert.equal(manager.list(ownerB).length, 0)
  await manager.disposeAll()
})

test('second launch becomes the owner active session; explicit ids still address the first', async () => {
  const { manager } = buildManager(standardScript())
  const owner = {}
  const first = await manager.launch(owner, { program: '/w/a.py', stopOnEntry: false })
  const second = await manager.launch(owner, { program: '/w/b.py', stopOnEntry: false })
  assert.notEqual(first.id, second.id)
  assert.equal(manager.sessionFor(owner).id, second.id)
  assert.equal(manager.sessionFor(owner, first.id).id, first.id)
  await manager.disposeAll()
})

test('config launchArgs are merged into the DAP launch request', async () => {
  const fake = createFakeAdapter(standardScript())
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [], launchArgs: { justMyCode: true, request: 'attach' } }),
    limits: testLimits,
  })
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const launchMessage = fake.server.received.find(message => message.command === 'launch')
  // Config-declared per-adapter fields reach the adapter verbatim.
  assert.equal(launchMessage.arguments.justMyCode, true)
  assert.equal(launchMessage.arguments.request, 'attach')
  // Standard fixed fields remain unless the adapter config overrides them.
  assert.equal(launchMessage.arguments.type, 'launch')
  assert.equal(launchMessage.arguments.program, '/w/app.py')
  await manager.disposeAll()
})

test('stopOnEntryKey translates the entry-stop field (netcoredbg stopAtEntry)', async () => {
  const fake = createFakeAdapter(standardScript())
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [], stopOnEntryKey: 'stopAtEntry' }),
    limits: testLimits,
  })
  const owner = {}
  await manager.launch(owner, { program: '/w/app.dll', stopOnEntry: true })
  const launchMessage = fake.server.received.find(message => message.command === 'launch')
  assert.equal(launchMessage.arguments.stopAtEntry, true)
  assert.equal(launchMessage.arguments.stopOnEntry, undefined)
  await manager.disposeAll()
})

test('attach runs initialize → attach → configurationDone with pid and recipe overrides', async () => {
  const script = {
    ...standardScript(),
    attach: (server, request, args) => {
      server.respond(request.seq, 'attach')
      server.emit('initialized')
      if (args.stopOnEntry !== false) server.emit('stopped', { reason: 'entry', threadId: 1 })
    },
  }
  const fake = createFakeAdapter(script)
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [], launchArgs: { type: 'coreclr' }, stopOnEntryKey: 'stopAtEntry' }),
    limits: testLimits,
  })
  const owner = {}
  await manager.attach(owner, { processId: 4242, program: '/w/app.dll' })
  const commands = fake.server.received.map(request => request.command)
  assert.deepEqual(commands, ['initialize', 'attach', 'configurationDone'])
  const attachMessage = fake.server.received.find(message => message.command === 'attach')
  assert.equal(attachMessage.arguments.request, 'attach')
  assert.equal(attachMessage.arguments.processId, 4242)
  assert.equal(attachMessage.arguments.type, 'coreclr')
  assert.equal(attachMessage.arguments.stopAtEntry, false)
  await manager.disposeAll()
})

test('setVariable, setFunctionBreakpoints, setExceptionBreakpoints, exceptionInfo', async () => {
  const script = standardScript({
    setVariable: (server, request, args) =>
      server.respond(request.seq, 'setVariable', { value: `${args.value}!`, type: 'string', variablesReference: 0 }),
    setFunctionBreakpoints: (server, request, args) =>
      server.respond(request.seq, 'setFunctionBreakpoints', {
        breakpoints: (args.breakpoints ?? []).map(() => ({ verified: true })),
      }),
    setExceptionBreakpoints: (server, request) => server.respond(request.seq, 'setExceptionBreakpoints', {}),
    exceptionInfo: (server, request) =>
      server.respond(request.seq, 'exceptionInfo', {
        exceptionId: 'System.InvalidOperationException',
        description: 'boom',
        breakMode: 'always',
        details: { message: 'boom', typeName: 'System.InvalidOperationException' },
      }),
  })
  const { manager, fake } = buildManager(script)
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py' })
  const session = manager.sessionFor(owner)

  const setVar = await session.setVariable(100, 'count', '9')
  assert.equal(setVar.value, '9!')
  assert.equal(setVar.type, 'string')

  const fnBps = await session.setFunctionBreakpoints([{ name: 'doWork', condition: 'x>0' }, { name: 'main' }])
  assert.equal(fnBps.length, 2)
  assert.equal(fnBps[0].name, 'doWork')
  assert.equal(fnBps[0].verified, true)
  const fnMessage = fake.server.received.find(message => message.command === 'setFunctionBreakpoints')
  assert.equal(fnMessage.arguments.breakpoints[0].condition, 'x>0')

  await session.setExceptionBreakpoints(['all'], undefined)
  const excMessage = fake.server.received.find(message => message.command === 'setExceptionBreakpoints')
  assert.deepEqual(excMessage.arguments.filters, ['all'])

  const info = await session.exceptionInfo(1)
  assert.equal(info.exceptionId, 'System.InvalidOperationException')
  assert.equal(info.message, 'boom')
  await manager.disposeAll()
})

test('adapter death during launch surfaces the stderr tail', async () => {  const script = standardScript({ __stderrTail: 'ModuleNotFoundError: No module named debugpy' })
  const fake = createFakeAdapter(script)
  const manager = new DebugSessionManager({
    spawn: () => fake.spawned,
    resolveAdapter: () => ({ command: 'fake', args: [] }),
    limits: testLimits,
  })
  // Kill the adapter before launch so every send rejects as disconnected.
  fake.server.die()
  await assert.rejects(
    manager.launch({}, { program: '/w/app.py' }),
    /ModuleNotFoundError: No module named debugpy/,
  )
  assert.equal(manager.list({}).length, 0)
  await manager.disposeAll()
})

test('failed launch request rejects with the adapter message', async () => {
  const script = standardScript({
    launch: (server, request) => server.fail(request.seq, 'launch', 'file not found'),
  })
  const { manager } = buildManager(script)
  await assert.rejects(manager.launch({}, { program: '/w/missing.py' }), /file not found/)
  assert.equal(manager.list({}).length, 0)
  await manager.disposeAll()
})

test('disconnect asks the adapter and kills the process', async () => {
  const { manager, fake } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/app.py', stopOnEntry: false })
  const snapshot = await manager.disconnect(owner, undefined, true)
  assert.equal(snapshot.status, 'terminated')
  assert.ok(fake.killCount >= 1)
  assert.throws(() => manager.sessionFor(owner), /No active debug session/)
  const commands = fake.server.received.map(request => request.command)
  assert.equal(commands.at(-1), 'disconnect')
  await manager.disposeAll()
})

test('disposeAll tears down every live session', async () => {
  const { manager, fake } = buildManager(standardScript())
  const owner = {}
  await manager.launch(owner, { program: '/w/a.py', stopOnEntry: false })
  await manager.launch(owner, { program: '/w/b.py', stopOnEntry: false })
  await manager.disposeAll()
  assert.equal(manager.list(owner).length, 0)
  assert.ok(fake.killCount >= 2)
})
