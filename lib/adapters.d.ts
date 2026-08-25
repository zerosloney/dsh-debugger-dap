/**
 * Adapter recipes: built-in DAP adapters (debugpy, dlv, netcoredbg,
 * lldb-dap, codelldb) plus config-declared rows, resolved against PATH
 * with actionable install hints. js-debug is intentionally config-only:
 * it ships as a TCP DAP server script rather than a PATH command.
 */
/** One launchable adapter command line. */
export interface AdapterSpec {
    command: string;
    args: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Extra per-adapter fields spread into the DAP `launch` request body. */
    launchArgs?: Record<string, unknown>;
    /**
     * Which `launch` field carries the stop-on-entry control. Most adapters use
     * `stopOnEntry`; netcoredbg uses `stopAtEntry`.
     */
    stopOnEntryKey?: string;
    /**
     * Standard DAP exception filter → adapter-specific filter name. E.g.
     * debugpy has no 'all' filter (its filters are raised/uncaught/userUnhandled),
     * so the recipe maps 'all' → 'raised'. Unknown filters pass through.
     */
    exceptionFilterMap?: Record<string, string>;
    /** Transport layer. Default `'stdio'`; `'tcp'` means the adapter is reached over TCP. */
    transport?: 'stdio' | 'tcp';
    /** Target host for `'tcp'` transport (default `'127.0.0.1'`). */
    host?: string;
    /** Target port for `'tcp'` transport. */
    port?: number;
    /** Regex (string or RegExp) matching the adapter's port announcement on stdout, one capture group for the port. Used when the TCP port is discovered. */
    portPattern?: string | RegExp;
    /** Which child stream carries the port announcement: `'stdout'`, `'stderr'`, or `'both'` (default `'both'`). */
    announceStream?: 'stdout' | 'stderr' | 'both';
}
/** One `adapters` config row. */
export interface AdapterConfigEntry {
    command: string;
    args?: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Extra per-adapter fields spread into the DAP `launch` request body. */
    launchArgs?: Record<string, unknown>;
    /** Transport layer: 'stdio' (default) or 'tcp'. */
    transport?: 'stdio' | 'tcp';
    /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
    connectHost?: string;
    /** TCP connect port. Required when transport is 'tcp'. */
    connectPort?: number;
    /** Regex (string) matching the adapter's port announcement on stdout, one capture group for the port. Used when transport is 'tcp' without connectPort. */
    portPattern?: string;
    /** Which child stream carries the port announcement: 'stdout', 'stderr', or 'both' (default 'both'). */
    announceStream?: 'stdout' | 'stderr' | 'both';
    /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
    exceptionFilterMap?: Record<string, string>;
}
/** A recipe: id, command line, and how to probe availability. */
export interface AdapterRecipe {
    id: string;
    /** Candidate commands probed in order on PATH. */
    probeCommands: readonly string[];
    /** Fixed argv appended after the resolved command. */
    fixedArgs: readonly string[];
    /** Install hint shown when no probe command resolves. */
    installHint: string;
    /** Default per-adapter fields spread into the `launch` request body. */
    launchArgs?: Record<string, unknown>;
    /** `launch` field that carries the stop-on-entry control (default `stopOnEntry`). */
    stopOnEntryKey?: string;
    /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
    exceptionFilterMap?: Record<string, string>;
    /** Transport layer for this recipe: 'stdio' (default) or 'tcp'. */
    transport?: 'stdio' | 'tcp';
    /** Config row replacing the built-in definition, when present. */
    configOverride?: AdapterConfigEntry;
}
/**
 * Expand user home prefix `~` and environment variables (`%VAR%`, `${VAR}`, `$VAR`) in a path.
 */
export declare function expandPath(str: string): string;
/**
 * Discover entry path within VS Code installed extensions by extension prefix (e.g. `ms-vscode.js-debug`).
 * Automatically probes standard extension root directories across platforms and selects the newest installed version.
 */
export declare function findVsCodeExtensionEntry(extensionPrefix: string, relativeCandidates: readonly string[]): string | undefined;
/** Failed adapter resolution with the actionable message to surface. */
export declare class AdapterUnavailableError extends Error {
    constructor(message: string);
}
/** Resolved launch request for {@link spawnDapAdapter}. */
export declare function resolveAdapter(options: {
    adapter?: string;
    program: string;
}, adapterConfig: Record<string, AdapterConfigEntry> | undefined, commandExists?: (command: string) => boolean, findExtension?: (prefix: string, relativeCandidates: readonly string[]) => string | undefined): AdapterSpec;
/**
 * Default PATH probe. Absolute paths are checked directly; bare names are
 * probed against every PATH directory with the platform executable suffixes.
 */
export declare function defaultCommandExists(command: string): boolean;
/**
 * Strips single-line and multi-line comments from JSONC text, and cleans up trailing commas.
 */
export declare function stripJsonComments(jsonString: string): string;
/** One raw configuration entry from .vscode/launch.json. */
export interface VsCodeLaunchConfig {
    name: string;
    type: string;
    request?: 'launch' | 'attach';
    program?: string;
    main?: string;
    module?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
    stopAtEntry?: boolean;
    processId?: number | string;
    preLaunchTask?: string;
    [key: string]: unknown;
}
/** One task configuration entry from .vscode/tasks.json. */
export interface VsCodeTaskConfig {
    label?: string;
    taskName?: string;
    type?: string;
    command?: string;
    args?: string[];
    options?: {
        cwd?: string;
        env?: Record<string, string>;
    };
    script?: string;
    [key: string]: unknown;
}
/** Reads all launch configurations from a workspace directory's .vscode/launch.json. */
export declare function readLaunchConfigurations(workspaceDir: string): VsCodeLaunchConfig[];
/** Resolves VS Code variables (${workspaceFolder}, ${file}, ${env:VAR}, etc.) recursively. */
export declare function resolveVsCodeVariables<T>(value: T, workspaceDir: string, activeFile?: string): T;
/** Maps a VS Code debug type to an adapter ID. */
export declare function mapVsCodeTypeToAdapter(type: string): string;
/** Reads all task configurations from a workspace directory's .vscode/tasks.json. */
export declare function readTasksConfigurations(workspaceDir: string): VsCodeTaskConfig[];
/** Resolves a specific task command and its arguments/cwd from .vscode/tasks.json. */
export declare function resolveTaskCommand(taskLabel: string, workspaceDir: string): {
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    shell?: boolean;
} | undefined;
/** Executes a preLaunchTask from .vscode/tasks.json. */
export declare function runPreLaunchTask(taskLabel: string, workspaceDir: string, signal?: AbortSignal, timeoutMs?: number): Promise<{
    success: boolean;
    output: string;
}>;
/** Resolved launch configuration ready for DAP launch. */
export interface ResolvedVsCodeLaunch {
    name: string;
    adapter?: string;
    program?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
    processId?: number;
    request: 'launch' | 'attach';
    preLaunchTask?: string;
    extraLaunchArgs: Record<string, unknown>;
}
/**
 * Resolves a launch configuration from the workspace's .vscode/launch.json.
 * If launchConfigName is given, finds the exact configuration by name.
 * If program is omitted, defaults to the first configuration in launch.json.
 */
export declare function resolveLaunchConfig(options: {
    workspaceDir?: string;
    launchConfigName?: string;
    program?: string;
    activeFile?: string;
}): ResolvedVsCodeLaunch | undefined;
