/**
 * On-demand adapter installation. The `install_adapter` action and the
 * `autoInstallAdapters` config both funnel into {@link installAdapter}:
 *
 *  - debugpy    `python -m pip install debugpy` (fully automatic; retries
 *               with `--user` when the system Python refuses a global
 *               install)
 *  - dlv        requires the Go toolchain; `go install` then copies the
 *               binary into the managed dir (go's ~/go/bin is often not
 *               on PATH)
 *  - netcoredbg downloads the matching GitHub release archive into the
 *               managed dir and extracts it
 *
 * The managed dir is `~/.dsh-debugger-dap/adapters`; every directory that
 * contains a `.dsh-adapter-bin` marker is re-discovered on every plugin
 * start and probed for commands ({@link managedBinDirs}), so installed
 * adapters survive host restarts without touching the user's PATH.
 */

import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** Root directory for adapters installed by this plugin. */
export const MANAGED_ADAPTERS_ROOT = join(homedir(), '.dsh-debugger-dap', 'adapters')

/** Marker file identifying a directory that holds installed adapter binaries. */
export const ADAPTER_BIN_MARKER = '.dsh-adapter-bin'

/** Adapter ids {@link installAdapter} knows how to install. */
export const INSTALLABLE_ADAPTERS = ['debugpy', 'dlv', 'netcoredbg'] as const

export type InstallableAdapter = (typeof INSTALLABLE_ADAPTERS)[number]

/** Default per-step timeout (pip / go install / release download). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** Install output is kept as a bounded tail only. */
const OUTPUT_TAIL_CHARS = 8192

// ---------------------------------------------------------------------------
// Managed bin dirs
// ---------------------------------------------------------------------------

let scannedManagedDirs: string[] | undefined
const sessionManagedDirs = new Set<string>()

/**
 * Directories that hold adapter binaries installed by this plugin: the
 * session additions (fresh installs) plus a lazily-scanned, per-process
 * cached walk of {@link MANAGED_ADAPTERS_ROOT}.
 */
export function managedBinDirs(): string[] {
  if (scannedManagedDirs === undefined) scannedManagedDirs = scanManagedBinDirs()
  const dirs = new Set<string>([...scannedManagedDirs, ...sessionManagedDirs])
  return [...dirs]
}

/** Register a freshly installed adapter binary directory for this process. */
export function addManagedBinDir(dir: string): void {
  sessionManagedDirs.add(dir)
}

/** Forget cached scans and session additions (tests). */
export function resetManagedBinDirs(): void {
  scannedManagedDirs = undefined
  sessionManagedDirs.clear()
}

/**
 * Walk `root` (depth-limited) and return every directory containing the
 * {@link ADAPTER_BIN_MARKER} marker file. Pure FS convention: what the
 * previous host run installed, this run rediscovers.
 */
export function scanManagedBinDirs(root: string = MANAGED_ADAPTERS_ROOT): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && entry.name === ADAPTER_BIN_MARKER)) found.push(dir)
    if (depth <= 0) return
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), depth - 1)
    }
  }
  walk(root, 3)
  return found
}

// ---------------------------------------------------------------------------
// Command runner (shared by checks and install recipes)
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number | null
  output: string
}

export type RunCommandFn = (
  argv: readonly string[],
  options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<RunResult>

const tail = (text: string): string => (text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text)

/** Spawn one command, capture stdout+stderr as a bounded tail, never throws. */
export const runCommand: RunCommandFn = (argv, options = {}) =>
  new Promise<RunResult>(resolve => {
    const [command, ...args] = argv
    let output = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (result: RunResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code: result.code, output: tail(result.output).trim() })
    }
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      settle({ code: null, output: String(error) })
      return
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        output = tail(`${output}\n(command timed out after ${options.timeoutMs}ms and was killed)`)
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone; 'close' settles below
        }
      }, options.timeoutMs)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output = tail(output + chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output = tail(output + chunk.toString('utf8'))
    })
    child.on('error', error => settle({ code: null, output: `${output}\n${error.message}` }))
    child.on('close', code => settle({ code, output }))
  })

