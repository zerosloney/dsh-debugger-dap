/**
 * Adapter recipes: built-in DAP adapters (debugpy, dlv, netcoredbg,
 * lldb-dap, codelldb) plus config-declared rows, resolved against PATH
 * with actionable install hints. js-debug is intentionally config-only:
 * it ships as a TCP DAP server script rather than a PATH command.
 */

import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { accessSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { INSTALLABLE_ADAPTERS, installAdapter, managedBinDirs, type InstallDeps } from './install.js'

/** One launchable adapter command line. */
export interface AdapterSpec {
  command: string
  args: readonly string[]
  env?: Record<string, string>
  cwd?: string
  /** Extra per-adapter fields spread into the DAP `launch` request body. */
  launchArgs?: Record<string, unknown>
  /**
   * Which `launch` field carries the stop-on-entry control. Most adapters use
   * `stopOnEntry`; netcoredbg uses `stopAtEntry`.
   */
  stopOnEntryKey?: string
  /**
   * Standard DAP exception filter → adapter-specific filter name. E.g.
   * debugpy has no 'all' filter (its filters are raised/uncaught/userUnhandled),
   * so the recipe maps 'all' → 'raised'. Unknown filters pass through.
   */
  exceptionFilterMap?: Record<string, string>
  /** Transport layer. Default `'stdio'`; `'tcp'` means the adapter is reached over TCP. */
  transport?: 'stdio' | 'tcp'
  /** Target host for `'tcp'` transport (default `'127.0.0.1'`). */
  host?: string
  /** Target port for `'tcp'` transport. */
  port?: number
  /** Regex (string or RegExp) matching the adapter's port announcement: the last capture group is the port; with two groups the first is the announced host. Used when the TCP port is discovered. */
  portPattern?: string | RegExp
  /** Which child stream carries the port announcement: `'stdout'`, `'stderr'`, or `'both'` (default `'both'`). */
  announceStream?: 'stdout' | 'stderr' | 'both'
}

/** One `adapters` config row. */
export interface AdapterConfigEntry {
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  cwd?: string
  /** Extra per-adapter fields spread into the DAP `launch` request body. */
  launchArgs?: Record<string, unknown>
  /**
   * `launch` field that carries the stop-on-entry control (default
   * 'stopOnEntry'; netcoredbg-style adapters use 'stopAtEntry').
   */
  stopOnEntryKey?: string
  /** Transport layer: 'stdio' (default) or 'tcp'. */
  transport?: 'stdio' | 'tcp'
  /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
  connectHost?: string
  /** TCP connect port. Required when transport is 'tcp'. */
  connectPort?: number
  /** Regex (string) matching the adapter's port announcement: the last capture group is the port; with two groups the first is the announced host. Used when transport is 'tcp' without connectPort. */
  portPattern?: string
  /** Which child stream carries the port announcement: 'stdout', 'stderr', or 'both' (default 'both'). */
  announceStream?: 'stdout' | 'stderr' | 'both'
  /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
  exceptionFilterMap?: Record<string, string>
}

/** A recipe: id, command line, and how to probe availability. */
export interface AdapterRecipe {
  id: string
  /** Candidate commands probed in order on PATH. */
  probeCommands: readonly string[]
  /** Fixed argv appended after the resolved command. */
  fixedArgs: readonly string[]
  /** Install hint shown when no probe command resolves. */
  installHint: string
  /** Default per-adapter fields spread into the `launch` request body. */
  launchArgs?: Record<string, unknown>
  /** `launch` field that carries the stop-on-entry control (default `stopOnEntry`). */
  stopOnEntryKey?: string
  /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
  exceptionFilterMap?: Record<string, string>
  /** Transport layer for this recipe: 'stdio' (default) or 'tcp'. */
  transport?: 'stdio' | 'tcp'
  /** Config row replacing the built-in definition, when present. */
  configOverride?: AdapterConfigEntry
}

/**
 * Expand a user-home prefix (`~`) and environment variables (`%VAR%`,
 * `${VAR}`) in a path.
 */
export function expandPath(str: string): string {
  if (str === '~') return homedir()
  let result = str
  if (result.startsWith('~/') || result.startsWith('~\\')) {
    result = join(homedir(), result.slice(2))
  }
  result = result.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '')
  result = result.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '')
  return result
}

