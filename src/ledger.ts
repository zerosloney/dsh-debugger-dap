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

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default ledger path: ~/.dsh-debugger-dap/ledger.jsonl */
export const DEFAULT_LEDGER_PATH = join(homedir(), '.dsh-debugger-dap', 'ledger.jsonl')

export type LedgerKind =
  | 'session_start'
  | 'session_end'
  | 'breakpoints_set'
  | 'breakpoint_hit'
  | 'exception'
  | 'stop'
  | 'request_error'

/** Every ledger event kind (single source of truth for argument validation and docs). */
export const LEDGER_KINDS = ['session_start', 'session_end', 'breakpoints_set', 'breakpoint_hit', 'exception', 'stop', 'request_error'] as const satisfies readonly LedgerKind[]

/** One ledger record (JSON-safe; written as one JSONL line). */
export interface LedgerEntry {
  /** In-process monotonic sequence; also the disk write order. */
  readonly seq: number
  /** ISO-8601 timestamp. */
  readonly ts: string
  /** Owning session id; undefined for request-level errors with no session. */
  readonly sessionId: string | undefined
  readonly kind: LedgerKind
  readonly detail: Record<string, unknown>
}

export interface LedgerQuery {
  /** Restrict to one session; default: all sessions. */
  sessionId?: string
  /** Restrict to these kinds; empty/absent: all kinds. */
  kinds?: readonly LedgerKind[]
  /** Only entries with ts >= since (ISO-8601 string comparison). */
  since?: string
  /** Max entries returned (default 50, max 500); the newest N are kept. */
  limit?: number
}

const MEMORY_CAP = 5000
const QUERY_LIMIT_MAX = 500

export class DebugLedger {
  private readonly entries: LedgerEntry[] = []
  private seq = 0
  private writeErrors = 0
  /** The directory only needs creating once; reset on write failure so the next record retries. */
  private dirEnsured = false

  private constructor(
    private readonly filePath: string,
    private readonly maxFileBytes: number,
  ) {}

  /** Create the ledger; an empty path uses the default, the directory is created on first write. */
  static create(options?: { path?: string; maxFileBytes?: number }): DebugLedger {
    const filePath = options?.path !== undefined && options.path.length > 0 ? options.path : DEFAULT_LEDGER_PATH
    const maxFileBytes = options?.maxFileBytes ?? 5 * 1024 * 1024
    return new DebugLedger(filePath, maxFileBytes)
  }

  /** JSONL file path (human-readable / archivable). */
  get path(): string {
    return this.filePath
  }

  /** Cumulative disk-write failures (0 = all succeeded). */
  get writeFailureCount(): number {
    return this.writeErrors
  }

  /** Append one record: in-memory ring buffer + JSONL append (synchronous, best-effort). */
  record(sessionId: string | undefined, kind: LedgerKind, detail: Record<string, unknown> = {}): void {
    const entry: LedgerEntry = { seq: ++this.seq, ts: new Date().toISOString(), sessionId, kind, detail }
    this.entries.push(entry)
    if (this.entries.length > MEMORY_CAP) {
      this.entries.splice(0, this.entries.length - MEMORY_CAP)
    }
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.filePath), { recursive: true })
        this.dirEnsured = true
      }
      try {
        if (statSync(this.filePath).size > this.maxFileBytes) {
          // Simple rotation: past the cap the current file is renamed to .1
          // (replacing the previous .1) and appending continues into a fresh file.
          renameSync(this.filePath, `${this.filePath}.1`)
        }
      } catch {
        // Rotation check failed (file missing or locked): keep appending, never block debugging.
      }
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      this.dirEnsured = false
      this.writeErrors += 1
    }
  }

  /** Query the newest entries (returns the ascending-seq tail slice). */
  query(options?: LedgerQuery): { entries: LedgerEntry[]; truncated: boolean } {
    let list: readonly LedgerEntry[] = this.entries
    if (options?.sessionId !== undefined) list = list.filter(entry => entry.sessionId === options.sessionId)
    if (options?.kinds !== undefined && options.kinds.length > 0) {
      const kinds = new Set(options.kinds)
      list = list.filter(entry => kinds.has(entry.kind))
    }
    if (options?.since !== undefined) list = list.filter(entry => entry.ts >= options.since!)
    const limit = Math.max(1, Math.min(options?.limit ?? 50, QUERY_LIMIT_MAX))
    const truncated = list.length > limit
    return { entries: list.slice(-limit), truncated }
  }
}
