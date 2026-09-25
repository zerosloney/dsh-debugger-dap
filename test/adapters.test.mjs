import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveAdapter,
  defaultCommandExists,
  expandPath,
  stripJsonComments,
  resolveVsCodeVariables,
  mapVsCodeTypeToAdapter,
  resolveLaunchConfig,
  readTasksConfigurations,
  resolveTaskCommand,
  runPreLaunchTask,
} from '../lib/adapters.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pythonPresent = command => command === 'python'
const nothing = () => false

test('program extension guesses the adapter', () => {
  const spec = resolveAdapter({ program: '/w/app.py' }, undefined, pythonPresent)
  assert.equal(spec.command, 'python')
  assert.deepEqual(spec.args, ['-m', 'debugpy.adapter'])
})

test('explicit adapter id wins over the extension guess', () => {
  const spec = resolveAdapter({ adapter: 'dlv', program: '/w/app.py' }, undefined, () => true)
  assert.equal(spec.command, 'dlv')
  assert.deepEqual(spec.args, ['dap'])
})

test('unknown extension without an adapter id lists what is available', () => {
  assert.throws(
    () => resolveAdapter({ program: '/w/app.bin' }, undefined, pythonPresent),
    /Pass 'adapter' explicitly \(available: debugpy\)/,
  )
})

test('missing adapter on PATH surfaces the install hint', () => {
  assert.throws(
    () => resolveAdapter({ program: '/w/app.py' }, undefined, nothing),
    /pip install debugpy/,
  )
  assert.throws(() => resolveAdapter({ adapter: 'dlv', program: '/w/x' }, undefined, nothing), /go install/)
})

test('unknown adapter id points at the config', () => {
  assert.throws(() => resolveAdapter({ adapter: 'gdb', program: '/w/x' }, undefined, pythonPresent), /Unknown adapter 'gdb'/)
})

test('config rows add adapters and override built-ins', () => {
  const config = {
    'js-debug': { command: 'node', args: ['/opt/js-debug/src/dapDebugServer.js'] },
    debugpy: { command: '/venv/bin/python', args: ['-m', 'debugpy.adapter'] },
  }
  const custom = resolveAdapter({ adapter: 'js-debug', program: '/w/x' }, config, () => false)
  assert.equal(custom.command, 'node')
  assert.deepEqual(custom.args, ['/opt/js-debug/src/dapDebugServer.js'])

  const overridden = resolveAdapter({ adapter: 'debugpy', program: '/w/a.py' }, config, () => false)
  assert.equal(overridden.command, '/venv/bin/python')
})

test('config launchArgs are carried into the resolved spec', () => {
  const config = {
    'js-debug': { command: 'node', args: ['x.js'], launchArgs: { justMyCode: true, request: 'attach' } },
  }
  const spec = resolveAdapter({ adapter: 'js-debug', program: '/w/x' }, config, () => false)
  assert.deepEqual(spec.launchArgs, { justMyCode: true, request: 'attach' })
})

test('built-in netcoredbg recipe carries coreclr launch args and stopAtEntry', () => {
  const spec = resolveAdapter({ adapter: 'netcoredbg', program: '/w/app.dll' }, undefined, () => true)
  assert.equal(spec.command, 'netcoredbg')
  assert.deepEqual(spec.args, ['--interpreter=vscode'])
  assert.deepEqual(spec.launchArgs, { type: 'coreclr' })
  assert.equal(spec.stopOnEntryKey, 'stopAtEntry')
})

test('.dll and .exe extensions guess netcoredbg', () => {
  assert.equal(resolveAdapter({ program: '/w/App.dll' }, undefined, () => true).command, 'netcoredbg')
  assert.equal(resolveAdapter({ program: '/w/App.exe' }, undefined, () => true).command, 'netcoredbg')
})

test('missing netcoredbg surfaces the install hint', () => {
  assert.throws(
    () => resolveAdapter({ adapter: 'netcoredbg', program: '/w/x' }, undefined, nothing),
    /Samsung\/netcoredbg/,
  )
})