function parseSemverParts(name: string, prefix: string): number[] {
  const versionPart = name.slice(prefix.length).replace(/^-/, '')
  const match = versionPart.match(/^(\d+(?:\.\d+)*)/)
  if (!match) return []
  return match[1].split('.').map(n => parseInt(n, 10))
}

function compareSemver(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const valA = a[i] ?? 0
    const valB = b[i] ?? 0
    if (valA !== valB) return valA - valB
  }
  return 0
}

/**
 * Discover entry path within VS Code installed extensions by extension prefix (e.g. `ms-vscode.js-debug`).
 * Automatically probes standard extension root directories across platforms and selects the newest installed version.
 */
export function findVsCodeExtensionEntry(
  extensionPrefix: string,
  relativeCandidates: readonly string[],
): string | undefined {
  const home = homedir()
  const searchRoots: string[] = [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode-server', 'extensions'),
    join(home, '.vscode-server-insiders', 'extensions'),
  ]

  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      searchRoots.push(
        join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'extensions'),
        join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'resources', 'app', 'extensions'),
      )
    }
    if (process.env.PROGRAMFILES) {
      searchRoots.push(
        join(process.env.PROGRAMFILES, 'Microsoft VS Code', 'resources', 'app', 'extensions'),
      )
    }
  } else if (process.platform === 'darwin') {
    searchRoots.push(
      '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions',
    )
  } else {
    searchRoots.push(
      '/usr/share/code/resources/app/extensions',
      '/usr/share/code-insiders/resources/app/extensions',
      '/snap/code/current/usr/share/code/resources/app/extensions',
    )
  }

  for (const root of searchRoots) {
    if (!existsSync(root)) continue
    try {
      const entries = readdirSync(root, { withFileTypes: true })
      const prefixLower = extensionPrefix.toLowerCase()
      const matching = entries
        .filter(e => e.isDirectory() && e.name.toLowerCase().startsWith(prefixLower))
        .map(e => e.name)

      matching.sort((a, b) => {
        const verA = parseSemverParts(a, extensionPrefix)
        const verB = parseSemverParts(b, extensionPrefix)
        const cmp = compareSemver(verA, verB)
        if (cmp !== 0) return -cmp
        return b.localeCompare(a)
      })

      for (const folder of matching) {
        for (const candidate of relativeCandidates) {
          const target = join(root, folder, candidate)
          if (existsSync(target)) {
            return target
          }
        }
      }
    } catch {
      // Ignore filesystem errors on search root candidates
    }
  }

  return undefined
}

const BUILT_IN_RECIPES: readonly AdapterRecipe[] = [
  {
    id: 'debugpy',
    probeCommands: ['python', 'python3'],
    fixedArgs: ['-m', 'debugpy.adapter'],
    installHint: "adapter 'debugpy' is not available: install the debugpy module ('pip install debugpy') and ensure 'python' is on PATH",
    exceptionFilterMap: { all: 'raised' },
  },
  {
    id: 'dlv',
    probeCommands: ['dlv'],
    fixedArgs: ['dap'],
    installHint: "adapter 'dlv' is not available: install Delve ('go install github.com/go-delve/delve/cmd/dlv@latest') and ensure 'dlv' is on PATH",
  },
  {
    id: 'netcoredbg',
    probeCommands: ['netcoredbg'],
    fixedArgs: ['--interpreter=vscode'],
    installHint:
      "adapter 'netcoredbg' is not available: download a netcoredbg release from https://github.com/Samsung/netcoredbg/releases and ensure 'netcoredbg' is on PATH",
    launchArgs: { type: 'coreclr' },
    stopOnEntryKey: 'stopAtEntry',
  },
  {
    id: 'lldb-dap',
    probeCommands: ['lldb-dap', 'lldb-vscode', 'llvm-dap'],
    fixedArgs: [],
    installHint:
      "adapter 'lldb-dap' is not available: install the LLVM DAP binary (lldb-dap, lldb-vscode, or llvm-dap depending on your LLVM version) and ensure it is on PATH. On macOS with Xcode, you may need to build from https://llvm.org/git/dap.",
  },
  {
    id: 'codelldb',
    probeCommands: ['codelldb'],
    fixedArgs: ['--port', '0'],
    installHint:
      "adapter 'codelldb' is not available: install the CodeLLDB extension in VS Code ('vadimcn.vscode-lldb') or ensure the codelldb binary is on PATH.",
    transport: 'tcp',
  },
]

