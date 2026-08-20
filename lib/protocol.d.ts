/**
 * Minimal Debug Adapter Protocol wire vocabulary. Only the operations and
 * payloads this plugin exchanges are modeled; every body is read defensively
 * because adapter output is an untrusted process boundary.
 */
/** Base fields shared by every DAP message. */
interface DapMessageBase {
    seq?: number;
    type?: string;
}
/** Client-to-adapter request. */
export interface DapRequest extends DapMessageBase {
    type: 'request';
    command: string;
    arguments?: Record<string, unknown>;
}
/** Adapter-to-client response. */
export interface DapResponse extends DapMessageBase {
    type: 'response';
    request_seq?: number;
    success?: boolean;
    command?: string;
    message?: string;
    body?: Record<string, unknown>;
}
/** Adapter-to-client event. */
export interface DapEvent extends DapMessageBase {
    type: 'event';
    event: string;
    body?: Record<string, unknown>;
}
export type DapMessage = DapRequest | DapResponse | DapEvent;
/** Classify one decoded JSON object into the DAP message union, or `undefined` when malformed. */
export declare function classifyDapMessage(message: unknown): DapMessage | undefined;
/** `initialize` response capabilities subset used by this plugin. */
export interface DapCapabilities {
    supportsConfigurationDoneRequest?: boolean;
    supportsTerminateRequest?: boolean;
    supportsRestartRequest?: boolean;
    supportsSetVariable?: boolean;
    supportsSetExpression?: boolean;
    supportsConditionalBreakpoints?: boolean;
    supportsFunctionBreakpoints?: boolean;
    supportsExceptionOptions?: boolean;
    supportsExceptionInfoRequest?: boolean;
    supportsTerminateThreadsRequest?: boolean;
}
export declare function readCapabilities(body: Record<string, unknown> | undefined): DapCapabilities;
/** `stopped` event body. */
export interface DapStoppedEvent {
    reason?: string;
    description?: string;
    threadId?: number;
    allThreadsStopped?: boolean;
    text?: string;
}
export declare function readStoppedEvent(body: Record<string, unknown> | undefined): DapStoppedEvent;
/** `output` event body. */
export interface DapOutputEvent {
    category?: string;
    output: string;
}
export declare function readOutputEvent(body: Record<string, unknown> | undefined): DapOutputEvent;
/** `exited` event body. */
export declare function readExitCode(body: Record<string, unknown> | undefined): number | undefined;
export interface DapThread {
    id: number;
    name: string;
}
export declare function readThreads(body: Record<string, unknown> | undefined): DapThread[];
export interface DapSource {
    path?: string;
    name?: string;
}
export interface DapStackFrame {
    id: number;
    name: string;
    source?: DapSource;
    line: number;
    column: number;
}
export declare function readStackFrames(body: Record<string, unknown> | undefined): DapStackFrame[];
export interface DapScope {
    name: string;
    variablesReference: number;
    expensive: boolean;
    namedVariables?: number;
    indexedVariables?: number;
}
export declare function readScopes(body: Record<string, unknown> | undefined): DapScope[];
export interface DapVariable {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
    namedVariables?: number;
    indexedVariables?: number;
}
export declare function readVariables(body: Record<string, unknown> | undefined): DapVariable[];
export interface DapEvaluation {
    result: string;
    type?: string;
    variablesReference: number;
}
export declare function readEvaluation(body: Record<string, unknown> | undefined): DapEvaluation;
/** Shared result shape of `setVariable` / `setExpression` and `evaluate`. */
export interface DapSetResult {
    value: string;
    type?: string;
    variablesReference: number;
}
export declare function readSetResult(body: Record<string, unknown> | undefined): DapSetResult;
/** `exceptionInfo` response. */
export interface DapExceptionInfo {
    exceptionId: string;
    description?: string;
    breakMode?: string;
    message?: string;
    typeName?: string;
    stack?: string;
}
export declare function readExceptionInfo(body: Record<string, unknown> | undefined): DapExceptionInfo;
/** One resolved breakpoint as reported by the adapter. */
export interface DapBreakpoint {
    verified: boolean;
    line?: number;
    message?: string;
}
export declare function readBreakpoints(body: Record<string, unknown> | undefined): DapBreakpoint[];
export declare function readString(value: unknown): string | undefined;
export declare function readNumber(value: unknown): number | undefined;
export declare function readBoolean(value: unknown): boolean | undefined;
export {};
