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
/** Root directory for adapters installed by this plugin. */
export declare const MANAGED_ADAPTERS_ROOT: string;
/** Marker file identifying a directory that holds installed adapter binaries. */
export declare const ADAPTER_BIN_MARKER = ".dsh-adapter-bin";
/** Adapter ids {@link installAdapter} knows how to install. */
export declare const INSTALLABLE_ADAPTERS: readonly ["debugpy", "dlv", "netcoredbg"];
export type InstallableAdapter = (typeof INSTALLABLE_ADAPTERS)[number];
/** Default per-step timeout (pip / go install / release download). */
export declare const DEFAULT_INSTALL_TIMEOUT_MS: number;
/**
 * Directories that hold adapter binaries installed by this plugin: the
 * session additions (fresh installs) plus a lazily-scanned, per-process
 * cached walk of {@link MANAGED_ADAPTERS_ROOT}.
 */
export declare function managedBinDirs(): string[];
/** Register a freshly installed adapter binary directory for this process. */
export declare function addManagedBinDir(dir: string): void;
/** Forget cached scans and session additions (tests). */
export declare function resetManagedBinDirs(): void;
/**
 * Walk `root` (depth-limited) and return every directory containing the
 * {@link ADAPTER_BIN_MARKER} marker file. Pure FS convention: what the
 * previous host run installed, this run rediscovers.
 */
export declare function scanManagedBinDirs(root?: string): string[];
export interface RunResult {
    code: number | null;
    output: string;
}
export type RunCommandFn = (argv: readonly string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}) => Promise<RunResult>;
/** Spawn one command, capture stdout+stderr as a bounded tail, never throws. */
export declare const runCommand: RunCommandFn;
/** Whether `name` resolves as an executable on PATH or in a managed dir. */
export declare function probeExecutable(name: string): boolean;
export interface InstallOutcome {
    adapter: InstallableAdapter;
    alreadyInstalled: boolean;
    installed: boolean;
    /** The launchable command line after installation (best effort). */
    command?: string;
    /** Bounded install output tail (empty when nothing ran). */
    output: string;
}
/** Injectable seams so tests drive the flows without pip/go/network. */
export interface InstallDeps {
    runCommand?: RunCommandFn;
    /** Executable probe (PATH + managed dirs); defaults to {@link probeExecutable}. */
    probe?: (name: string) => boolean;
    /** Fetch a URL as text (GitHub API metadata). */
    fetchText?: (url: string, timeoutMs: number) => Promise<string>;
    /** Download a URL into a file. */
    download?: (url: string, destFile: string, timeoutMs: number) => Promise<void>;
    /** Extract an archive into a directory. */
    extract?: (archive: string, destDir: string) => Promise<void>;
}
export interface InstallOptions {
    deps?: InstallDeps;
    timeoutMs?: number;
    /** Override the managed root (tests). */
    managedRoot?: string;
}
/** netcoredbg asset name per platform, or an error naming the manual URL. */
export declare function netcoredbgAsset(): string;
/**
 * Install (or report) one adapter. Throws on failure with the bounded
 * output tail embedded; resolves with {@link InstallOutcome} on success
 * (including the `alreadyInstalled` short-circuit).
 */
export declare function installAdapter(adapter: string, options?: InstallOptions): Promise<InstallOutcome>;