/**
 * Port announcement pattern for js-debug's dapDebugServer: it prints
 * "Debug server listening at ::1:8123" (host may be an IPv6 loopback,
 * port last) rather than codelldb's "Listening on port N". Capture
 * group 1 is the host, group 2 the port (the port is always the last
 * group).
 */
export const JS_DEBUG_PORT_PATTERN = '[Dd]ebug server listening at:?\\s+(.*):(\\d+)'

/** Failed adapter resolution with the actionable message to surface. */
export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdapterUnavailableError'
  }
}

/** Resolved launch request for {@link spawnDapAdapter}. */
export function resolveAdapter(
  options: { adapter?: string; program: string },
  adapterConfig: Record<string, AdapterConfigEntry> | undefined,
  commandExists: (command: string) => boolean = defaultCommandExists,
  findExtension: (prefix: string, relativeCandidates: readonly string[]) => string | undefined = findVsCodeExtensionEntry,
): AdapterSpec {
  const recipes = mergeRecipes(adapterConfig)
  const wanted = options.adapter ?? guessAdapterId(options.program)
  if (wanted === undefined) {
    const available = recipes.filter(recipe => recipe.probeCommands.some(commandExists)).map(recipe => recipe.id)
    throw new AdapterUnavailableError(
      `No debugger adapter matches '${options.program}'. Pass 'adapter' explicitly (available: ${
        available.length > 0 ? available.join(', ') : 'none'
      }). Custom adapters are declared in the 'adapters' plugin config.`,
    )
  }
  const recipe = recipes.find(entry => entry.id === wanted)
  if (recipe === undefined) {
    if (wanted === 'js-debug') {
      // Auto-discover js-debug extension server script if present
      const discovered = findExtension('ms-vscode.js-debug', [
        'dist/src/dapDebugServer.js',
        'src/dapDebugServer.js',
        'out/src/dapDebugServer.js',
      ])
      if (discovered !== undefined && commandExists('node')) {
        return {
          command: 'node',
          args: [discovered],
          transport: 'tcp',
          // See {@link JS_DEBUG_PORT_PATTERN}: without the captured host,
          // connecting to the default 127.0.0.1 would never reach an
          // IPv6-only bind.
          portPattern: JS_DEBUG_PORT_PATTERN,
          launchArgs: { type: 'node', sourceMaps: true },
          stopOnEntryKey: 'stopOnEntry',
        }
      }
      throw new AdapterUnavailableError(
        "adapter 'js-debug' has no built-in command: it is a VS Code-bundled TCP DAP server script. Install the JavaScript Debugger extension in VS Code ('ms-vscode.js-debug') for automatic discovery, or declare it in the plugin's 'adapters' config (e.g. adapters: { 'js-debug': { command: 'node', args: ['~/.vscode/extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js'], transport: 'tcp', connectPort: 12722 } }).",
      )
    }
    throw new AdapterUnavailableError(
      `Unknown adapter '${wanted}'. Declare it under the plugin's 'adapters' config or use a built-in id (${recipes
        .map(entry => entry.id)
        .join(', ')}).`,
    )
  }
  if (recipe.configOverride !== undefined) {
    const spec = expandConfigEntry(recipe.configOverride)
    // Config rows that omit launchArgs keep the built-in recipe's defaults.
    spec.launchArgs = recipe.configOverride.launchArgs ?? recipe.launchArgs
    spec.stopOnEntryKey = recipe.configOverride.stopOnEntryKey ?? recipe.stopOnEntryKey ?? 'stopOnEntry'
    spec.exceptionFilterMap = recipe.configOverride.exceptionFilterMap ?? recipe.exceptionFilterMap
    return spec
  }

  // Check if primary command is on PATH
  const command = recipe.probeCommands.find(commandExists)
  if (command !== undefined) {
    return {
      command,
      args: recipe.fixedArgs,
      launchArgs: recipe.launchArgs,
      stopOnEntryKey: recipe.stopOnEntryKey ?? 'stopOnEntry',
      exceptionFilterMap: recipe.exceptionFilterMap,
      transport: recipe.transport,
    }
  }

  // Fallback: Check if extension binary exists in VS Code extensions
  if (wanted === 'codelldb') {
    const discovered = findExtension(
      'vadimcn.vscode-lldb',
      process.platform === 'win32' ? ['adapter/codelldb.exe'] : ['adapter/codelldb'],
    )
    if (discovered !== undefined) {
      return {
        command: discovered,
        args: recipe.fixedArgs,
        launchArgs: recipe.launchArgs,
        stopOnEntryKey: recipe.stopOnEntryKey ?? 'stopOnEntry',
        exceptionFilterMap: recipe.exceptionFilterMap,
        transport: 'tcp',
      }
    }
  }

  throw new AdapterUnavailableError(recipe.installHint)
}

