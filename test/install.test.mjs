import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ADAPTER_BIN_MARKER,
  INSTALLABLE_ADAPTERS,
  installAdapter,
  managedBinDirs,
  addManagedBinDir,
  resetManagedBinDirs,
  scanManagedBinDirs,
  probeExecutable,
  netcoredbgAsset,
} from '../lib/install.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** runCommand stub keyed by the command name with per-test overrides. */
function stubRun(scripts) {
  const calls = []
  const run = async argv => {
    const [command, ...args] = argv
    calls.push(argv)
    const handler = scripts[command]
    if (handler === undefined) return { code: null, output: `spawn ${command} ENOENT` }
    return handler(args, argv)
  }
  return { run, calls }
}

test.afterEach(() => {
  resetManagedBinDirs()
})

test('scanManagedBinDirs discovers marker dirs at any nesting depth', () => {
  const root = tempDir('dsh-dap-scan-')
  try {
    mkdirSync(join(root, 'dlv'), { recursive: true })
    mkdirSync(join(root, 'netcoredbg', 'win64'), { recursive: true })
    writeFileSync(join(root, 'dlv', ADAPTER_BIN_MARKER), '')
    writeFileSync(join(root, 'netcoredbg', 'win64', ADAPTER_BIN_MARKER), '')
    mkdirSync(join(root, 'empty'), { recursive: true })
    const dirs = scanManagedBinDirs(root)
    assert.deepEqual([...dirs].sort(), [join(root, 'dlv'), join(root, 'netcoredbg', 'win64')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed dirs participate in executable probing', () => {
  const root = tempDir('dsh-dap-probe-')
  try {
    const exe = process.platform === 'win32' ? 'zz-dap-probe.exe' : 'zz-dap-probe'
    writeFileSync(join(root, exe), '')
    if (process.platform !== 'win32') chmodSync(join(root, exe), 0o755)
    writeFileSync(join(root, ADAPTER_BIN_MARKER), '')
    addManagedBinDir(root)
    assert.ok(probeExecutable('zz-dap-probe'), 'probe must find binaries in a managed dir')
    assert.ok(!probeExecutable('zz-dap-probe-missing'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installAdapter rejects unsupported ids and lists what it can install', async () => {
  await assert.rejects(installAdapter('gdb'), new RegExp(`Supported: ${INSTALLABLE_ADAPTERS.join(', ')}`))
})

test('debugpy: already installed short-circuits without running pip', async () => {
  const { run, calls } = stubRun({
    python: () => ({ code: 0, output: '' }),
  })
  const outcome = await installAdapter('debugpy', { deps: { runCommand: run } })
  assert.equal(outcome.alreadyInstalled, true)
  assert.equal(outcome.installed, false)
  assert.equal(outcome.command, 'python -m debugpy.adapter')
  assert.equal(calls.length, 1)
})

test('debugpy: pip install makes the import check pass', async () => {
  let importable = false
  const { run } = stubRun({
    python: args => {
      if (args.join(' ').includes('import debugpy')) return { code: importable ? 0 : 1, output: importable ? '' : 'ModuleNotFoundError' }
      if (args.includes('install')) {
        importable = true
        return { code: 0, output: 'Successfully installed debugpy' }
      }
      return { code: 1, output: 'unexpected' }
    },
  })
  const outcome = await installAdapter('debugpy', { deps: { runCommand: run } })
  assert.equal(outcome.installed, true)
  assert.equal(outcome.command, 'python -m debugpy.adapter')
  assert.match(outcome.output, /Successfully installed debugpy/)
})

test('debugpy: failed pip surfaces the output tail', async () => {
  const { run } = stubRun({
    python: args => {
      if (args.join(' ').includes('import debugpy')) return { code: 1, output: 'ModuleNotFoundError' }
      return { code: 1, output: 'externally-managed-environment' }
    },
  })
  await assert.rejects(installAdapter('debugpy', { deps: { runCommand: run } }), /pip install debugpy failed.*externally-managed-environment/s)
})

test('debugpy: no Python interpreter is a clear setup error', async () => {
  const { run } = stubRun({})
  await assert.rejects(installAdapter('debugpy', { deps: { runCommand: run } }), /No Python interpreter found.*python\.org/s)
})

test('dlv: go install result is copied into the managed dir with a marker', async () => {
  const gopath = tempDir('dsh-dap-gopath-')
  const managedRoot = tempDir('dsh-dap-managed-')
  try {
    const exe = process.platform === 'win32' ? 'dlv.exe' : 'dlv'
    mkdirSync(join(gopath, 'bin'), { recursive: true })
    writeFileSync(join(gopath, 'bin', exe), 'fake dlv binary')
    const { run, calls } = stubRun({
      go: args => {
        if (args[0] === 'version') return { code: 0, output: 'go version go1.22.0' }
        if (args[0] === 'install') return { code: 0, output: '' }
        if (args[0] === 'env' && args[1] === 'GOBIN') return { code: 0, output: '\n' }
        if (args[0] === 'env' && args[1] === 'GOPATH') return { code: 0, output: gopath }
        return { code: 1, output: 'unexpected go invocation' }
      },
    })
    const outcome = await installAdapter('dlv', {
      deps: { runCommand: run, probe: () => false },
      managedRoot,
    })
    assert.equal(outcome.installed, true)
    assert.equal(outcome.command, join(managedRoot, exe))
    assert.ok(existsSync(join(managedRoot, exe)))
    assert.ok(existsSync(join(managedRoot, ADAPTER_BIN_MARKER)), 'marker makes the dir discoverable after restart')
    assert.ok(managedBinDirs().includes(managedRoot), 'fresh install registers the dir for this process')
    const commands = calls.map(argv => argv[0])
    assert.deepEqual(commands, ['go', 'go', 'go', 'go'])
    rmSync(gopath, { recursive: true, force: true })
    rmSync(managedRoot, { recursive: true, force: true })
  } finally {
    try {
      rmSync(gopath, { recursive: true, force: true })
      rmSync(managedRoot, { recursive: true, force: true })
    } catch {
      // already removed
    }
  }
})

test('dlv: missing Go toolchain explains the prerequisite', async () => {
  const { run } = stubRun({})
  await assert.rejects(
    installAdapter('dlv', { deps: { runCommand: run, probe: () => false } }),
    /Go toolchain is required.*go\.dev/s,
  )
})

test('netcoredbg: release is downloaded, extracted, and the binary dir is marked', async () => {
  const managedRoot = tempDir('dsh-dap-managed-')
  try {
    const asset = netcoredbgAsset()
    const downloadUrl = `https://example.com/${asset}`
    const { run } = stubRun({})
    let downloadedTo
    const outcome = await installAdapter('netcoredbg', {
      deps: {
        runCommand: run,
        probe: () => false,
        fetchText: async url => {
          assert.equal(url, 'https://api.github.com/repos/Samsung/netcoredbg/releases/latest')
          return JSON.stringify({ assets: [{ name: asset, browser_download_url: downloadUrl }] })
        },
        download: async (url, destFile) => {
          assert.equal(url, downloadUrl)
          downloadedTo = destFile
          writeFileSync(destFile, 'fake archive')
        },
        extract: async (archive, destDir) => {
          assert.equal(archive, downloadedTo)
          assert.equal(destDir, join(managedRoot, 'netcoredbg'))
          const nested = join(destDir, 'win64')
          mkdirSync(nested, { recursive: true })
          writeFileSync(join(nested, process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg'), 'binary')
        },
      },
      managedRoot,
    })
    assert.equal(outcome.installed, true)
    const binDir = join(managedRoot, 'netcoredbg', 'win64')
    assert.equal(outcome.command, join(binDir, process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg'))
    assert.ok(existsSync(join(binDir, ADAPTER_BIN_MARKER)))
    assert.ok(managedBinDirs().includes(binDir))
    assert.match(outcome.output, /downloaded https:\/\/example\.com\//)
  } finally {
    rmSync(managedRoot, { recursive: true, force: true })
  }
})