test('an explicit netcoredbg config override inherits the recipe stopAtEntry key', () => {
  const config = { netcoredbg: { command: 'D:/tools/netcoredbg' } }
  const spec = resolveAdapter({ adapter: 'netcoredbg', program: '/w/app.dll' }, config, () => false)
  assert.equal(spec.command, 'D:/tools/netcoredbg')
  assert.equal(spec.stopOnEntryKey, 'stopAtEntry')
  assert.deepEqual(spec.launchArgs, { type: 'coreclr' })
  assert.deepEqual(spec.args, [])
})

test('js-debug without a config fails fast with setup guidance instead of spawning bare node', () => {
  // js-debug ships as a TCP DAP server script, not a PATH command: there is
  // no auto-resolvable recipe. Resolution must reject immediately with the
  // exact adapters-config shape, never resolve to a bare `node` REPL.
  assert.throws(
    () => resolveAdapter({ program: '/w/server.js' }, undefined, pythonPresent),
    /dapDebugServer\.js[\s\S]*transport: 'tcp'/,
  )
  assert.throws(
    () => resolveAdapter({ adapter: 'js-debug', program: '/w/x' }, undefined, nothing),
    /no built-in command/,
  )
  // A declared config row still resolves after the built-in removal.
  const config = { 'js-debug': { command: 'node', args: ['/opt/js-debug/src/dapDebugServer.js'], transport: 'tcp' } }
  const spec = resolveAdapter({ program: '/w/server.js' }, config, () => false)
  assert.equal(spec.command, 'node')
  assert.equal(spec.transport, 'tcp')
})

test('built-in codelldb recipe passes only --port (no dap positional)', () => {
  // Upstream's clap Cli defines long options only (--port/--connect/...):
  // no subcommand and no positional argument exist, so an extra 'dap' made
  // the binary exit with a usage error before listening. .rs programs guess
  // into this recipe, so both explicit and guessed paths are pinned here.
  const explicit = resolveAdapter({ adapter: 'codelldb', program: '/w/x' }, undefined, () => true)
  assert.equal(explicit.command, 'codelldb')
  assert.deepEqual(explicit.args, ['--port', '0'])
  assert.equal(explicit.transport, 'tcp')
  const guessed = resolveAdapter({ program: '/w/main.rs' }, undefined, () => true)
  assert.deepEqual(guessed.args, ['--port', '0'])
})

test('config rows carry announceStream into the resolved spec', () => {
  const config = {
    'custom-ws': {
      command: 'node',
      args: ['/opt/adapter/server.js'],
      transport: 'tcp',
      announceStream: 'stderr',
    },
  }
  const spec = resolveAdapter({ adapter: 'custom-ws', program: '/w/x' }, config, () => false)
  assert.equal(spec.transport, 'tcp')
  assert.equal(spec.announceStream, 'stderr')
})

test('expandPath expands ~ and environment variables', () => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  assert.equal(expandPath('~'), home)
  assert.equal(expandPath('~/foo/bar'), `${home}/foo/bar`.replace(/\//g, process.platform === 'win32' ? '\\' : '/'))

  process.env.TEST_DAP_VAR = 'hello_world'
  assert.equal(expandPath('%TEST_DAP_VAR%/sub'), 'hello_world/sub')
  assert.equal(expandPath('${TEST_DAP_VAR}/sub'), 'hello_world/sub')
})

test('config rows expand ~ and env variables in command, args, and cwd', () => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const config = {
    'custom-js': {
      command: 'node',
      args: ['~/.vscode/extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js'],
      cwd: '~/my-project',
      transport: 'tcp',
    },
  }
  const spec = resolveAdapter({ adapter: 'custom-js', program: '/w/x' }, config, () => false)
  assert.ok(spec.args[0].startsWith(home))
  assert.ok(spec.cwd?.startsWith(home))
})

