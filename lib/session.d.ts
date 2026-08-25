/**
 * Debug session state machine and the owner-scoped session registry. One
 * session owns one adapter process; every model-facing result carries a
 * snapshot so the model always knows where the debuggee is.
 */
import type { AdapterSpec } from './adapters.js';
import { DapConnection, type SpawnedAdapter } from './connection.js';
import { DebugLedger, type LedgerEntry, type LedgerKind, type LedgerQuery } from './ledger.js';
import { type DapCapabilities, type DapCompletionItem, type DapDataBreakpoint, type DapDataBreakpointInfo, type DapDisassembledInstruction, type DapExceptionInfo, type DapGotoTarget, type DapLoadedSource, type DapModule, type DapReadMemoryResult, type DapScope, type DapSetResult, type DapSourceContent, type DapStackFrame, type DapThread, type DapVariable } from './protocol.js';
/** Session status as folded from DAP events. */
export type DebugStatus = 'configuring' | 'running' | 'stopped' | 'terminated';
/** Tunables carried from plugin config into every session. */
export interface SessionLimits {
    requestTimeoutMs: number;
    stepTimeoutMs: number;
    maxOutputChars: number;
    maxStackFrames: number;
    maxVariables: number;
    maxResultChars: number;
}
/** Where the debuggee currently is; part of every model-facing result. */
export interface DebugSnapshot {
    id: string;
    adapter: string;
    program: string;
    cwd?: string;
    status: DebugStatus;
    stopReason?: string;
    threadId?: number;
    /** Whether the last stop halted every thread (allThreadsStopped). */
    allThreadsStopped?: boolean;
    frame?: {
        id: number;
        name: string;
        path?: string;
        line: number;
        column: number;
    };
    exitCode?: number;
    configuring: boolean;
    outputChars: number;
    /** Latest watch expression results (id → value/error). */
    watches?: Array<{
        id: string;
        expression: string;
        value?: string;
        error?: string;
    }>;
    /** Exception details if stopped due to an exception. */
    exceptionDetails?: {
        exceptionId: string;
        description?: string;
        breakMode?: string;
        message?: string;
        typeName?: string;
        stack?: string;
    };
    /** Multi-thread summary overview when more than 1 thread is active. */
    threadsSummary?: Array<{
        id: number;
        name: string;
        stopped?: boolean;
        reason?: string;
    }>;
    /** Adapter capabilities relevant to model decisions, from the initialize handshake. */
    capabilities?: {
        set_variable?: boolean;
        set_expression?: boolean;
        restart?: boolean;
        data_breakpoints?: boolean;
        goto_targets?: boolean;
        restart_frame?: boolean;
        loaded_sources?: boolean;
        modules?: boolean;
        exception_info?: boolean;
        step_back?: boolean;
        terminate?: boolean;
        disassemble?: boolean;
        read_memory?: boolean;
        completions?: boolean;
    };
}
/** One breakpoint as resolved by the adapter. */
export interface BreakpointRecord {
    line: number;
    verified: boolean;
    message?: string;
    actualLine?: number;
}
/** Outcome of a resume-class action (continue / step / pause). */
export interface StepOutcome {
    state: 'stopped' | 'running' | 'terminated';
    timedOut: boolean;
    snapshot: DebugSnapshot;
    /** New debuggee output since the last read (incremental tail). */
    output?: OutputPage;
}
/** Page of captured debuggee output. */
export interface OutputPage {
    text: string;
    offset: number;
    totalChars: number;
    truncated: boolean;
}
/** Domain error with a stable code the tool layer can render. */
export declare class DebugError extends Error {
    readonly code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments' | 'not_supported' | 'adapter_error' | 'timeout' | 'disconnected';
    constructor(code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments' | 'not_supported' | 'adapter_error' | 'timeout' | 'disconnected', message: string);
}
export type SpawnAdapterFn = (spec: AdapterSpec) => SpawnedAdapter | Promise<SpawnedAdapter>;
/** One live debug session: adapter connection plus folded state. */
export declare class DebugSession {
    readonly id: string;
    readonly adapterId: string;
    readonly program: string;
    private readonly spawned;
    private readonly limits;
    /** Whether this session launched its own debuggee ('launch') or attached to a foreign one ('attach'). */
    readonly launchMode: 'launch' | 'attach';
    /** Optional session trace ledger; absent = no recording. */
    private readonly ledger?;
    /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
    private readonly exceptionFilterMap?;
    status: DebugStatus;
    stopReason: string | undefined;
    exitCode: number | undefined;
    activeThreadId: number | undefined;
    currentFrame: DapStackFrame | undefined;
    capabilities: DapCapabilities;
    /** Whether the last stop halted every thread (allThreadsStopped). */
    allThreadsStopped: boolean | undefined;
    exceptionDetails: {
        exceptionId: string;
        description?: string;
        breakMode?: string;
        message?: string;
        typeName?: string;
        stack?: string;
    } | undefined;
    threadsSummary: Array<{
        id: number;
        name: string;
        stopped?: boolean;
        reason?: string;
    }> | undefined;
    private stopReasonDescription;
    private configurationDoneSent;
    private readonly outputLines;
    private outputChars;
    private evictedChars;
    private stopWaiter;
    private readonly breakpointsByFile;
    private readonly detach;
    private disposed;
    private cwdValue;
    private initializedSeen;
    private multipleThreadsSeen;
    private lastActivityAt;
    /** Session creation time; also the ledger's duration baseline. */
    private readonly startedAt;
    /** Whether a session_end ledger entry was already written (write-once). */
    private ledgerEnded;
    /** Monotonic creation order, so LRU eviction is stable when timestamps tie. */
    readonly createdSeq: number;
    /** Absolute char offset up to which output has been consumed by the model. */
    private outputReadOffset;
    /** Watch id → expression; evaluated on every stop. */
    private readonly watches;
    /** Latest watch results (id → { value, error }). */
    private readonly watchResults;
    private nextWatchId;
    constructor(id: string, adapterId: string, program: string, spawned: SpawnedAdapter, limits: SessionLimits, 
    /** Whether this session launched its own debuggee ('launch') or attached to a foreign one ('attach'). */
    launchMode: 'launch' | 'attach', createdSeq: number, 
    /** Optional session trace ledger; absent = no recording. */
    ledger?: DebugLedger | undefined, 
    /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
    exceptionFilterMap?: Record<string, string> | undefined);
    get connection(): DapConnection;
    noteCwd(cwd: string | undefined): void;
    /** Refresh the idle clock; called by every model-facing action. */
    touch(): void;
    /**
     * Best-effort ledger write for this session; no-op without a ledger.
     * @param kind - event kind (session_start / breakpoint_hit / ...).
     * @param detail - JSON-safe detail object.
     */
    recordLedger(kind: LedgerKind, detail?: Record<string, unknown>): void;
    /**
     * Ledger: record a stop. For breakpoint/exception stops, best-effort
     * enrich with the top frame location (one lightweight stackTrace request,
     * never blocking the stop pipeline and never failing the debug flow).
     */
    private recordStopLedger;
    /** Ledger: write the session_end entry exactly once. */
    private endLedger;
    /** Milliseconds since the last activity. */
    idleMs(): number;
    wireEvents(): void;
    private start;
    launch(options: {
        args?: readonly string[];
        cwd?: string;
        stopOnEntry: boolean;
        launchArgs?: Record<string, unknown>;
        stopOnEntryKey?: string;
        signal?: AbortSignal;
    }): Promise<DebugSnapshot>;
    attach(options: {
        processId: number;
        args?: readonly string[];
        cwd?: string;
        stopOnEntry: boolean;
        launchArgs?: Record<string, unknown>;
        stopOnEntryKey?: string;
        signal?: AbortSignal;
    }): Promise<DebugSnapshot>;
    setBreakpoints(file: string, lines: readonly {
        line: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
    }[], signal?: AbortSignal): Promise<BreakpointRecord[]>;
    resume(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'reverseContinue', signal?: AbortSignal, options?: {
        threadId?: number;
        singleThread?: boolean;
    }): Promise<StepOutcome>;
    /** Output produced since the last consumed offset (empty when nothing new). */
    private takeIncrementalOutput;
    private readStatus;
    threads(signal?: AbortSignal): Promise<DapThread[]>;
    /** Switch the session's focus thread; later steps and stack_trace use it. */
    selectThread(threadId: number, signal?: AbortSignal): Promise<void>;
    /** Step backwards (requires adapter supportsStepBack); waits for the next stop. */
    stepBack(signal?: AbortSignal, options?: {
        threadId?: number;
        singleThread?: boolean;
    }): Promise<StepOutcome>;
    /** Add or replace a watch expression; returns its id. */
    addWatch(expression: string): string;
    removeWatch(id: string): boolean;
    listWatches(): Array<{
        id: string;
        expression: string;
        value?: string;
        error?: string;
    }>;
    /** Evaluate every watch in the current frame; failures are captured per watch. */
    evaluateWatches(signal?: AbortSignal): Promise<void>;
    stackTrace(levels: number, signal?: AbortSignal): Promise<DapFrameView[]>;
    scopes(frameId: number | undefined, signal?: AbortSignal): Promise<DapScope[]>;
    variables(variablesReference: number, signal?: AbortSignal, paging?: {
        start?: number;
        count?: number;
        filter?: 'indexed' | 'named';
        hex?: boolean;
    }): Promise<{
        variables: DapVariable[];
        omitted: number;
    }>;
    evaluate(expression: string, frameId: number | undefined, context: string | undefined, signal?: AbortSignal, options?: {
        hex?: boolean;
    }): Promise<{
        result: string;
        type?: string;
        variablesReference: number;
    }>;
    setVariable(variablesReference: number, name: string, value: string, signal?: AbortSignal): Promise<DapSetResult>;
    setExpression(expression: string, value: string, frameId: number | undefined, context: string | undefined, signal?: AbortSignal): Promise<DapSetResult>;
    setFunctionBreakpoints(functions: readonly {
        name: string;
        condition?: string;
        hitCondition?: string;
    }[], signal?: AbortSignal): Promise<{
        name: string;
        verified: boolean;
        line?: number;
        message?: string;
    }[]>;
    setExceptionBreakpoints(filters: readonly string[], filterOptions: unknown[] | undefined, signal?: AbortSignal): Promise<void>;
    exceptionInfo(threadId: number | undefined, signal?: AbortSignal): Promise<DapExceptionInfo>;
    restart(signal?: AbortSignal): Promise<DebugSnapshot>;
    source(signal?: AbortSignal, sourceReference?: number): Promise<DapSourceContent>;
    loadedSources(signal?: AbortSignal): Promise<DapLoadedSource[]>;
    modules(signal?: AbortSignal, paging?: {
        start?: number;
        count?: number;
    }): Promise<DapModule[]>;
    dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number, signal?: AbortSignal): Promise<DapDataBreakpointInfo>;
    setDataBreakpoints(breakpoints: readonly {
        dataId?: string;
        address?: string;
        name?: string;
        variablesReference?: number;
        frameId?: number;
        accessType?: 'read' | 'write' | 'readWrite';
        condition?: string;
        hitCondition?: string;
    }[], signal?: AbortSignal): Promise<DapDataBreakpoint[]>;
    gotoTargets(targetLine: number, signal?: AbortSignal): Promise<DapGotoTarget[]>;
    goto(targetId: number, signal?: AbortSignal): Promise<DebugSnapshot>;
    restartFrame(frameId: number | undefined, signal?: AbortSignal): Promise<DebugSnapshot>;
    disassemble(memoryReference: string, instructionCount: number, options?: {
        offset?: number;
        instructionOffset?: number;
        resolveSymbols?: boolean;
    }, signal?: AbortSignal): Promise<DapDisassembledInstruction[]>;
    readMemory(memoryReference: string, count: number, offset?: number, signal?: AbortSignal): Promise<DapReadMemoryResult>;
    completions(text: string, column: number, frameId?: number, line?: number, signal?: AbortSignal): Promise<DapCompletionItem[]>;
    terminate(restart?: boolean, signal?: AbortSignal): Promise<DebugSnapshot>;
    readOutput(request?: {
        offset?: number;
        maxChars?: number;
    }): OutputPage;
    /** Mark output consumed up to `offset` (or the current tail); incremental reads start there. */
    markOutputRead(offset?: number): void;
    snapshot(): DebugSnapshot;
    disconnect(terminateDebuggee: boolean): Promise<void>;
    private finishConfiguration;
    private resolveThreadId;
    /** Error for actions that need live state on a debuggee that has exited. */
    private exitedError;
    private refreshLocation;
    private waitForEvent;
    private waitForStop;
    /**
     * {@link waitForStop} for waiters registered before their paired request is
     * sent (resume/restart/goto/start). When that request rejects first — e.g.
     * one abort fires both the request's and the waiter's onAbort — the
     * never-awaited waiter would surface as an unhandled rejection. Mark its
     * rejection handled here; callers that reach their own `await` still see it.
     */
    private registerStopWaiter;
    private wakeStopWaiter;
    private appendOutput;
}
/** Public frame view with an optional source path. */
export interface DapFrameView {
    id: number;
    name: string;
    path?: string;
    sourceReference?: number;
    line: number;
    column: number;
}
/** One launch request as handed to the manager. */
export interface ManagerLaunchRequest {
    adapterId?: string;
    program: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
    extraLaunchArgs?: Record<string, unknown>;
}
/** One attach request as handed to the manager. */
export interface ManagerAttachRequest {
    adapterId?: string;
    program?: string;
    processId: number;
    args?: readonly string[];
    cwd?: string;
    stopOnEntry?: boolean;
}
/** Owner-scoped registry of live debug sessions. */
export declare class DebugSessionManager {
    private readonly deps;
    private nextId;
    private readonly sessions;
    private readonly activeByOwner;
    constructor(deps: {
        spawn: SpawnAdapterFn;
        resolveAdapter: (options: {
            adapter?: string;
            program: string;
        }) => AdapterSpec;
        limits: SessionLimits;
        /** Idle time after which a session is auto-disconnected; 0 disables. Default 30 minutes. */
        sessionIdleTimeoutMs?: number;
        /** Max live sessions per owner; beyond this, the oldest is evicted. Default 5. */
        maxSessionsPerOwner?: number;
        /** Session trace ledger; absent = default path ~/.dsh-debugger-dap/ledger.jsonl. */
        ledger?: DebugLedger;
    });
    private reaper;
    private readonly maxPerOwner;
    /** Session trace ledger backing every session; never null (default file path). */
    private readonly ledger;
    launch(owner: object, request: ManagerLaunchRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    attach(owner: object, request: ManagerAttachRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    sessionFor(owner: object, id?: string): DebugSession;
    list(owner: object): DebugSnapshot[];
    /** Query the session trace ledger (跨会话、跨重启可回溯)。 */
    ledgerQuery(options?: LedgerQuery): {
        entries: LedgerEntry[];
        truncated: boolean;
    };
    /** Ledger: record one model-action failure with its stable error code. */
    recordError(error: unknown, sessionId?: string): void;
    disconnect(owner: object, id: string | undefined, terminateDebuggee: boolean): Promise<DebugSnapshot | undefined>;
    disposeAll(): Promise<void>;
    private tryActive;
    /** Disconnect sessions idle longer than `idleMs`. */
    private reapIdle;
    /** Evict the oldest session beyond the per-owner cap, if any. */
    private evictIfOverLimit;
}
/** Re-exported so the tool layer can catch adapter resolution failures uniformly. */
export { AdapterUnavailableError } from './adapters.js';
