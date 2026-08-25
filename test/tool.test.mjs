import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDebugAction, DEBUG_ACTIONS, CONCURRENT_SAFE_ACTIONS, omitUndefined } from '../lib/tool.js'
import { DebugError, DebugSessionManager } from '../lib/session.js'
import { createFakeAdapter, standardScript, testLimits } from '../helpers/fake-adapter.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('launch without program is an argument error when no launch.json exists', async () => {
  const { manager } = buildManager(standardScript())
  await assert.rejects(runDebugAction({}, { action: 'launch' }, manager, testLimits), /requires 'program'/)
  await manager.disposeAll()
})

test('launch automatically reads .vscode/launch.json when program is omitted or launch_config is given', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-tool-ws-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    const launchJson = `
    {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "Default Test App",
          "type": "python",
          "request": "launch",
          "program": "\${workspaceFolder}/test_app.py",
          "args": ["--verbose"],
          "stopOnEntry": false
        },
        {
          "name": "Named Config",
          "type": "node",
          "request": "launch",
          "program": "\${workspaceFolder}/server.js"
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'launch.json'), launchJson, 'utf8')

    let launchedProgram = ''
    let launchedArgs = []
    const script = standardScript({
      launch: (server, request) => {
        launchedProgram = request.arguments.program
        launchedArgs = request.arguments.args
        server.respond(request.seq, 'launch')
        server.emit('initialized')
        if (request.arguments?.stopOnEntry !== false) {
          server.emit('stopped', { reason: 'entry', threadId: 1 })
        }
      },
    })
    const { manager } = buildManager(script)
    const owner = {}

    // 1. Zero-param launch (omitting program) picking default first config
    const res1 = await runDebugAction(owner, { action: 'launch', cwd: tmpDir }, manager, testLimits)
    assert.ok(res1.session_id)
    assert.equal(launchedProgram, join(tmpDir, 'test_app.py'))
    assert.deepEqual(launchedArgs, ['--verbose'])

    // 2. Launch with explicit launch_config name
    const res2 = await runDebugAction(owner, { action: 'launch', cwd: tmpDir, launch_config: 'Named Config' }, manager, testLimits)
    assert.ok(res2.session_id)
    assert.equal(launchedProgram, join(tmpDir, 'server.js'))

    await manager.disposeAll()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
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

test('concurrency whitelist covers only pure reads and nothing else', () => {
  // `stack_trace` and `evaluate` are deliberately absent: stack_trace records
  // the session's current frame, and DAP evaluation runs code inside the
  // debuggee (context "repl" allows arbitrary side effects) — both must
  // serialize against stepping and writes.
  const safe = ['threads', 'scopes', 'variables', 'output', 'sessions', 'ledger']
  for (const action of safe) {
    assert.ok(CONCURRENT_SAFE_ACTIONS.has(action), `${action} must be concurrency-safe`)
  }
  for (const action of DEBUG_ACTIONS) {
    if (!safe.includes(action)) {
      assert.ok(!CONCURRENT_SAFE_ACTIONS.has(action), `${action} must be serialized (not concurrency-safe)`)
    }
  }
  assert.equal(CONCURRENT_SAFE_ACTIONS.size, safe.length, 'whitelist must not contain stale or duplicate entries')
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

test('snapshot carries the adapter capabilities for model decisions', async () => {
  const script = standardScript({
    initialize: (server, request) =>
      server.respond(request.seq, 'initialize', {
        capabilities: {
          supportsConfigurationDoneRequest: true,
          supportsSetVariable: true,
          supportsDataBreakpoints: true,
          supportsGotoTargetsRequest: true,
          supportsLoadedSourcesRequest: true,
        },
      }),
  })
  const { manager } = buildManager(script)
  const owner = {}
  const launch = await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  const caps = launch.snapshot.capabilities
  assert.equal(caps.set_variable, true)
  assert.equal(caps.data_breakpoints, true)
  assert.equal(caps.goto_targets, true)
  assert.equal(caps.loaded_sources, true)
  // Absent capabilities are false/undefined, not misreported as true.
  assert.equal(caps.restart, undefined)
  assert.equal(caps.terminate, undefined)
  await manager.disposeAll()
})

test('source action reads in-memory sources by source_reference', async () => {
  // A frame whose source has a sourceReference but no path: source must send
  // the reference instead of hardcoding 0.
  const script = standardScript({
    stackTrace: (server, request) =>
      server.respond(request.seq, 'stackTrace', {
        stackFrames: [
          {
            id: 10,
            name: 'replEval',
            source: { name: '<eval>', sourceReference: 77 },
            line: 1,
            column: 1,
          },
        ],
      }),
    source: (server, request, args) => {
      server.respond(request.seq, 'source', { content: `// eval source ${args.sourceReference}`, mimeType: 'text/javascript' })
    },
  })
  const { manager, fake } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.js' }, manager, testLimits)
  // stack_trace records the current frame with the reference.
  await runDebugAction(owner, { action: 'stack_trace' }, manager, testLimits)
  // source without explicit reference falls back to the frame's reference.
  const auto = await runDebugAction(owner, { action: 'source' }, manager, testLimits)
  assert.equal(auto.content, '// eval source 77')
  const sent = fake.server.received.find(message => message.command === 'source')
  assert.equal(sent.arguments.sourceReference, 77)
  // Explicit reference overrides the frame.
  const explicit = await runDebugAction(owner, { action: 'source', source_reference: 99 }, manager, testLimits)
  assert.equal(explicit.content, '// eval source 99')
  await manager.disposeAll()
})