function mergeRecipes(adapterConfig: Record<string, AdapterConfigEntry> | undefined): AdapterRecipe[] {
  const recipes = BUILT_IN_RECIPES.map(recipe => ({ ...recipe }))
  for (const [id, entry] of Object.entries(adapterConfig ?? {})) {
    const existing = recipes.find(recipe => recipe.id === id)
    if (existing === undefined) {
      recipes.push({
        id,
        probeCommands: [expandPath(entry.command)],
        fixedArgs: [],
        installHint: `adapter '${id}' is not available: configured command '${entry.command}' did not resolve on PATH`,
        configOverride: entry,
      })
    } else {
      existing.configOverride = entry
    }
  }
  return recipes
}

function expandConfigEntry(entry: AdapterConfigEntry): AdapterSpec {
  return {
    command: expandPath(entry.command),
    args: entry.args?.map(expandPath) ?? ([] as readonly string[]),
    env: entry.env,
    cwd: entry.cwd ? expandPath(entry.cwd) : undefined,
    launchArgs: entry.launchArgs,
    stopOnEntryKey: entry.stopOnEntryKey,
    exceptionFilterMap: entry.exceptionFilterMap,
    transport: entry.transport,
    host: entry.connectHost,
    port: entry.connectPort,
    portPattern: entry.portPattern,
    announceStream: entry.announceStream,
  }
}

function guessAdapterId(program: string): string | undefined {
  const lower = program.toLowerCase()
  if (lower.endsWith('.py')) return 'debugpy'
  if (lower.endsWith('.go')) return 'dlv'
  if (lower.endsWith('.dll') || lower.endsWith('.exe')) return 'netcoredbg'
  if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cxx') || lower.endsWith('.h') || lower.endsWith('.hpp')) return 'lldb-dap'
  if (lower.endsWith('.rs')) return 'codelldb'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'js-debug'
  return undefined
}

export { guessAdapterId }

/**
 * Wrap {@link resolveAdapter} with best-effort auto-install: when the
 * resolver fails with {@link AdapterUnavailableError} and the wanted
 * adapter is installable, run {@link installAdapter} once, then resolve
 * again. Install failures surface as an AdapterUnavailableError combining
 * the original hint and the install output tail.
 */
export function createAutoInstallingResolver(
  adapterConfig: Record<string, AdapterConfigEntry> | undefined,
  options: {
    autoInstall: boolean
    installTimeoutMs?: number
    installDeps?: InstallDeps
    commandExists?: (command: string) => boolean
  },
): (resolveOptions: { adapter?: string; program: string }) => Promise<AdapterSpec> {
  return async resolveOptions => {
    const attempt = (): AdapterSpec =>
      resolveAdapter(resolveOptions, adapterConfig, options.commandExists ?? defaultCommandExists)
    try {
      return attempt()
    } catch (error) {
      if (!options.autoInstall || !(error instanceof AdapterUnavailableError)) throw error
      const wanted = resolveOptions.adapter ?? guessAdapterId(resolveOptions.program)
      if (wanted === undefined || !(INSTALLABLE_ADAPTERS as readonly string[]).includes(wanted)) throw error
      try {
        await installAdapter(wanted, { timeoutMs: options.installTimeoutMs, deps: options.installDeps })
      } catch (installError) {
        const detail = installError instanceof Error ? installError.message : String(installError)
        throw new AdapterUnavailableError(`${error.message}\nAuto-install of '${wanted}' failed: ${detail}`)
      }
      try {
        return attempt()
      } catch (retryError) {
        const detail = retryError instanceof Error ? retryError.message : String(retryError)
        throw new AdapterUnavailableError(
          `'${wanted}' was installed but still does not resolve: ${detail}\nThe managed adapter directory may need a host restart to be picked up.`,
        )
      }
    }
  }
}