// ---------------------------------------------------------------------------
// Executable probing (PATH + managed dirs)
// ---------------------------------------------------------------------------

function executableExtensions(): string[] {
  if (process.platform !== 'win32') return ['']
  return Array.from(
    new Set([...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(ext => ext.toLowerCase()), '']),
  )
}

/** Whether `name` resolves as an executable on PATH or in a managed dir. */
export function probeExecutable(name: string): boolean {
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter),
    ...managedBinDirs(),
  ].filter(entry => entry.length > 0)
  for (const directory of directories) {
    for (const ext of executableExtensions()) {
      if (existsSync(join(directory, `${name}${ext}`))) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Install recipes
// ---------------------------------------------------------------------------

export interface InstallOutcome {
  adapter: InstallableAdapter
  alreadyInstalled: boolean
  installed: boolean
  /** The launchable command line after installation (best effort). */
  command?: string
  /** Bounded install output tail (empty when nothing ran). */
  output: string
}

/** Injectable seams so tests drive the flows without pip/go/network. */
export interface InstallDeps {
  runCommand?: RunCommandFn
  /** Executable probe (PATH + managed dirs); defaults to {@link probeExecutable}. */
  probe?: (name: string) => boolean
  /** Fetch a URL as text (GitHub API metadata). */
  fetchText?: (url: string, timeoutMs: number) => Promise<string>
  /** Download a URL into a file. */
  download?: (url: string, destFile: string, timeoutMs: number) => Promise<void>
  /** Extract an archive into a directory. */
  extract?: (archive: string, destDir: string) => Promise<void>
}

export interface InstallOptions {
  deps?: InstallDeps
  timeoutMs?: number
  /** Override the managed root (tests). */
  managedRoot?: string
}

function enoent(output: string): boolean {
  return /ENOENT/i.test(output)
}

async function run(
  deps: InstallDeps,
  argv: readonly string[],
  options: { timeoutMs: number },
): Promise<RunResult> {
  const runFn = deps.runCommand ?? runCommand
  return runFn(argv, { timeoutMs: options.timeoutMs })
}

/** debugpy: probe the interpreter, pip-install the module, re-check the import. */
async function installDebugpy(deps: InstallDeps, timeoutMs: number): Promise<InstallOutcome> {
  // Keep in sync with the debugpy recipe's probeCommands (python, python3):
  // whatever interpreter installs the module must also be what the recipe
  // resolves at launch time.
  const interpreters = ['python', 'python3']
  const check = async (interpreter: string): Promise<RunResult> =>
    run(deps, [interpreter, '-c', 'import debugpy'], { timeoutMs: Math.min(timeoutMs, 30_000) })

  for (const interpreter of interpreters) {
    const pre = await check(interpreter)
    if (pre.code === 0) {
      return { adapter: 'debugpy', alreadyInstalled: true, installed: false, command: `${interpreter} -m debugpy.adapter`, output: '' }
    }
    if (enoent(pre.output)) continue
    const installed = await run(deps, [interpreter, '-m', 'pip', 'install', 'debugpy'], { timeoutMs })
    let output = installed.output
    if (installed.code !== 0) {
      // PEP 668-style managed environments refuse global installs: retry
      // into the user site before giving up.
      const user = await run(deps, [interpreter, '-m', 'pip', 'install', '--user', 'debugpy'], { timeoutMs })
      output = `${output}\n${user.output}`
      if (user.code !== 0) {
        throw new Error(`pip install debugpy failed (exit ${user.code}). Output tail:\n${tail(output)}`)
      }
    }
    const post = await check(interpreter)
    if (post.code !== 0) {
      throw new Error(`debugpy is still not importable after pip install. Output tail:\n${tail(`${output}\n${post.output}`)}`)
    }
    return { adapter: 'debugpy', alreadyInstalled: false, installed: true, command: `${interpreter} -m debugpy.adapter`, output: tail(output) }
  }
  throw new Error(
    'No Python interpreter found (tried: python, python3). Install Python first (https://www.python.org/downloads/), then retry — debugpy is pip-installed into the Python environment.',
  )
}

/** dlv: require the Go toolchain, `go install`, then copy the binary into the managed dir. */
async function installDlv(deps: InstallDeps, timeoutMs: number, managedRoot: string): Promise<InstallOutcome> {
  if ((deps.probe ?? probeExecutable)('dlv')) {
    return { adapter: 'dlv', alreadyInstalled: true, installed: false, command: 'dlv dap', output: '' }
  }
  const goVersion = await run(deps, ['go', 'version'], { timeoutMs: Math.min(timeoutMs, 30_000) })
  if (goVersion.code !== 0) {
    throw new Error(
      `The Go toolchain is required to install dlv but 'go' is not available. Install Go first (https://go.dev/dl/), then retry. Output tail:\n${goVersion.output}`,
    )
  }
  const installed = await run(deps, ['go', 'install', 'github.com/go-delve/delve/cmd/dlv@latest'], { timeoutMs })
  if (installed.code !== 0) {
    throw new Error(`go install dlv failed (exit ${installed.code}). Output tail:\n${installed.output}`)
  }
  // go install places the binary in GOBIN or $GOPATH/bin — a directory that
  // is frequently NOT on PATH. Copy it into the managed dir so the standard
  // probe finds it now and after restarts.
  const gobin = (await run(deps, ['go', 'env', 'GOBIN'], { timeoutMs: 30_000 })).output.trim()
  const gopath = (await run(deps, ['go', 'env', 'GOPATH'], { timeoutMs: 30_000 })).output.trim()
  const goBinDir = gobin.length > 0 ? gobin : join(gopath.length > 0 ? gopath : join(homedir(), 'go'), 'bin')
  const exe = process.platform === 'win32' ? 'dlv.exe' : 'dlv'
  const source = join(goBinDir, exe)
  if (!existsSync(source)) {
    throw new Error(`go install reported success but '${source}' was not found. Output tail:\n${installed.output}`)
  }
  mkdirSync(managedRoot, { recursive: true })
  const dest = join(managedRoot, exe)
  copyFileSync(source, dest)
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
  writeFileSync(join(managedRoot, ADAPTER_BIN_MARKER), '', 'utf8')
  addManagedBinDir(managedRoot)
  return { adapter: 'dlv', alreadyInstalled: false, installed: true, command: dest, output: tail(installed.output) }
}

/** netcoredbg asset name per platform, or an error naming the manual URL. */
export function netcoredbgAsset(): string {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') return 'netcoredbg-win64.zip'
  if (platform === 'linux' && arch === 'x64') return 'netcoredbg-linux-amd64.tar.gz'
  if (platform === 'linux' && arch === 'arm64') return 'netcoredbg-linux-arm64.tar.gz'
  if (platform === 'darwin' && arch === 'x64') return 'netcoredbg-macos-amd64.tar.gz'
  if (platform === 'darwin' && arch === 'arm64') return 'netcoredbg-macos-arm64.tar.gz'
  throw new Error(
    `No prebuilt netcoredbg asset for ${platform}-${arch}. Download it manually from https://github.com/Samsung/netcoredbg/releases and ensure 'netcoredbg' is on PATH.`,
  )
}

const NETCOREDBG_REPO = 'Samsung/netcoredbg'

async function fetchTextDefault(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-debugger-dap' },
  })
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`)
  return response.text()
}

async function downloadDefault(url: string, destFile: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-debugger-dap' },
  })
  if (!response.ok) throw new Error(`download ${url} failed: HTTP ${response.status}`)
  writeFileSync(destFile, Buffer.from(await response.arrayBuffer()))
}

/** Extract zip/tar.gz via tar (bsdtar ships with Windows 10+); PowerShell fallback for zip. */
async function extractDefault(archive: string, destDir: string): Promise<void> {
  const tar = await runCommand(['tar', '-xf', archive, '-C', destDir], { timeoutMs: 120_000 })
  if (tar.code === 0) return
  if (process.platform === 'win32' && archive.endsWith('.zip')) {
    const ps = await runCommand(
      ['powershell', '-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`],
      { timeoutMs: 120_000 },
    )
    if (ps.code === 0) return
    throw new Error(`extract failed (tar: ${tar.output}; powershell: ${ps.output})`)
  }
  throw new Error(`extract failed: ${tar.output}`)
}

