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
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Default ledger path: ~/.dsh-debugger-dap/ledger.jsonl */
export const DEFAULT_LEDGER_PATH = join(homedir(), '.dsh-debugger-dap', 'ledger.jsonl');
/** Every ledger event kind (single source of truth for argument validation and docs). */
export const LEDGER_KINDS = ['session_start', 'session_end', 'breakpoints_set', 'breakpoint_hit', 'exception', 'stop', 'request_error'];
const MEMORY_CAP = 5000;
const QUERY_LIMIT_MAX = 500;
export class DebugLedger {
    filePath;
    maxFileBytes;
    entries = [];
    seq = 0;
    writeErrors = 0;
    /** The directory only needs creating once; reset on write failure so the next record retries. */
    dirEnsured = false;
    constructor(filePath, maxFileBytes) {
        this.filePath = filePath;
        this.maxFileBytes = maxFileBytes;
    }
    /** Create the ledger; an empty path uses the default, the directory is created on first write. */
    static create(options) {
        const filePath = options?.path !== undefined && options.path.length > 0 ? options.path : DEFAULT_LEDGER_PATH;
        const maxFileBytes = options?.maxFileBytes ?? 5 * 1024 * 1024;
        return new DebugLedger(filePath, maxFileBytes);
    }
    /** JSONL file path (human-readable / archivable). */
    get path() {
        return this.filePath;
    }
    /** Cumulative disk-write failures (0 = all succeeded). */
    get writeFailureCount() {
        return this.writeErrors;
    }
    /** Append one record: in-memory ring buffer + JSONL append (synchronous, best-effort). */
    record(sessionId, kind, detail = {}) {
        const entry = { seq: ++this.seq, ts: new Date().toISOString(), sessionId, kind, detail };
        this.entries.push(entry);
        if (this.entries.length > MEMORY_CAP) {
            this.entries.splice(0, this.entries.length - MEMORY_CAP);
        }
        try {
            if (!this.dirEnsured) {
                mkdirSync(dirname(this.filePath), { recursive: true });
                this.dirEnsured = true;
            }
            try {
                if (statSync(this.filePath).size > this.maxFileBytes) {
                    // Simple rotation: past the cap the current file is renamed to .1
                    // (replacing the previous .1) and appending continues into a fresh file.
                    renameSync(this.filePath, `${this.filePath}.1`);
                }
            }
            catch {
                // Rotation check failed (file missing or locked): keep appending, never block debugging.
            }
            appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch {
            this.dirEnsured = false;
            this.writeErrors += 1;
        }
    }
    /** Query the newest entries (returns the ascending-seq tail slice). */
    query(options) {
        let list = this.entries;
        if (options?.sessionId !== undefined)
            list = list.filter(entry => entry.sessionId === options.sessionId);
        if (options?.kinds !== undefined && options.kinds.length > 0) {
            const kinds = new Set(options.kinds);
            list = list.filter(entry => kinds.has(entry.kind));
        }
        if (options?.since !== undefined)
            list = list.filter(entry => entry.ts >= options.since);
        const limit = Math.max(1, Math.min(options?.limit ?? 50, QUERY_LIMIT_MAX));
        const truncated = list.length > limit;
        return { entries: list.slice(-limit), truncated };
    }
}
//# sourceMappingURL=ledger.js.map