/**
 * Default PATH probe. Absolute paths are checked directly; bare names are
 * probed against every PATH directory plus the plugin-managed adapter
 * directories (see {@link managedBinDirs}) with the platform executable
 * suffixes.
 */
export function defaultCommandExists(command: string): boolean {
  const expanded = expandPath(command)
  if (isAbsolute(expanded)) {
    try {
      accessSync(expanded)
      return true
    } catch {
      return false
    }
  }
  const directories = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(entry => entry.length > 0)
    .concat(managedBinDirs())
  const extensions =
    process.platform === 'win32'
      ? Array.from(new Set([(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map(ext => ext.toLowerCase()), ''].flat()))
      : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, expanded + extension))
        return true
      } catch {
        // try the next candidate
      }
    }
  }
  return false
}

/**
 * Strips single-line and multi-line comments from JSONC text, and cleans up trailing commas.
 */
export function stripJsonComments(jsonString: string): string {
  return jsonString
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, group) => (group ? '' : match))
    .replace(/,\s*([}\]])/g, '$1')
}

/** One raw configuration entry from .vscode/launch.json. */
export interface VsCodeLaunchConfig {
  name: string
  type: string
  request?: 'launch' | 'attach'
  program?: string
  main?: string
  module?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  stopAtEntry?: boolean
  processId?: number | string
  preLaunchTask?: string
  [key: string]: unknown
}

/** One task configuration entry from .vscode/tasks.json. */
export interface VsCodeTaskConfig {
  label?: string
  taskName?: string
  type?: string
  command?: string
  args?: string[]
  options?: {
    cwd?: string
    env?: Record<string, string>
  }
  script?: string
  [key: string]: unknown
}

/** Reads all launch configurations from a workspace directory's .vscode/launch.json. */
export function readLaunchConfigurations(workspaceDir: string): VsCodeLaunchConfig[] {
  const launchPath = join(workspaceDir, '.vscode', 'launch.json')
  if (!existsSync(launchPath)) return []
  try {
    const raw = readFileSync(launchPath, 'utf8')
    const cleaned = stripJsonComments(raw)
    const parsed = JSON.parse(cleaned)
    if (parsed && Array.isArray(parsed.configurations)) {
      return parsed.configurations
    }
  } catch {
    // If reading or parsing fails, return empty
  }
  return []
}

/** Resolves VS Code variables (${workspaceFolder}, ${file}, ${env:VAR}, etc.) recursively. */
export function resolveVsCodeVariables<T>(value: T, workspaceDir: string, activeFile?: string): T {
  if (typeof value === 'string') {
    const wsBasename = basename(workspaceDir)
    let res: string = value
    let isPath = false
    if (/\$\{(?:workspaceFolder|workspaceRoot|file|fileBasename|fileDirname)\}/.test(res)) {
      isPath = true
      res = res
        .replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, workspaceDir)
        .replace(/\$\{workspaceFolderBasename\}/g, wsBasename)
      if (activeFile) {
        res = res
          .replace(/\$\{file\}/g, activeFile)
          .replace(/\$\{fileBasename\}/g, basename(activeFile))
          .replace(/\$\{fileDirname\}/g, dirname(activeFile))
      }
    }
    res = res.replace(/\$\{env[:.]([A-Za-z0-9_]+)\}/g, (_, varName) => process.env[varName] ?? '')
    const expanded = expandPath(res)
    return (isPath ? normalize(expanded) : expanded) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveVsCodeVariables(item, workspaceDir, activeFile)) as unknown as T
  }
  if (typeof value === 'object' && value !== null) {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      obj[k] = resolveVsCodeVariables(v, workspaceDir, activeFile)
    }
    return obj as unknown as T
  }
  return value
}

