/**
 * Adapter recipes: built-in stdio DAP adapters (debugpy, dlv) plus
 * config-declared rows, resolved against PATH with actionable install hints.
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
}
/** One `adapters` config row. */
export interface AdapterConfigEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Extra per-adapter fields spread into the DAP `launch` request body. */
    launchArgs?: Record<string, unknown>;
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
