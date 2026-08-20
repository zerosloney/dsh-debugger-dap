/**
 * The model-facing `debug` tool: one tool, one discriminating `action`
 * parameter, fifteen actions covering launch, breakpoints, stepping,
 * inspection, output capture, and teardown.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DebugSessionManager, type SessionLimits } from './session.js';
import { type DebugToolValue } from './format.js';
export declare const DEBUG_ACTIONS: readonly ["launch", "attach", "set_breakpoints", "set_function_breakpoints", "set_exception_breakpoints", "continue", "step_in", "step_over", "step_out", "pause", "threads", "stack_trace", "scopes", "variables", "evaluate", "set_variable", "set_expression", "exception_info", "output", "disconnect", "sessions"];
export type DebugAction = (typeof DEBUG_ACTIONS)[number];
/**
 * Recursively drop `undefined`-valued entries so the returned canonical value
 * satisfies dsh-tools' lossless-JSON output contract. The registry validates
 * the value returned by `execute` before rendering; `undefined` is not
 * JSON-representable, so optional snapshot fields like `exitCode`/`frame.path`
 * must be omitted rather than present-as-undefined.
 */
export declare function omitUndefined(value: unknown): unknown;
/** Arguments after schema validation; everything except `action` is optional. */
export interface DebugArgs {
    action: DebugAction;
    session_id?: string;
    adapter?: string;
    program?: string;
    args?: string[];
    cwd?: string;
    stop_on_entry?: boolean;
    process_id?: number;
    file?: string;
    lines?: number[];
    condition?: string;
    hit_condition?: string;
    log_message?: string;
    functions?: string[];
    filters?: string[];
    filter_options?: unknown[];
    thread_id?: number;
    frame_id?: number;
    variables_ref?: number;
    name?: string;
    value?: string;
    levels?: number;
    expression?: string;
    context?: 'watch' | 'repl' | 'hover' | 'variables' | 'clipboard';
    offset?: number;
    max_chars?: number;
    terminate_debuggee?: boolean;
}
/**
 * Execute one debug action against the manager. Split from the defineTool
 * wrapper so tests drive it without the registry.
 */
export declare function runDebugAction(owner: object, args: DebugArgs, manager: DebugSessionManager, limits: SessionLimits, signal?: AbortSignal): Promise<DebugToolValue>;
/** Build the registry-ready tool definition. */
export declare function createDebugTool(manager: DebugSessionManager, limits: SessionLimits): ReturnType<typeof defineTool>;
