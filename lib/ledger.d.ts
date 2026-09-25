/**
 * Debug session ledger: appends one JSON line per key debug event to a
 * persistent JSONL file and serves in-process queries for later forensics.
 *
 * Event kinds (LedgerKind):
 *  - session_start    session created (launch/attach, adapter, program, cwd)
 *  - session_end      session ended (disconnect / adapter close / debuggee exit)
 *  - breakpoints_set  breakpoints configured (file + lines + verified count)
 *  - breakpoint_hit   breakpoint reached (reason=breakpoint, best-effort top-frame location)
 *  - exception        exception stop (reason=exception, best-effort location/description)
 *  - stop             any other stop (step/pause/entry, ...)
 *  - request_error    model action failed (stable error code + message)
 *
 * Design constraint: the ledger is a best-effort side channel — write
 * failures never affect the debug flow itself; only writeFailureCount
 * accumulates for diagnostics.
 */
/** Default ledger path: ~/.dsh-debugger-dap/ledger.jsonl */
export declare const DEFAULT_LEDGER_PATH: string;
export type LedgerKind = 'session_start' | 'session_end' | 'breakpoints_set' | 'breakpoint_hit' | 'exception' | 'stop' | 'request_error';
/** Every ledger event kind (single source of truth for argument validation and docs). */
export declare const LEDGER_KINDS: readonly ["session_start", "session_end", "breakpoints_set", "breakpoint_hit", "exception", "stop", "request_error"];
/** One ledger record (JSON-safe; written as one JSONL line). */
export interface LedgerEntry {
    /** In-process monotonic sequence; also the disk write order. */
    readonly seq: number;
    /** ISO-8601 timestamp. */
    readonly ts: string;
    /** Owning session id; undefined for request-level errors with no session. */
    readonly sessionId: string | undefined;
    readonly kind: LedgerKind;
    readonly detail: Record<string, unknown>;
}
export interface LedgerQuery {
    /** Restrict to one session; default: all sessions. */
    sessionId?: string;
    /** Restrict to these kinds; empty/absent: all kinds. */
    kinds?: readonly LedgerKind[];
    /** Only entries with ts >= since (ISO-8601 string comparison). */
    since?: string;
    /** Max entries returned (default 50, max 500); the newest N are kept. */
    limit?: number;
}
export declare class DebugLedger {
    private readonly filePath;
    private readonly maxFileBytes;
    private readonly entries;
    private seq;
    private writeErrors;
    /** The directory only needs creating once; reset on write failure so the next record retries. */
    private dirEnsured;
    private constructor();
    /** Create the ledger; an empty path uses the default, the directory is created on first write. */
    static create(options?: {
        path?: string;
        maxFileBytes?: number;
    }): DebugLedger;
    /** JSONL file path (human-readable / archivable). */
    get path(): string;
    /** Cumulative disk-write failures (0 = all succeeded). */
    get writeFailureCount(): number;
    /** Append one record: in-memory ring buffer + JSONL append (synchronous, best-effort). */
    record(sessionId: string | undefined, kind: LedgerKind, detail?: Record<string, unknown>): void;
    /** Query the newest entries (returns the ascending-seq tail slice). */
    query(options?: LedgerQuery): {
        entries: LedgerEntry[];
        truncated: boolean;
    };
}
