/**
 * The model-facing `debug` tool: one tool, one discriminating `action`
 * parameter covering launch, breakpoints, stepping, inspection, runtime
 * mutation, output capture, and teardown.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DebugSessionManager, type SessionLimits } from './session.js';
import { type DebugToolValue } from './format.js';
export declare const DEBUG_ACTIONS: readonly ["launch", "attach", "install_adapter", "set_breakpoints", "set_function_breakpoints", "set_exception_breakpoints", "continue", "step_in", "step_over", "step_out", "step_back", "reverse_continue", "pause", "threads", "stack_trace", "scopes", "variables", "evaluate", "set_variable", "set_expression", "exception_info", "select_thread", "add_watch", "remove_watch", "list_watches", "output", "disconnect", "terminate", "sessions", "ledger", "restart", "source", "loaded_sources", "modules", "data_breakpoint_info", "set_data_breakpoints", "goto_targets", "goto", "restart_frame", "disassemble", "read_memory", "completions"];
export type DebugAction = (typeof DEBUG_ACTIONS)[number];
/**
 * Actions safe to run in parallel with other tool calls. Everything else is
 * serialized: debug state is a live state machine (current frame, thread,
 * stop reason), so only pure reads that do not touch mutable session state
 * are whitelisted. `stack_trace` is deliberately NOT whitelisted: it records
 * the session's current frame, so it must serialize against stepping and
 * other inspection actions to avoid last-writer-wins races. `evaluate` is
 * also NOT whitelisted even though it reads like an inspection action: DAP
 * evaluation runs code inside the debuggee (context "repl" allows arbitrary
 * side effects, and property getters can mutate too), so it must serialize
 * against stepping and writes.
 * New actions default to serialized (safe side).
 */
export declare const CONCURRENT_SAFE_ACTIONS: ReadonlySet<string>;
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
    launch_config?: string;
    args?: string[];
    cwd?: string;
    stop_on_entry?: boolean;
    process_id?: number;
    file?: string;
    lines?: Array<number | {
        line: number;
        condition?: string;
        hit_condition?: string;
        log_message?: string;
    }>;
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
    start?: number;
    count?: number;
    terminate_debuggee?: boolean;
    target_line?: number;
    target_id?: number;
    data_breakpoints?: Array<{
        data_id?: string;
        address?: string;
        name?: string;
        access_type?: 'read' | 'write' | 'readWrite';
        condition?: string;
        hit_condition?: string;
    }>;
    access_type?: 'read' | 'write' | 'readWrite';
    address?: string;
    watch_name?: string;
    data_id?: string;
    restart_frame_id?: number;
    source_reference?: number;
    watch_id?: string;
    single_thread?: boolean;
    hex?: boolean;
    filter?: 'indexed' | 'named';
    memory_reference?: string;
    instruction_count?: number;
    instruction_offset?: number;
    resolve_symbols?: boolean;
    text?: string;
    column?: number;
    line?: number;
    ledger_kinds?: string;
    ledger_since?: string;
    ledger_limit?: number;
}
/**
 * Execute one debug action against the manager. Split from the defineTool
 * wrapper so tests drive it without the registry.
 */
export declare function runDebugAction(owner: object, args: DebugArgs, manager: DebugSessionManager, limits: SessionLimits, signal?: AbortSignal): Promise<DebugToolValue>;
/** Build the registry-ready tool definition. */
export declare function createDebugTool(manager: DebugSessionManager, limits: SessionLimits): ReturnType<typeof defineTool>;
