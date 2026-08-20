/**
 * Adapter recipes: built-in DAP adapters (debugpy, dlv, netcoredbg,
 * lldb-dap, js-debug, codelldb) plus config-declared rows, resolved
 * against PATH with actionable install hints.
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
    /** Transport layer. Default `'stdio'`; `'tcp'` means the adapter is reached over TCP. */
    transport?: 'stdio' | 'tcp';
    /** Target host for `'tcp'` transport (default `'127.0.0.1'`). */
    host?: string;
    /** Target port for `'tcp'` transport. */
    port?: number;
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
    /** Transport layer for this recipe: 'stdio' (default) or 'tcp'. */
    transport?: 'stdio' | 'tcp';
    /** Config row replacing the built-in definition, when present. */
    configOverride?: AdapterConfigEntry;
}
/** Failed adapter resolution with the actionable message to surface. */
export declare class AdapterUnavailableError extends Error {
    constructor(message: string);
}
/** Resolved launch request for {@link spawnDapAdapter}. */
export declare function resolveAdapter(options: {
    adapter?: string;
    program: string;
}, adapterConfig: Record<string, AdapterConfigEntry> | undefined, commandExists?: (command: string) => boolean): AdapterSpec;
/**
 * Default PATH probe. Absolute paths are checked directly; bare names are
 * probed against every PATH directory with the platform executable suffixes.
 */
export declare function defaultCommandExists(command: string): boolean;