/** Find a file named `name` (+ .exe on Windows) directly inside `dir`, depth-limited. */
function findBinary(dir: string, name: string): string | undefined {
  const wanted = process.platform === 'win32' ? [`${name}.exe`] : [name, `${name}.exe`]
  let result: string | undefined
  const walk = (current: string, depth: number): void => {
    if (result !== undefined) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    const hit = entries.find(entry => entry.isFile() && wanted.includes(entry.name))
    if (hit !== undefined) {
      result = join(current, hit.name)
      return
    }
    if (depth <= 0) return
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(current, entry.name), depth - 1)
    }
  }
  walk(dir, 4)
  return result
}

/** netcoredbg: download the GitHub release archive into the managed dir, extract, mark. */
async function installNetcoredbg(deps: InstallDeps, timeoutMs: number, managedRoot: string): Promise<InstallOutcome> {
  if ((deps.probe ?? probeExecutable)('netcoredbg')) {
    return { adapter: 'netcoredbg', alreadyInstalled: true, installed: false, command: 'netcoredbg', output: '' }
  }
  const fetchText = deps.fetchText ?? fetchTextDefault
  const download = deps.download ?? downloadDefault
  const extract = deps.extract ?? extractDefault
  const asset = netcoredbgAsset()
  const releaseApi = `https://api.github.com/repos/${NETCOREDBG_REPO}/releases/latest`
  let url: string
  try {
    const metadata = JSON.parse(await fetchText(releaseApi, Math.min(timeoutMs, 30_000))) as {
      assets?: Array<{ name?: string; browser_download_url?: string }>
    }
    const entry = metadata.assets?.find(candidate => candidate.name === asset)
    if (entry?.browser_download_url === undefined) {
      throw new Error(`the latest release has no asset '${asset}'`)
    }
    url = entry.browser_download_url
  } catch (error) {
    throw new Error(
      `Could not resolve the latest netcoredbg release from GitHub (${error instanceof Error ? error.message : String(error)}). Download '${asset}' manually from https://github.com/${NETCOREDBG_REPO}/releases and extract it under ${managedRoot}.`,
    )
  }
  const staging = mkdtempSync(join(tmpdir(), 'dsh-dap-netcoredbg-'))
  try {
    const archive = join(staging, asset)
    await download(url, archive, timeoutMs)
    const target = join(managedRoot, 'netcoredbg')
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    await extract(archive, target)
    const binary = findBinary(target, 'netcoredbg')
    if (binary === undefined) {
      throw new Error(`the netcoredbg binary was not found inside the extracted archive (${target}).`)
    }
    if (process.platform !== 'win32') chmodSync(binary, 0o755)
    const binDir = dirname(binary)
    writeFileSync(join(binDir, ADAPTER_BIN_MARKER), '', 'utf8')
    addManagedBinDir(binDir)
    return { adapter: 'netcoredbg', alreadyInstalled: false, installed: true, command: binary, output: `downloaded ${url}` }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Install (or report) one adapter. Throws on failure with the bounded
 * output tail embedded; resolves with {@link InstallOutcome} on success
 * (including the `alreadyInstalled` short-circuit).
 */
export async function installAdapter(adapter: string, options: InstallOptions = {}): Promise<InstallOutcome> {
  const deps = options.deps ?? {}
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const managedRoot = options.managedRoot ?? MANAGED_ADAPTERS_ROOT
  switch (adapter) {
    case 'debugpy':
      return installDebugpy(deps, timeoutMs)
    case 'dlv':
      return installDlv(deps, timeoutMs, managedRoot)
    case 'netcoredbg':
      return installNetcoredbg(deps, timeoutMs, managedRoot)
    default:
      throw new Error(`Adapter '${adapter}' cannot be auto-installed. Supported: ${INSTALLABLE_ADAPTERS.join(', ')}.`)
  }
}
