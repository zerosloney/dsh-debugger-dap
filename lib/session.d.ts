/**
 * Debug session state machine and the owner-scoped session registry. One
 * session owns one adapter process; every model-facing result carries a
 * snapshot so the model always knows where the debuggee is.
 */
import { AdapterUnavailableError, type AdapterSpec } from './adapters.js';
import { DapConnection, type SpawnedAdapter } from './connection.js';
import { type DapCapabilities, type DapExceptionInfo, type DapScope, type DapSetResult, type DapStackFrame, type DapThread, type DapVariable } from './protocol.js';
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
    frame?: {
        id: number;
        name: string;
        path?: string;
        line: number;
        column: number;
    };
    exitCode?: number;
    /** Breakpoints set before `configurationDone` still apply at launch. */
    configuring: boolean;
    outputChars: number;
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
}
/** Page of captured debuggee output. */
export interface OutputPage {
    text: string;
    /** Char offset the returned text starts at. */
    offset: number;
    /** Total chars captured since launch (evicted chars included). */
    totalChars: number;
    truncated: boolean;
}
/** Domain error with a stable code the tool layer can render. */
export declare class DebugError extends Error {
    readonly code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments';
    constructor(code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments', message: string);
}
/** Spawn hook, injectable for tests. */
export type SpawnAdapterFn = (spec: AdapterSpec) => SpawnedAdapter;
/** One live debug session: adapter connection plus folded state. */
export declare class DebugSession {
    readonly id: string;
    readonly adapterId: string;
    readonly program: string;
    private readonly spawned;
    private readonly limits;
    status: DebugStatus;
    stopReason: string | undefined;
    exitCode: number | undefined;
    activeThreadId: number | undefined;
    currentFrame: DapStackFrame | undefined;
    capabilities: DapCapabilities;
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
    constructor(id: string, adapterId: string, program: string, spawned: SpawnedAdapter, limits: SessionLimits);
    get connection(): DapConnection;
    /** Record the launch cwd for snapshots. */
    noteCwd(cwd: string | undefined): void;
    /** Wire all event folds; must run before {@link launch} or {@link attach}. */
    wireEvents(): void;
    /**
     * Full DAP launch handshake: initialize → launch → wait `initialized` →
     * `configurationDone` → optionally wait the entry stop. Enriches adapter
     * exit failures with the adapter's stderr tail.
     */
    /**
     * Shared DAP start handshake: initialize → (launch|attach) → wait `initialized`
     * → `configurationDone` → optionally wait the entry/attach stop. Enriches
     * adapter exit failures with the adapter's stderr tail.
     */
    private start;
    /** Launch a program under the adapter, optionally stopping at entry. */
    launch(options: {
        args?: readonly string[];
        cwd?: string;
        stopOnEntry: boolean;
        launchArgs?: Record<string, unknown>;
        stopOnEntryKey?: string;
        signal?: AbortSignal;
    }): Promise<DebugSnapshot>;
    /** Attach to an already-running process by pid. */
    attach(options: {
        processId: number;
        args?: readonly string[];
        cwd?: string;
        stopOnEntry: boolean;
        launchArgs?: Record<string, unknown>;
        stopOnEntryKey?: string;
        signal?: AbortSignal;
    }): Promise<DebugSnapshot>;
    /** Replace one file's breakpoint set; DAP setBreakpoints is per-source replace-all. */
    setBreakpoints(file: string, lines: readonly {
        line: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
    }[], signal?: AbortSignal): Promise<BreakpointRecord[]>;
    /** Continue or step; resolves at the next stop, termination, or deadline. */
    resume(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', signal?: AbortSignal): Promise<StepOutcome>;
    /** Fresh status read; defeats unsound property narrowing across awaits. */
    private readStatus;
    /** List debuggee threads. */
    threads(signal?: AbortSignal): Promise<DapThread[]>;
    /** Stack frames for one thread, bounded by `maxStackFrames`. */
    stackTrace(levels: number, signal?: AbortSignal): Promise<DapFrameView[]>;
    /** Scopes for one frame; defaults to the current stop location's top frame. */
    scopes(frameId: number | undefined, signal?: AbortSignal): Promise<DapScope[]>;
    /** Variables for one reference, bounded by `maxVariables`. */
    variables(variablesReference: number, signal?: AbortSignal): Promise<{
        variables: DapVariable[];
        omitted: number;
    }>;
    /** Evaluate one expression in a frame context. */
    evaluate(expression: string, frameId: number | undefined, context: string | undefined, signal?: AbortSignal): Promise<{
        result: string;
        type?: string;
        variablesReference: number;
    }>;
    /** Set one variable under a variablesReference. */
    setVariable(variablesReference: number, name: string, value: string, signal?: AbortSignal): Promise<DapSetResult>;
    /** Assign an expression in a frame context. */
    setExpression(expression: string, value: string, frameId: number | undefined, context: string | undefined, signal?: AbortSignal): Promise<DapSetResult>;
    /** Replace the function-breakpoint set (name/condition/hitCondition). */
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
    /** Configure which exceptions break. Uses `filterOptions` when supported. */
    setExceptionBreakpoints(filters: readonly string[], filterOptions: unknown[] | undefined, signal?: AbortSignal): Promise<void>;
    /** Fetch details of the exception that caused the current stop. */
    exceptionInfo(threadId: number | undefined, signal?: AbortSignal): Promise<DapExceptionInfo>;
    /** Read a page of captured debuggee output. */
    readOutput(request?: {
        offset?: number;
        maxChars?: number;
    }): OutputPage;
    /** Snapshot of the current session state. */
    snapshot(): DebugSnapshot;
    /** Graceful disconnect then hard kill; idempotent. */
    disconnect(terminateDebuggee: boolean): Promise<void>;
    private finishConfiguration;
    private resolveThreadId;
    private refreshLocation;
    private waitForEvent;
    private waitForStop;
    private wakeStopWaiter;
    private appendOutput;
}
/** Public frame view with an optional source path. */
export interface DapFrameView {
    id: number;
    name: string;
    path?: string;
    line: number;
    column: number;
}
/** One launch request as handed to the manager. */
export interface ManagerLaunchRequest {
    adapterId?: string;
    program: string;
    args?: readonly string[];
    cwd?: string;
    stopOnEntry?: boolean;
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
    });
    /** Spawn one adapter, run the launch handshake, and register the session. */
    launch(owner: object, request: ManagerLaunchRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    /** Spawn one adapter, run the attach handshake, and register the session. */
    attach(owner: object, request: ManagerAttachRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    /** Resolve the owner's active session or the explicit id; enforces ownership. */
    sessionFor(owner: object, id?: string): DebugSession;
    /** Snapshots of every session the owner still holds. */
    list(owner: object): DebugSnapshot[];
    /** Disconnect one (default: active) session. */
    disconnect(owner: object, id: string | undefined, terminateDebuggee: boolean): Promise<DebugSnapshot | undefined>;
    /** Tear down every session; the plugin-unload path. */
    disposeAll(): Promise<void>;
    private tryActive;
}
/** Re-exported so the tool layer can catch adapter resolution failures uniformly. */
export { AdapterUnavailableError };