test('variables and modules support start/count paging', async () => {
  const allVariables = [
    { name: 'v0', value: '0', variablesReference: 0 },
    { name: 'v1', value: '1', variablesReference: 0 },
    { name: 'v2', value: '2', variablesReference: 0 },
  ]
  const script = standardScript({
    initialize: (server, request) =>
      server.respond(request.seq, 'initialize', {
        capabilities: { supportsConfigurationDoneRequest: true, supportsModulesRequest: true },
      }),
    variables: (server, request, args) => {
      // Like a real adapter, honor start/count on the response side.
      const start = args.start ?? 0
      const count = args.count ?? allVariables.length
      server.respond(request.seq, 'variables', { variables: allVariables.slice(start, start + count) })
    },
    modules: (server, request) =>
      server.respond(request.seq, 'modules', {
        modules: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      }),
  })
  const { manager, fake } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  // variables with count pages the request and slices the result.
  const variables = await runDebugAction(
    owner,
    { action: 'variables', variables_ref: 100, start: 1, count: 2 },
    manager,
    testLimits,
  )
  assert.deepEqual(variables.variables.map(v => v.name), ['v1', 'v2'])
  const variablesMessage = fake.server.received.find(message => message.command === 'variables')
  assert.equal(variablesMessage.arguments.start, 1)
  assert.equal(variablesMessage.arguments.count, 2)
  // modules paging passes startModule/moduleCount.
  const modules = await runDebugAction(owner, { action: 'modules', start: 1, count: 5 }, manager, testLimits)
  assert.equal(modules.modules.length, 2)
  const modulesMessage = fake.server.received.find(message => message.command === 'modules')
  assert.equal(modulesMessage.arguments.startModule, 1)
  assert.equal(modulesMessage.arguments.moduleCount, 5)
  await manager.disposeAll()
})

