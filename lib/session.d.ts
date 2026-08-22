/**
 * Debug session state machine and the owner-scoped session registry. One
 * session owns one adapter process; every model-facing result carries a
 * snapshot so the model always knows where the debuggee is.
 */
import { AdapterUnavailableError, type AdapterSpec } from './adapters.js';
import { DapConnection, type SpawnedAdapter } from './connection.js';
import { type DapCapabilities, type DapDataBreakpoint, type DapExceptionInfo, type DapGotoTarget, type DapLoadedSource, type DapModule, type DapScope, type DapSetResult, type DapSourceContent, type DapStackFrame, type DapThread, type DapVariable } from './protocol.js';
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
    offset: number;
    totalChars: number;
    truncated: boolean;
}
/** Domain error with a stable code the tool layer can render. */
export declare class DebugError extends Error {
    readonly code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments' | 'not_supported';
    constructor(code: 'no_session' | 'no_active_session' | 'foreign_session' | 'not_stopped' | 'no_thread' | 'invalid_arguments' | 'not_supported', message: string);
}
export type SpawnAdapterFn = (spec: AdapterSpec) => SpawnedAdapter | Promise<SpawnedAdapter>;
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
    noteCwd(cwd: string | undefined): void;
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
    resume(action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause', signal?: AbortSignal): Promise<StepOutcome>;
    private readStatus;
    threads(signal?: AbortSignal): Promise<DapThread[]>;
    stackTrace(levels: number, signal?: AbortSignal): Promise<DapFrameView[]>;
    scopes(frameId: number | undefined, signal?: AbortSignal): Promise<DapScope[]>;
    variables(variablesReference: number, signal?: AbortSignal): Promise<{
        variables: DapVariable[];
        omitted: number;
    }>;
    evaluate(expression: string, frameId: number | undefined, context: string | undefined, signal?: AbortSignal): Promise<{
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
    source(signal?: AbortSignal): Promise<DapSourceContent>;
    loadedSources(signal?: AbortSignal): Promise<DapLoadedSource[]>;
    modules(signal?: AbortSignal): Promise<DapModule[]>;
    setDataBreakpoints(breakpoints: readonly {
        address?: string;
        name?: string;
        accessType?: 'read' | 'write' | 'readWrite';
    }[], signal?: AbortSignal): Promise<DapDataBreakpoint[]>;
    gotoTargets(targetLine: number, signal?: AbortSignal): Promise<DapGotoTarget[]>;
    goto(targetId: number, signal?: AbortSignal): Promise<DebugSnapshot>;
    restartFrame(frameId: number | undefined, signal?: AbortSignal): Promise<void>;
    readOutput(request?: {
        offset?: number;
        maxChars?: number;
    }): OutputPage;
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
    launch(owner: object, request: ManagerLaunchRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    attach(owner: object, request: ManagerAttachRequest, signal?: AbortSignal): Promise<DebugSnapshot>;
    sessionFor(owner: object, id?: string): DebugSession;
    list(owner: object): DebugSnapshot[];
    disconnect(owner: object, id: string | undefined, terminateDebuggee: boolean): Promise<DebugSnapshot | undefined>;
    disposeAll(): Promise<void>;
    private tryActive;
}
/** Re-exported so the tool layer can catch adapter resolution failures uniformly. */
export { AdapterUnavailableError };