test('resolveAdapter auto-discovers js-debug when extension is found', () => {
  const fakeFind = (prefix) => {
    if (prefix === 'ms-vscode.js-debug') return '/Users/user/.vscode/extensions/ms-vscode.js-debug-1.98.0/dist/src/dapDebugServer.js'
    return undefined
  }
  const spec = resolveAdapter({ program: '/w/server.js' }, undefined, (cmd) => cmd === 'node', fakeFind)
  assert.equal(spec.command, 'node')
  assert.deepEqual(spec.args, ['/Users/user/.vscode/extensions/ms-vscode.js-debug-1.98.0/dist/src/dapDebugServer.js'])
  assert.equal(spec.transport, 'tcp')
  assert.deepEqual(spec.launchArgs, { type: 'node', sourceMaps: true })
})

test('resolveAdapter auto-discovers codelldb when codelldb is not on PATH', () => {
  const fakeFind = (prefix) => {
    if (prefix === 'vadimcn.vscode-lldb') return '/Users/user/.vscode/extensions/vadimcn.vscode-lldb-1.10.0/adapter/codelldb'
    return undefined
  }
  const spec = resolveAdapter({ program: '/w/main.rs' }, undefined, () => false, fakeFind)
  assert.equal(spec.command, '/Users/user/.vscode/extensions/vadimcn.vscode-lldb-1.10.0/adapter/codelldb')
  assert.deepEqual(spec.args, ['--port', '0'])
  assert.equal(spec.transport, 'tcp')
})

test('stripJsonComments strips comments and trailing commas', () => {
  const jsonc = `
  {
    // Single line comment
    "version": "0.2.0", /* block comment */
    "configurations": [
      {
        "name": "App",
        "type": "python",
        "program": "main.py", // comment after value
      },
    ],
  }
  `
  const cleaned = stripJsonComments(jsonc)
  const parsed = JSON.parse(cleaned)
  assert.equal(parsed.version, '0.2.0')
  assert.equal(parsed.configurations.length, 1)
  assert.equal(parsed.configurations[0].name, 'App')
})

test('resolveVsCodeVariables expands workspaceFolder and env variables', () => {
  process.env.TEST_PORT = '9000'
  const config = {
    program: '${workspaceFolder}/src/app.py',
    args: ['--port', '${env:TEST_PORT}'],
    cwd: '${workspaceFolder}',
    file: '${fileBasename}',
  }
  const resolved = resolveVsCodeVariables(config, '/home/user/myproject', '/home/user/myproject/src/index.ts')
  assert.equal(resolved.program, join('/home/user/myproject', 'src', 'app.py'))
  assert.deepEqual(resolved.args, ['--port', '9000'])
  assert.equal(resolved.cwd, join('/home/user/myproject'))
  assert.equal(resolved.file, 'index.ts')
})

test('mapVsCodeTypeToAdapter maps VS Code types to DAP adapter IDs', () => {
  assert.equal(mapVsCodeTypeToAdapter('python'), 'debugpy')
  assert.equal(mapVsCodeTypeToAdapter('pwa-node'), 'js-debug')
  assert.equal(mapVsCodeTypeToAdapter('node'), 'js-debug')
  assert.equal(mapVsCodeTypeToAdapter('lldb'), 'codelldb')
  assert.equal(mapVsCodeTypeToAdapter('coreclr'), 'netcoredbg')
  assert.equal(mapVsCodeTypeToAdapter('go'), 'dlv')
  assert.equal(mapVsCodeTypeToAdapter('custom-adapter'), 'custom-adapter')
})

