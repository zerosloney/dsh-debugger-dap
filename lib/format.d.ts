/**
 * Pure formatting of the debug tool's canonical value into model-facing
 * text. Mirrors the session-snapshot-first style so every response anchors
 * the model at the current debuggee location.
 */
import type { BreakpointRecord, DebugSnapshot, DapFrameView, OutputPage } from './session.js';
/** A function breakpoint as reported by the adapter (no source line). */
export interface FunctionBreakpointRecord {
    name: string;
    verified: boolean;
    line?: number;
    message?: string;
}
/** One scope row as rendered to the model. */
export interface ScopeView {
    name: string;
    variablesReference: number;
    expensive: boolean;
}
/** One variable row as rendered to the model. */
export interface VariableView {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
}
/** One thread row as rendered to the model. */
export interface ThreadView {
    id: number;
    name: string;
}
/** The debug tool's canonical output value. */
export interface DebugToolValue {
    action: string;
    session_id?: string;
    snapshot?: DebugSnapshot;
    state?: 'stopped' | 'running' | 'terminated';
    timed_out?: boolean;
    file?: string;
    breakpoints?: Array<{
        id: string;
        verified: boolean;
        message?: string;
    } | BreakpointRecord | FunctionBreakpointRecord>;
    frames?: DapFrameView[];
    frames_omitted?: number;
    threads?: ThreadView[];
    scopes?: ScopeView[];
    variables?: VariableView[];
    variables_omitted?: number;
    evaluation?: {
        result: string;
        type?: string;
        variables_reference: number;
    };
    set_result?: {
        result: string;
        type?: string;
        variables_reference: number;
    };
    exception?: {
        exception_id: string;
        description?: string;
        break_mode?: string;
        message?: string;
        type_name?: string;
        stack?: string;
    };
    output?: {
        text: string;
        offset: number;
        total_chars: number;
        truncated: boolean;
    };
    sessions?: DebugSnapshot[];
    content?: string;
    mime_type?: string;
    sources?: Array<{
        path?: string;
        name?: string;
    }>;
    modules?: Array<{
        id: string;
        name?: string;
        path?: string;
        version?: string;
        loaded?: boolean;
    }>;
    targets?: Array<{
        id: number;
        label: string;
        line: number;
    }>;
}
export declare function formatSnapshotLines(snapshot: DebugSnapshot): string[];
export declare function formatBreakpoints(file: string, breakpoints: Array<{
    id: string;
    verified: boolean;
    message?: string;
} | BreakpointRecord | FunctionBreakpointRecord>): string[];
export declare function formatFrames(frames: DapFrameView[], omitted: number): string[];
export declare function formatThreads(threads: ThreadView[]): string[];
export declare function formatScopes(scopes: ScopeView[]): string[];
export declare function formatVariables(variables: VariableView[], omitted: number): string[];
export declare function formatOutcome(value: DebugToolValue, timeoutMs: number): string[];
export declare function formatSessions(sessions: DebugSnapshot[]): string[];
export declare function formatOutput(page: OutputPage): string[];
/** Render the canonical value into one bounded text block. */
export declare function renderDebugText(value: DebugToolValue, maxResultChars: number): string;