test('oversized variable and evaluation values are truncated in the data layer', async () => {
  const huge = 'x'.repeat(5000)
  const script = standardScript({
    variables: (server, request) =>
      server.respond(request.seq, 'variables', {
        variables: [{ name: 'big', value: huge, variablesReference: 0 }],
      }),
    evaluate: (server, request) => server.respond(request.seq, 'evaluate', { result: huge, variablesReference: 0 }),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  const variables = await runDebugAction(owner, { action: 'variables', variables_ref: 100 }, manager, testLimits)
  assert.ok(variables.variables[0].value.length < huge.length)
  assert.match(variables.variables[0].value, /5000 chars/)
  const evaluation = await runDebugAction(owner, { action: 'evaluate', expression: 'big' }, manager, testLimits)
  assert.ok(evaluation.evaluation.result.length < huge.length)
  assert.match(evaluation.evaluation.result, /5000 chars/)
  await manager.disposeAll()
})

test('select_thread switches the focus thread', async () => {
  const script = standardScript({
    threads: (server, request) =>
      server.respond(request.seq, 'threads', { threads: [{ id: 1, name: 'main' }, { id: 2, name: 'worker' }] }),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)
  // select_thread requires thread_id and switches the active thread.
  await assert.rejects(runDebugAction(owner, { action: 'select_thread' }, manager, testLimits), /requires 'thread_id'/)
  const selected = await runDebugAction(owner, { action: 'select_thread', thread_id: 2 }, manager, testLimits)
  assert.equal(selected.snapshot.threadId, 2)
  // Unknown threads are rejected.
  await assert.rejects(
    runDebugAction(owner, { action: 'select_thread', thread_id: 99 }, manager, testLimits),
    /Thread 99 does not exist/,
  )
  await manager.disposeAll()
})

test('allThreadsStopped is surfaced in the snapshot', async () => {
  const script = standardScript({
    continue: (server, request) => {
      server.respond(request.seq, 'continue', { allThreadsContinued: false })
      setTimeout(() => server.emit('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true }), 5)
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py', stop_on_entry: false }, manager, testLimits)
  const stepped = await runDebugAction(owner, { action: 'continue' }, manager, testLimits)
  assert.equal(stepped.snapshot.allThreadsStopped, true)
  await manager.disposeAll()
})

test('resume results carry incremental output since the last read', async () => {
  const script = standardScript({
    continue: (server, request) => {
      server.respond(request.seq, 'continue')
      server.emit('output', { category: 'stdout', output: 'hello from debuggee\n' })
      setTimeout(() => server.emit('stopped', { reason: 'breakpoint', threadId: 1 }), 5)
    },
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py', stop_on_entry: false }, manager, testLimits)
  // First resume: the output emitted during the run is attached.
  const first = await runDebugAction(owner, { action: 'continue' }, manager, testLimits)
  assert.equal(first.output.text, 'hello from debuggee\n')
  // Second resume without new output: nothing attached.
  const script2 = standardScript({ continue: (server, request) => server.respond(request.seq, 'continue') })
  const manager2 = buildManager(script2).manager
  const owner2 = {}
  await runDebugAction(owner2, { action: 'launch', program: '/w/app.py', stop_on_entry: false }, manager2, testLimits)
  const second = await runDebugAction(owner2, { action: 'continue' }, manager2, testLimits)
  assert.equal(second.output, undefined)
  await manager.disposeAll()
  await manager2.disposeAll()
})

test('execute normalizes transport errors into stable DebugError codes', async () => {
  // Drive through createDebugTool.execute so the normalizeError wrapper runs.
  const { createDebugTool } = await import('../lib/tool.js')
  const { manager } = buildManager(standardScript())
  const exec = { agent: {} }
  // Adapter request failure surfaces as adapter_error.
  const failScript = standardScript({ continue: (server, request) => server.fail(request.seq, 'continue', 'boom') })
  const failManager = buildManager(failScript).manager
  const failTool = createDebugTool(failManager, testLimits)
  await failTool.execute({ action: 'launch', program: '/w/app.py', stop_on_entry: false }, exec)
  try {
    await failTool.execute({ action: 'continue' }, exec)
    assert.fail('expected adapter_error')
  } catch (error) {
    assert.ok(error instanceof DebugError)
    assert.equal(error.code, 'adapter_error')
    assert.match(error.message, /boom/)
  }
  await failManager.disposeAll()
  await manager.disposeAll()
})

test('runDebugAction drives reverse_continue, terminate, and extended inspection actions', async () => {
  const script = standardScript({
    initialize: (server, request) =>
      server.respond(request.seq, 'initialize', {
        capabilities: {
          supportsConfigurationDoneRequest: true,
          supportsStepBack: true,
          supportsDataBreakpoints: true,
          supportsDisassembleRequest: true,
          supportsReadMemoryRequest: true,
          supportsCompletionsRequest: true,
          supportsTerminateRequest: true,
        },
      }),
    reverseContinue: (server, request) => {
      server.respond(request.seq, 'reverseContinue')
      server.emit('stopped', { reason: 'step', threadId: 1 })
    },
    dataBreakpointInfo: (server, request) =>
      server.respond(request.seq, 'dataBreakpointInfo', {
        dataId: 'd_ptr',
        description: 'data pointer',
        accessTypes: ['write'],
        canPersist: true,
      }),
    setDataBreakpoints: (server, request) =>
      server.respond(request.seq, 'setDataBreakpoints', {
        breakpoints: [{ id: 1, verified: true }],
      }),
    disassemble: (server, request) =>
      server.respond(request.seq, 'disassemble', {
        instructions: [{ address: '0x10', instruction: 'nop' }],
      }),
    readMemory: (server, request) =>
      server.respond(request.seq, 'readMemory', {
        address: '0x10',
        data: 'AAAA',
      }),
    completions: (server, request) =>
      server.respond(request.seq, 'completions', {
        targets: [{ label: 'testComplete', type: 'method' }],
      }),
    variables: (server, request) => {
      assert.equal(request.arguments?.filter, 'named')
      assert.equal(request.arguments?.format?.hex, true)
      return server.respond(request.seq, 'variables', {
        variables: [{ name: 'hexVal', value: '0x2a', variablesReference: 0 }],
      })
    },
    evaluate: (server, request) => {
      assert.equal(request.arguments?.format?.hex, true)
      return server.respond(request.seq, 'evaluate', {
        result: '0x2a',
        variablesReference: 0,
      })
    },
    terminate: (server, request) => server.respond(request.seq, 'terminate'),
  })
  const { manager } = buildManager(script)
  const owner = {}
  await runDebugAction(owner, { action: 'launch', program: '/w/app.py' }, manager, testLimits)

  const rev = await runDebugAction(owner, { action: 'reverse_continue', single_thread: true }, manager, testLimits)
  assert.equal(rev.action, 'reverse_continue')
  assert.equal(rev.state, 'stopped')

  const dataInfo = await runDebugAction(owner, { action: 'data_breakpoint_info', name: 'ptr' }, manager, testLimits)
  assert.equal(dataInfo.data_breakpoint_info.data_id, 'd_ptr')

  const dataBp = await runDebugAction(owner, { action: 'set_data_breakpoints', data_id: 'd_ptr', access_type: 'write' }, manager, testLimits)
  assert.equal(dataBp.breakpoints.length, 1)

  const disasm = await runDebugAction(owner, { action: 'disassemble', memory_reference: '0x10' }, manager, testLimits)
  assert.equal(disasm.instructions.length, 1)
  assert.equal(disasm.instructions[0].instruction, 'nop')

  const mem = await runDebugAction(owner, { action: 'read_memory', memory_reference: '0x10' }, manager, testLimits)
  assert.equal(mem.memory.data, 'AAAA')

  const comp = await runDebugAction(owner, { action: 'completions', text: 'test' }, manager, testLimits)
  assert.equal(comp.completions[0].label, 'testComplete')

  const vars = await runDebugAction(owner, { action: 'variables', variables_ref: 100, filter: 'named', hex: true }, manager, testLimits)
  assert.equal(vars.variables[0].value, '0x2a')

  const evalRes = await runDebugAction(owner, { action: 'evaluate', expression: '42', hex: true }, manager, testLimits)
  assert.equal(evalRes.evaluation.result, '0x2a')

  const term = await runDebugAction(owner, { action: 'terminate' }, manager, testLimits)
  assert.equal(term.snapshot.status, 'terminated')

  await manager.disposeAll()
})

test('launch action executes preLaunchTask from .vscode/tasks.json before starting DAP session', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-tool-prelaunch-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })

    const tasksJson = `
    {
      "version": "2.0.0",
      "tasks": [
        {
          "label": "build-step",
          "type": "shell",
          "command": "node -e \\"console.log('prelaunch task ran')\\""
        },
        {
          "label": "failing-build",
          "type": "shell",
          "command": "node -e \\"console.error('build failed'); process.exit(1)\\""
        }
      ]
    }
    `
    const launchJson = `
    {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "App With Build",
          "type": "node",
          "request": "launch",
          "program": "\${workspaceFolder}/app.js",
          "preLaunchTask": "build-step"
        },
        {
          "name": "App With Failing Build",
          "type": "node",
          "request": "launch",
          "program": "\${workspaceFolder}/app.js",
          "preLaunchTask": "failing-build"
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'tasks.json'), tasksJson, 'utf8')
    writeFileSync(join(vscodeDir, 'launch.json'), launchJson, 'utf8')

    const { manager } = buildManager(standardScript())
    const owner = {}

    // Successful preLaunchTask run
    const successRes = await runDebugAction(
      owner,
      { action: 'launch', cwd: tmpDir, launch_config: 'App With Build' },
      manager,
      testLimits,
    )
    assert.equal(successRes.action, 'launch')
    assert.ok(successRes.snapshot.id)

    await manager.disposeAll()

    // Failing preLaunchTask run
    await assert.rejects(
      () =>
        runDebugAction(
          owner,
          { action: 'launch', cwd: tmpDir, launch_config: 'App With Failing Build' },
          manager,
          testLimits,
        ),
      /build failed/,
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