/** Maps a VS Code debug type to an adapter ID. */
export function mapVsCodeTypeToAdapter(type: string): string {
  const t = type.toLowerCase()
  switch (t) {
    case 'python':
    case 'debugpy':
      return 'debugpy'
    case 'node':
    case 'node2':
    case 'pwa-node':
    case 'pwa-chrome':
    case 'pwa-msedge':
    case 'pwa-extensionhost':
    case 'js-debug':
      return 'js-debug'
    case 'lldb':
    case 'codelldb':
    case 'cppdbg':
    case 'cppvsdbg':
    case 'c':
    case 'cpp':
    case 'rust':
      return 'codelldb'
    case 'coreclr':
    case 'clr':
    case 'dotnet':
    case 'netcoredbg':
      return 'netcoredbg'
    case 'go':
    case 'golang':
    case 'dlv':
      return 'dlv'
    default:
      return type
  }
}

/** Reads all task configurations from a workspace directory's .vscode/tasks.json. */
export function readTasksConfigurations(workspaceDir: string): VsCodeTaskConfig[] {
  const tasksPath = join(workspaceDir, '.vscode', 'tasks.json')
  if (!existsSync(tasksPath)) return []
  try {
    const raw = readFileSync(tasksPath, 'utf8')
    const cleaned = stripJsonComments(raw)
    const parsed = JSON.parse(cleaned)
    if (parsed && Array.isArray(parsed.tasks)) {
      return parsed.tasks
    }
  } catch {
    // If reading or parsing fails, return empty
  }
  return []
}

/** Resolves a specific task command and its arguments/cwd from .vscode/tasks.json. */
export function resolveTaskCommand(
  taskLabel: string,
  workspaceDir: string,
): { command: string; args: string[]; cwd: string; env?: Record<string, string>; shell?: boolean } | undefined {
  const tasks = readTasksConfigurations(workspaceDir)
  const target = taskLabel.trim().toLowerCase()
  const found = tasks.find(
    t =>
      (typeof t.label === 'string' && t.label.trim().toLowerCase() === target) ||
      (typeof t.taskName === 'string' && t.taskName.trim().toLowerCase() === target),
  )
  if (!found) return undefined

  const resolved = resolveVsCodeVariables(found, workspaceDir)
  let command = typeof resolved.command === 'string' ? resolved.command : ''
  let args: string[] = Array.isArray(resolved.args) ? resolved.args.map(String) : []
  let shell = true

  if (!command) {
    if (resolved.type === 'npm') {
      command = 'npm'
      args = ['run', typeof resolved.script === 'string' ? resolved.script : taskLabel]
    } else if (resolved.type === 'typescript' || resolved.type === 'tsc') {
      command = 'npx'
      args = ['tsc']
    } else {
      command = taskLabel
      args = []
    }
  }

  const cwd = typeof resolved.options?.cwd === 'string' ? resolved.options.cwd : workspaceDir
  const env = typeof resolved.options?.env === 'object' && resolved.options?.env !== null ? resolved.options.env : undefined

  return { command, args, cwd, env, shell }
}

/** Bound the captured task output so a chatty build cannot balloon memory or the error message. */
const MAX_TASK_OUTPUT_CHARS = 64 * 1024

/** Longest output tail embedded in a failure message. */
const TASK_ERROR_TAIL_CHARS = 2000