test('resolveLaunchConfig parses .vscode/launch.json and matches by name or default', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-test-ws-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    const launchJson = `
    {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "Python: Main",
          "type": "python",
          "request": "launch",
          "program": "\${workspaceFolder}/app.py",
          "args": ["--mode", "debug"],
          "stopOnEntry": true,
          "justMyCode": false
        },
        {
          "name": "Node: Server",
          "type": "pwa-node",
          "request": "launch",
          "program": "\${workspaceFolder}/dist/server.js"
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'launch.json'), launchJson, 'utf8')

    // Default (first config)
    const def = resolveLaunchConfig({ workspaceDir: tmpDir })
    assert.ok(def)
    assert.equal(def.name, 'Python: Main')
    assert.equal(def.adapter, 'debugpy')
    assert.equal(def.program, join(tmpDir, 'app.py'))
    assert.deepEqual(def.args, ['--mode', 'debug'])
    assert.equal(def.stopOnEntry, true)
    assert.deepEqual(def.extraLaunchArgs, { justMyCode: false })

    // Match by name
    const node = resolveLaunchConfig({ workspaceDir: tmpDir, launchConfigName: 'Node: Server' })
    assert.ok(node)
    assert.equal(node.name, 'Node: Server')
    assert.equal(node.adapter, 'js-debug')
    assert.equal(node.program, join(tmpDir, 'dist', 'server.js'))

    // Non-existent name returns undefined
    const none = resolveLaunchConfig({ workspaceDir: tmpDir, launchConfigName: 'NonExistent' })
    assert.equal(none, undefined)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('readTasksConfigurations and resolveTaskCommand parse tasks.json', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-test-tasks-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    const tasksJson = `
    {
      "version": "2.0.0",
      "tasks": [
        {
          "label": "build",
          "type": "shell",
          "command": "node -e \\"console.log('building...')\\"",
          "options": {
            "cwd": "\${workspaceFolder}"
          }
        },
        {
          "label": "npm-build",
          "type": "npm",
          "script": "compile"
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'tasks.json'), tasksJson, 'utf8')

    const tasks = readTasksConfigurations(tmpDir)
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].label, 'build')

    const resolvedBuild = resolveTaskCommand('build', tmpDir)
    assert.ok(resolvedBuild)
    assert.ok(resolvedBuild.command.includes('building...'))
    assert.equal(resolvedBuild.cwd, tmpDir)

    const resolvedNpm = resolveTaskCommand('npm-build', tmpDir)
    assert.ok(resolvedNpm)
    assert.equal(resolvedNpm.command, 'npm')
    assert.deepEqual(resolvedNpm.args, ['run', 'compile'])

    const notFound = resolveTaskCommand('non-existent', tmpDir)
    assert.equal(notFound, undefined)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('runPreLaunchTask executes task command successfully and handles errors', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-test-task-exec-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    const tasksJson = `
    {
      "version": "2.0.0",
      "tasks": [
        {
          "label": "success-task",
          "type": "shell",
          "command": "node -e \\"console.log('compile-success')\\""
        },
        {
          "label": "fail-task",
          "type": "shell",
          "command": "node -e \\"console.error('syntax error in src'); process.exit(1)\\""
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'tasks.json'), tasksJson, 'utf8')

    const res = await runPreLaunchTask('success-task', tmpDir)
    assert.equal(res.success, true)
    assert.ok(res.output.includes('compile-success'))

    await assert.rejects(
      () => runPreLaunchTask('fail-task', tmpDir),
      /syntax error in src/,
    )

    await assert.rejects(
      () => runPreLaunchTask('unknown-task', tmpDir),
      /was not found in \.vscode\/tasks\.json/,
    )
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('resolveLaunchConfig extracts preLaunchTask and integrates with launch.json', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dap-test-prelaunch-'))
  try {
    const vscodeDir = join(tmpDir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    const launchJson = `
    {
      "version": "0.2.0",
      "configurations": [
        {
          "name": "Rust: Run",
          "type": "lldb",
          "request": "launch",
          "program": "\${workspaceFolder}/target/debug/app",
          "preLaunchTask": "cargo-build"
        }
      ]
    }
    `
    writeFileSync(join(vscodeDir, 'launch.json'), launchJson, 'utf8')

    const resolved = resolveLaunchConfig({ workspaceDir: tmpDir })
    assert.ok(resolved)
    assert.equal(resolved.name, 'Rust: Run')
    assert.equal(resolved.preLaunchTask, 'cargo-build')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})


test('js-debug auto-discovery spec carries a pattern matching dapDebugServer announcements', () => {
  const spec = resolveAdapter(
    { adapter: 'js-debug', program: '/w/x' },
    undefined,
    () => true,
    (_prefix, candidates) => `/fake/ext/${candidates[0]}`,
  )
  assert.equal(spec.command, 'node')
  assert.equal(spec.transport, 'tcp')
  assert.ok(spec.portPattern !== undefined, 'js-debug discovery needs an explicit portPattern')
  const pattern = new RegExp(spec.portPattern)
  // dapDebugServer binds an IPv6 loopback by default and prints the host;
  // the port is the last capture group, the host the one before it.
  const v6 = pattern.exec('Debug server listening at ::1:8123')
  assert.equal(v6?.[2], '8123')
  assert.equal(v6?.[1], '::1')
  const v4 = pattern.exec('Debug server listening at: 127.0.0.1:9229')
  assert.equal(v4?.[2], '9229')
  assert.equal(v4?.[1], '127.0.0.1')
})

test('a config-declared adapter can override the stop-on-entry launch field', () => {
  const custom = resolveAdapter(
    { adapter: 'mydbg', program: '/w/x' },
    { mydbg: { command: 'mydbg', stopOnEntryKey: 'stopAtEntry' } },
    () => false,
  )
  assert.equal(custom.stopOnEntryKey, 'stopAtEntry')
})

test('defaultCommandExists probes the managed adapter dirs', async () => {
  const { addManagedBinDir, resetManagedBinDirs } = await import('../lib/install.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-managedprobe-'))
  try {
    const exe = process.platform === 'win32' ? 'zz-managed-cmd.exe' : 'zz-managed-cmd'
    writeFileSync(join(dir, exe), '')
    addManagedBinDir(dir)
    assert.equal(defaultCommandExists('zz-managed-cmd'), true)
    assert.equal(defaultCommandExists('zz-managed-cmd-absent'), false)
  } finally {
    resetManagedBinDirs()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createAutoInstallingResolver installs once and re-resolves', async () => {
  const { createAutoInstallingResolver } = await import('../lib/adapters.js')
  // python appears on PATH only after the (stubbed) install ran.
  let pythonAvailable = false
  const installDeps = {
    runCommand: async () => {
      pythonAvailable = true
      return { code: 0, output: '' }
    },
  }
  const resolver = createAutoInstallingResolver(undefined, {
    autoInstall: true,
    installDeps,
    commandExists: () => pythonAvailable,
  })
  const spec = await resolver({ program: '/w/app.py' })
  assert.equal(spec.command, 'python')
  assert.deepEqual(spec.args, ['-m', 'debugpy.adapter'])
})

test('createAutoInstallingResolver honors the off switch', async () => {
  const { createAutoInstallingResolver, AdapterUnavailableError } = await import('../lib/adapters.js')
  let installRan = false
  const resolver = createAutoInstallingResolver(undefined, {
    autoInstall: false,
    installDeps: {
      runCommand: async () => {
        installRan = true
        return { code: 0, output: '' }
      },
    },
    commandExists: () => false,
  })
  await assert.rejects(resolver({ program: '/w/app.py' }), AdapterUnavailableError)
  assert.equal(installRan, false)
})

test('createAutoInstallingResolver folds install failures into the hint', async () => {
  const { createAutoInstallingResolver } = await import('../lib/adapters.js')
  const resolver = createAutoInstallingResolver(undefined, {
    autoInstall: true,
    installDeps: {
      runCommand: async () => ({ code: 1, output: 'pip exploded' }),
    },
    commandExists: () => false,
  })
  await assert.rejects(
    resolver({ program: '/w/app.py' }),
    error => /pip install debugpy failed/.test(error.message) && /Auto-install of 'debugpy' failed/.test(error.message),
  )
})
