/**
 * Adapter recipes: built-in DAP adapters (debugpy, dlv, netcoredbg,
 * lldb-dap, js-debug, codelldb) plus config-declared rows, resolved
 * against PATH with actionable install hints.
 */

import { delimiter, isAbsolute, join } from 'node:path'
import { accessSync } from 'node:fs'

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
  /** Transport layer. Default `'stdio'`; `'tcp'` means the adapter is reached over TCP. */
  transport?: 'stdio' | 'tcp'
  /** Target host for `'tcp'` transport (default `'127.0.0.1'`). */
  host?: string
  /** Target port for `'tcp'` transport. */
  port?: number
}

/** One `adapters` config row. */
export interface AdapterConfigEntry {
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  cwd?: string
  /** Extra per-adapter fields spread into the DAP `launch` request body. */
  launchArgs?: Record<string, unknown>
  /** Transport layer: 'stdio' (default) or 'tcp'. */
  transport?: 'stdio' | 'tcp'
  /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
  connectHost?: string
  /** TCP connect port. Required when transport is 'tcp'. */
  connectPort?: number
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
  /** Transport layer for this recipe: 'stdio' (default) or 'tcp'. */
  transport?: 'stdio' | 'tcp'
  /** Config row replacing the built-in definition, when present. */
  configOverride?: AdapterConfigEntry
}

const BUILT_IN_RECIPES: readonly AdapterRecipe[] = [
  {
    id: 'debugpy',
    probeCommands: ['python', 'python3'],
    fixedArgs: ['-m', 'debugpy.adapter'],
    installHint: "adapter 'debugpy' is not available: install the debugpy module ('pip install debugpy') and ensure 'python' is on PATH",
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
    // netcoredbg's launch config is `type: coreclr` and it controls the entry
    // stop via `stopAtEntry` rather than the standard `stopOnEntry`.
    launchArgs: { type: 'coreclr' },
    stopOnEntryKey: 'stopAtEntry',
  },
  {
    id: 'lldb-dap',
    probeCommands: ['lldb-dap'],
    fixedArgs: [],
    installHint:
      "adapter 'lldb-dap' is not available: install the LLVM DAP binary (llvm-dap, lldb-dap, or dap-server depending on your LLVM version) and ensure it is on PATH. On macOS with Xcode, you may need to build from https://llvm.org/git/dap.",
  },
  {
    id: 'js-debug',
    probeCommands: ['node'],
    fixedArgs: [],
    installHint:
      "adapter 'js-debug' is not available: run 'npm install -g @vscode/js-debug' and ensure 'node' is on PATH. js-debug is also bundled with VS Code and the 'nodedebug' adapter.",
    launchArgs: { type: 'node' },
  },
  {
    id: 'codelldb',
    probeCommands: ['codelldb'],
    fixedArgs: ['dap', '--port', '0'],
    installHint:
      "adapter 'codelldb' is not available: install the CodeLLDB extension (https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) and ensure the codelldb binary is on PATH, or configure the path in the 'adapters' plugin config.",
    // codelldb listens on a random high port when started with --port 0;
    // the actual port is written to stdout as "Listening on port <N>\n".
    transport: 'tcp',
  },
]

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
    throw new AdapterUnavailableError(
      `Unknown adapter '${wanted}'. Declare it under the plugin's 'adapters' config or use a built-in id (${recipes
        .map(entry => entry.id)
        .join(', ')}).`,
    )
  }
  if (recipe.configOverride !== undefined) {
    const spec = expandConfigEntry(recipe.configOverride)
    spec.launchArgs = recipe.configOverride.launchArgs ?? recipe.launchArgs
    spec.stopOnEntryKey = recipe.stopOnEntryKey ?? 'stopOnEntry'
    return spec
  }
  const command = recipe.probeCommands.find(commandExists)
  if (command === undefined) throw new AdapterUnavailableError(recipe.installHint)
  return {
    command,
    args: recipe.fixedArgs,
    launchArgs: recipe.launchArgs,
    stopOnEntryKey: recipe.stopOnEntryKey ?? 'stopOnEntry',
    transport: recipe.transport,
  }
}

function mergeRecipes(adapterConfig: Record<string, AdapterConfigEntry> | undefined): AdapterRecipe[] {
  const recipes = BUILT_IN_RECIPES.map(recipe => ({ ...recipe }))
  for (const [id, entry] of Object.entries(adapterConfig ?? {})) {
    const existing = recipes.find(recipe => recipe.id === id)
    if (existing === undefined) {
      recipes.push({
        id,
        probeCommands: [entry.command],
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
    command: entry.command,
    args: entry.args ?? ([] as readonly string[]),
    env: entry.env,
    cwd: entry.cwd,
    launchArgs: entry.launchArgs,
    transport: entry.transport,
    host: entry.connectHost,
    port: entry.connectPort,
  }
}

function guessAdapterId(program: string): string | undefined {
  if (program.endsWith('.py')) return 'debugpy'
  if (program.endsWith('.go')) return 'dlv'
  if (program.endsWith('.dll') || program.endsWith('.exe')) return 'netcoredbg'
  if (program.endsWith('.c') || program.endsWith('.cpp') || program.endsWith('.cxx') || program.endsWith('.h') || program.endsWith('.hpp')) return 'lldb-dap'
  if (program.endsWith('.rs')) return 'codelldb'
  if (program.endsWith('.js') || program.endsWith('.mjs') || program.endsWith('.cjs') || program.endsWith('.ts') || program.endsWith('.mts') || program.endsWith('.cts')) return 'js-debug'
  return undefined
}

/**
 * Default PATH probe. Absolute paths are checked directly; bare names are
 * probed against every PATH directory with the platform executable suffixes.
 */
export function defaultCommandExists(command: string): boolean {
  if (isAbsolute(command)) {
    try {
      accessSync(command)
      return true
    } catch {
      return false
    }
  }
  const directories = (process.env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0)
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, command + extension))
        return true
      } catch {
        // try the next candidate
      }
    }
  }
  return false
}