/** Executes a preLaunchTask from .vscode/tasks.json. */
export async function runPreLaunchTask(
  taskLabel: string,
  workspaceDir: string,
  signal?: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ success: boolean; output: string }> {
  const task = resolveTaskCommand(taskLabel, workspaceDir)
  if (!task) {
    throw new Error(`preLaunchTask '${taskLabel}' was not found in .vscode/tasks.json`)
  }

  return new Promise((resolveTask, rejectTask) => {
    let output = ''
    let childProcess: ReturnType<typeof spawn> | undefined
    let timer: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      if (childProcess) childProcess.kill()
      rejectTask(new Error(`preLaunchTask '${taskLabel}' was aborted`))
    }

    if (signal?.aborted) {
      return rejectTask(new Error(`preLaunchTask '${taskLabel}' was aborted`))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      childProcess = spawn(task.command, task.args, {
        cwd: task.cwd,
        env: { ...process.env, ...task.env },
        shell: task.shell ?? true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      cleanup()
      const msg = err instanceof Error ? err.message : String(err)
      return rejectTask(new Error(`Failed to spawn preLaunchTask '${taskLabel}': ${msg}`))
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        if (childProcess) childProcess.kill()
        rejectTask(new Error(`preLaunchTask '${taskLabel}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }

    childProcess.stdout?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_TASK_OUTPUT_CHARS)
    })
    childProcess.stderr?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_TASK_OUTPUT_CHARS)
    })

    childProcess.on('error', (err: Error) => {
      cleanup()
      rejectTask(new Error(`preLaunchTask '${taskLabel}' error: ${err.message}`))
    })

    childProcess.on('close', (code: number | null) => {
      cleanup()
      if (code === 0) {
        resolveTask({ success: true, output: output.trim() })
      } else {
        rejectTask(new Error(`preLaunchTask '${taskLabel}' failed with exit code ${code ?? 'unknown'}:\n${output.trim().slice(-TASK_ERROR_TAIL_CHARS)}`))
      }
    })
  })
}

/** Resolved launch configuration ready for DAP launch. */
export interface ResolvedVsCodeLaunch {
  name: string
  adapter?: string
  program?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stopOnEntry?: boolean
  processId?: number
  request: 'launch' | 'attach'
  preLaunchTask?: string
  extraLaunchArgs: Record<string, unknown>
}

/**
 * Resolves a launch configuration from the workspace's .vscode/launch.json.
 * If launchConfigName is given, finds the exact configuration by name.
 * If program is omitted, defaults to the first configuration in launch.json.
 */
export function resolveLaunchConfig(options: {
  workspaceDir?: string
  launchConfigName?: string
  program?: string
  activeFile?: string
}): ResolvedVsCodeLaunch | undefined {
  const wsDir = resolve(options.workspaceDir ?? process.cwd())
  const configs = readLaunchConfigurations(wsDir)
  if (configs.length === 0) return undefined

  let chosen: VsCodeLaunchConfig | undefined
  if (options.launchConfigName) {
    const targetName = options.launchConfigName.trim().toLowerCase()
    chosen = configs.find(c => typeof c.name === 'string' && c.name.trim().toLowerCase() === targetName)
    if (!chosen) return undefined
  } else if (!options.program || options.program.length === 0) {
    if (options.activeFile) {
      chosen = configs.find(c => {
        const p = typeof c.program === 'string' ? c.program : ''
        return p.includes(basename(options.activeFile!))
      })
    }
    if (!chosen) {
      chosen = configs[0]
    }
  } else {
    return undefined
  }

  if (!chosen) return undefined

  const resolved = resolveVsCodeVariables(chosen, wsDir, options.activeFile)
  const adapter = typeof resolved.type === 'string' ? mapVsCodeTypeToAdapter(resolved.type) : undefined
  const program =
    typeof resolved.program === 'string'
      ? resolved.program
      : typeof resolved.main === 'string'
        ? resolved.main
        : undefined

  const args = Array.isArray(resolved.args) ? resolved.args.map(String) : undefined
  const cwd = typeof resolved.cwd === 'string' ? resolved.cwd : wsDir
  const env = typeof resolved.env === 'object' && resolved.env !== null ? (resolved.env as Record<string, string>) : undefined
  const stopOnEntry =
    typeof resolved.stopOnEntry === 'boolean'
      ? resolved.stopOnEntry
      : typeof resolved.stopAtEntry === 'boolean'
        ? resolved.stopAtEntry
        : undefined

  const processId =
    typeof resolved.processId === 'number'
      ? resolved.processId
      : typeof resolved.processId === 'string'
        ? Number.parseInt(resolved.processId, 10)
        : undefined

  const knownKeys = new Set([
    'name', 'type', 'request', 'program', 'main', 'module', 'args',
    'cwd', 'env', 'stopOnEntry', 'stopAtEntry', 'processId', 'preLaunchTask'
  ])
  const extraLaunchArgs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(resolved)) {
    if (!knownKeys.has(k)) {
      extraLaunchArgs[k] = v
    }
  }

  return {
    name: resolved.name ?? 'unnamed',
    adapter,
    program,
    args,
    cwd,
    env,
    stopOnEntry,
    processId: Number.isNaN(processId) ? undefined : processId,
    request: resolved.request === 'attach' ? 'attach' : 'launch',
    preLaunchTask: typeof resolved.preLaunchTask === 'string' ? resolved.preLaunchTask : undefined,
    extraLaunchArgs,
  }
}
