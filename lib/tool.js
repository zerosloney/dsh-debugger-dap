/**
 * The model-facing `debug` tool: one tool, one discriminating `action`
 * parameter, twenty-nine actions covering launch, breakpoints, stepping,
 * inspection, runtime mutation, output capture, and teardown.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DebugError, } from './session.js';
import { renderDebugText } from './format.js';
export const DEBUG_ACTIONS = [
    'launch',
    'attach',
    'set_breakpoints',
    'set_function_breakpoints',
    'set_exception_breakpoints',
    'continue',
    'step_in',
    'step_over',
    'step_out',
    'step_back',
    'reverse_continue',
    'pause',
    'threads',
    'stack_trace',
    'scopes',
    'variables',
    'evaluate',
    'set_variable',
    'set_expression',
    'exception_info',
    'select_thread',
    'add_watch',
    'remove_watch',
    'list_watches',
    'output',
    'disconnect',
    'terminate',
    'sessions',
    'ledger',
    'restart',
    'source',
    'loaded_sources',
    'modules',
    'data_breakpoint_info',
    'set_data_breakpoints',
    'goto_targets',
    'goto',
    'restart_frame',
    'disassemble',
    'read_memory',
    'completions',
];
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
export const CONCURRENT_SAFE_ACTIONS = new Set([
    'threads',
    'scopes',
    'variables',
    'output',
    'sessions',
    'ledger',
]);
/**
 * Recursively drop `undefined`-valued entries so the returned canonical value
 * satisfies dsh-tools' lossless-JSON output contract. The registry validates
 * the value returned by `execute` before rendering; `undefined` is not
 * JSON-representable, so optional snapshot fields like `exitCode`/`frame.path`
 * must be omitted rather than present-as-undefined.
 */
export function omitUndefined(value) {
    if (Array.isArray(value))
        return value.map(omitUndefined);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined)
                out[key] = omitUndefined(item);
        }
        return out;
    }
    return value;
}
const debugParameters = {
    action: {
        type: 'string',
        required: true,
        enum: DEBUG_ACTIONS,
        description: 'Debug operation. launch: start a program under a DAP adapter (default stops at entry). attach: attach to an already-running process by pid. set_breakpoints: replace one file breakpoint set. set_function_breakpoints: set breakpoints on function names. set_exception_breakpoints: choose which exceptions break. set_data_breakpoints / data_breakpoint_info: manage data breakpoints / watchpoints. continue/step_in/step_over/step_out/step_back/reverse_continue/pause: resume/step execution (waits for the next stop). threads/select_thread/stack_trace/scopes/variables/evaluate/exception_info: inspect state. disassemble/read_memory/completions: inspect disassembly, raw memory, and REPL completions. set_variable/set_expression: mutate state at the current frame. goto_targets/goto/restart_frame: non-sequential control flow. add_watch/remove_watch/list_watches: watch expressions evaluated on stop. source/loaded_sources/modules: inspect source files and modules. output: read captured program output. restart: restart execution. terminate/disconnect: end debuggee / session. sessions/ledger: list sessions and audit history.',
    },
    session_id: { type: 'string', description: 'Explicit session id; defaults to your most recent launch.' },
    adapter: {
        type: 'string',
        description: "Adapter id for launch: 'debugpy' (Python), 'dlv' (Go), 'netcoredbg' (.NET), or a config-declared id. Guessed from the program extension when omitted; required for attach (cannot guess from a pid).",
    },
    program: { type: 'string', description: 'Program path for launch (a .py/.go source, a .NET dll/exe, or whatever the adapter launches).' },
    args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments passed to the program at launch.' },
    cwd: { type: 'string', description: 'Working directory for launch (default: process cwd).' },
    stop_on_entry: { type: 'boolean', description: 'Break immediately at program entry / on attach (default: true for launch, false for attach).' },
    process_id: { type: 'number', description: 'Target process id for attach.' },
    file: { type: 'string', description: 'Source file for set_breakpoints.' },
    lines: { type: 'array', items: { type: 'json' }, description: 'Line numbers for set_breakpoints; replaces every previous breakpoint in that file. Each item may be a number (uses the call-level condition/hit_condition/log_message) or an object { line, condition?, hit_condition?, log_message? } for per-line settings.' },
    condition: { type: 'string', description: 'Conditional expression attached to each listed breakpoint (set_breakpoints / set_function_breakpoints).' },
    hit_condition: { type: 'string', description: 'Hit-condition (e.g. ">3", "5") attached to each listed breakpoint (set_breakpoints / set_function_breakpoints).' },
    log_message: { type: 'string', description: 'Logpoint message printed without stopping; "{}" placeholders are expanded (set_breakpoints).' },
    functions: { type: 'array', items: { type: 'string' }, description: 'Function names for set_function_breakpoints; replaces every previous function breakpoint.' },
    filters: { type: 'array', items: { type: 'string' }, description: "Exception filters for set_exception_breakpoints, e.g. ['all'], ['uncaught'], or ['userUnhandled']." },
    filter_options: { type: 'array', items: { type: 'json' }, description: 'Optional structured exception filterOptions for set_exception_breakpoints (used when the adapter supports them).' },
    thread_id: { type: 'number', description: 'Thread for stack_trace/exception_info; required for select_thread. Defaults to the stopped thread.' },
    frame_id: { type: 'number', description: 'Stack frame for scopes/evaluate/set_expression; defaults to the current stop frame.' },
    variables_ref: { type: 'number', description: 'variablesReference from scopes, variables, or evaluate, for the variables/set_variable actions.' },
    name: { type: 'string', description: 'Variable name for set_variable.' },
    value: { type: 'string', description: 'New value for set_variable/set_expression.' },
    levels: { type: 'number', description: 'Maximum stack frames returned by stack_trace (default 20).' },
    ledger_kinds: { type: 'string', description: "Ledger kinds filter (comma-separated): session_start, session_end, breakpoints_set, breakpoint_hit, exception, stop, request_error." },
    ledger_since: { type: 'string', description: 'Ledger filter: only entries at/after this ISO-8601 timestamp.' },
    ledger_limit: { type: 'number', description: 'Ledger max entries returned (default 50, max 500).' },
    expression: { type: 'string', description: 'Expression evaluated in the debuggee at the current frame.' },
    context: { type: 'string', enum: ['watch', 'repl', 'hover', 'variables', 'clipboard'], description: 'Evaluation context passed to the adapter (default repl).' },
    offset: { type: 'number', description: 'Char offset where the output action starts reading.' },
    max_chars: { type: 'number', description: 'Maximum chars the output action returns (default 4000).' },
    start: { type: 'number', description: 'First entry for variables/modules paging (0-based).' },
    count: { type: 'number', description: 'Number of entries for variables/modules paging; variables defaults to the session limit.' },
    terminate_debuggee: { type: 'boolean', description: 'Also kill the debuggee process on disconnect (default true).' },
    target_line: { type: 'number', description: 'Source line for goto_targets.' },
    target_id: { type: 'number', description: 'Target id for goto/restart_frame.' },
    data_breakpoints: { type: 'array', items: { type: 'json' }, description: 'Data breakpoint specifications for set_data_breakpoints: array of { data_id?: string, address?: string, name?: string, access_type?: "read"|"write"|"readWrite", condition?: string, hit_condition?: string }.' },
    access_type: { type: 'string', enum: ['read', 'write', 'readWrite'], description: 'Access type for a single data breakpoint shorthand.' },
    address: { type: 'string', description: 'Memory address for a data breakpoint.' },
    watch_name: { type: 'string', description: 'Variable name for a watch/data breakpoint.' },
    data_id: { type: 'string', description: 'Data identifier from data_breakpoint_info for set_data_breakpoints.' },
    restart_frame_id: { type: 'number', description: 'Stack frame id for restart_frame.' },
    source_reference: { type: 'number', description: 'Source reference for the source action; defaults to the current frame (in-memory/REPL sources have a reference but no path).' },
    watch_id: { type: 'string', description: 'Watch id for remove_watch (returned by add_watch/list_watches).' },
    single_thread: { type: 'boolean', description: 'Stepping option: if true, only resume the target thread instead of all threads.' },
    hex: { type: 'boolean', description: 'Format numbers / variable values as hexadecimal.' },
    filter: { type: 'string', enum: ['indexed', 'named'], description: 'Filter variable properties: "indexed" for arrays, "named" for fields.' },
    memory_reference: { type: 'string', description: 'Memory reference / hex pointer address for disassemble and read_memory.' },
    instruction_count: { type: 'number', description: 'Number of instructions to disassemble (default 20).' },
    instruction_offset: { type: 'number', description: 'Instruction offset for disassemble.' },
    resolve_symbols: { type: 'boolean', description: 'Resolve function and label symbols in disassemble (default true).' },
    text: { type: 'string', description: 'Prefix text to complete for completions.' },
    column: { type: 'number', description: '1-based column position for completions.' },
    line: { type: 'number', description: '1-based line number for completions.' },
};
const debugOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: { type: 'string' },
        session_id: { type: 'string' },
        snapshot: { type: 'json' },
        state: { type: 'string', enum: ['stopped', 'running', 'terminated'] },
        timed_out: { type: 'boolean' },
        file: { type: 'string' },
        breakpoints: { type: 'json' },
        frames: { type: 'json' },
        frames_omitted: { type: 'number' },
        threads: { type: 'json' },
        scopes: { type: 'json' },
        variables: { type: 'json' },
        variables_omitted: { type: 'number' },
        evaluation: { type: 'json' },
        set_result: { type: 'json' },
        exception: { type: 'json' },
        watch_id: { type: 'string' },
        watches: { type: 'json' },
        output: { type: 'json' },
        sessions: { type: 'json' },
        entries: { type: 'json' },
        truncated: { type: 'boolean' },
        content: { type: 'string' },
        mime_type: { type: 'string' },
        sources: { type: 'json' },
        modules: { type: 'json' },
        targets: { type: 'json' },
        data_breakpoint_info: { type: 'json' },
        instructions: { type: 'json' },
        memory: { type: 'json' },
        completions: { type: 'json' },
    },
};
/**
 * Execute one debug action against the manager. Split from the defineTool
 * wrapper so tests drive it without the registry.
 */
export async function runDebugAction(owner, args, manager, limits, signal) {
    switch (args.action) {
        case 'launch': {
            if (args.program === undefined || args.program.length === 0) {
                throw new DebugError('invalid_arguments', "action 'launch' requires 'program'.");
            }
            const snapshot = await manager.launch(owner, {
                adapterId: args.adapter,
                program: args.program,
                args: args.args,
                cwd: args.cwd,
                stopOnEntry: args.stop_on_entry,
            }, signal);
            return { action: 'launch', session_id: snapshot.id, snapshot };
        }
        case 'attach': {
            if (args.adapter === undefined || args.adapter.length === 0) {
                throw new DebugError('invalid_arguments', "action 'attach' requires 'adapter' (cannot guess the adapter from a pid).");
            }
            if (args.process_id === undefined) {
                throw new DebugError('invalid_arguments', "action 'attach' requires 'process_id'.");
            }
            const snapshot = await manager.attach(owner, {
                adapterId: args.adapter,
                program: args.program,
                processId: args.process_id,
                args: args.args,
                cwd: args.cwd,
                stopOnEntry: args.stop_on_entry,
            }, signal);
            return { action: 'attach', session_id: snapshot.id, snapshot };
        }
        case 'set_breakpoints': {
            if (args.file === undefined || args.file.length === 0) {
                throw new DebugError('invalid_arguments', "action 'set_breakpoints' requires 'file'.");
            }
            if (args.lines === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_breakpoints' requires 'lines' (an empty list clears the file).");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const breakpoints = await session.setBreakpoints(args.file, args.lines.map(entry => {
                // Object entries carry per-line conditions; plain numbers inherit
                // the call-level condition/hit_condition/log_message.
                if (typeof entry === 'object') {
                    return {
                        line: entry.line,
                        condition: entry.condition,
                        hitCondition: entry.hit_condition,
                        logMessage: entry.log_message,
                    };
                }
                return {
                    line: entry,
                    condition: args.condition,
                    hitCondition: args.hit_condition,
                    logMessage: args.log_message,
                };
            }), signal);
            return { action: 'set_breakpoints', session_id: session.id, snapshot: session.snapshot(), file: args.file, breakpoints };
        }
        case 'set_function_breakpoints': {
            if (args.functions === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_function_breakpoints' requires 'functions' (an empty list clears).");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const breakpoints = await session.setFunctionBreakpoints(args.functions.map(name => ({ name, condition: args.condition, hitCondition: args.hit_condition })), signal);
            return { action: 'set_function_breakpoints', session_id: session.id, snapshot: session.snapshot(), breakpoints };
        }
        case 'set_exception_breakpoints': {
            if (args.filters === undefined && args.filter_options === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_exception_breakpoints' requires 'filters' (e.g. ['all']) or 'filter_options'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            await session.setExceptionBreakpoints(args.filters ?? [], args.filter_options, signal);
            return { action: 'set_exception_breakpoints', session_id: session.id, snapshot: session.snapshot() };
        }
        case 'continue':
        case 'step_in':
        case 'step_over':
        case 'step_out':
        case 'reverse_continue':
        case 'pause': {
            const session = manager.sessionFor(owner, args.session_id);
            const command = args.action === 'continue'
                ? 'continue'
                : args.action === 'step_in'
                    ? 'stepIn'
                    : args.action === 'step_over'
                        ? 'next'
                        : args.action === 'step_out'
                            ? 'stepOut'
                            : args.action === 'reverse_continue'
                                ? 'reverseContinue'
                                : 'pause';
            const outcome = await session.resume(command, signal, {
                threadId: args.thread_id,
                singleThread: args.single_thread,
            });
            return {
                action: args.action,
                session_id: session.id,
                snapshot: outcome.snapshot,
                state: outcome.state,
                timed_out: outcome.timedOut,
                ...(outcome.output === undefined
                    ? {}
                    : { output: { text: outcome.output.text, offset: outcome.output.offset, total_chars: outcome.output.totalChars, truncated: outcome.output.truncated } }),
            };
        }
        case 'step_back': {
            const session = manager.sessionFor(owner, args.session_id);
            const outcome = await session.stepBack(signal, {
                threadId: args.thread_id,
                singleThread: args.single_thread,
            });
            return {
                action: 'step_back',
                session_id: session.id,
                snapshot: outcome.snapshot,
                state: outcome.state,
                timed_out: outcome.timedOut,
                ...(outcome.output === undefined
                    ? {}
                    : { output: { text: outcome.output.text, offset: outcome.output.offset, total_chars: outcome.output.totalChars, truncated: outcome.output.truncated } }),
            };
        }
        case 'threads': {
            const session = manager.sessionFor(owner, args.session_id);
            const threads = await session.threads(signal);
            return {
                action: 'threads',
                session_id: session.id,
                snapshot: session.snapshot(),
                threads: threads.map(thread => ({ id: thread.id, name: thread.name })),
            };
        }
        case 'stack_trace': {
            const session = manager.sessionFor(owner, args.session_id);
            const levels = args.levels ?? limits.maxStackFrames;
            const frames = await session.stackTrace(levels, signal);
            return {
                action: 'stack_trace',
                session_id: session.id,
                snapshot: session.snapshot(),
                frames,
                frames_omitted: Math.max(0, levels - frames.length),
            };
        }
        case 'scopes': {
            const session = manager.sessionFor(owner, args.session_id);
            const scopes = await session.scopes(args.frame_id, signal);
            return {
                action: 'scopes',
                session_id: session.id,
                snapshot: session.snapshot(),
                scopes: scopes.map(scope => ({
                    name: scope.name,
                    variablesReference: scope.variablesReference,
                    expensive: scope.expensive,
                })),
            };
        }
        case 'variables': {
            if (args.variables_ref === undefined) {
                throw new DebugError('invalid_arguments', "action 'variables' requires 'variables_ref' from a scopes, variables, or evaluate result.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const { variables, omitted } = await session.variables(args.variables_ref, signal, {
                start: args.start,
                count: args.count,
                filter: args.filter,
                hex: args.hex,
            });
            return {
                action: 'variables',
                session_id: session.id,
                snapshot: session.snapshot(),
                variables: variables.map(variable => ({
                    name: variable.name,
                    value: variable.value,
                    type: variable.type,
                    variablesReference: variable.variablesReference,
                })),
                variables_omitted: omitted,
            };
        }
        case 'evaluate': {
            if (args.expression === undefined || args.expression.length === 0) {
                throw new DebugError('invalid_arguments', "action 'evaluate' requires 'expression'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const evaluation = await session.evaluate(args.expression, args.frame_id, args.context, signal, {
                hex: args.hex,
            });
            return {
                action: 'evaluate',
                session_id: session.id,
                snapshot: session.snapshot(),
                evaluation: {
                    result: evaluation.result,
                    type: evaluation.type,
                    variables_reference: evaluation.variablesReference,
                },
            };
        }
        case 'set_variable': {
            if (args.variables_ref === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_variable' requires 'variables_ref' from a scopes/variables result.");
            }
            if (args.name === undefined || args.value === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_variable' requires both 'name' and 'value'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const result = await session.setVariable(args.variables_ref, args.name, args.value, signal);
            return {
                action: 'set_variable',
                session_id: session.id,
                snapshot: session.snapshot(),
                set_result: { result: result.value, type: result.type, variables_reference: result.variablesReference },
            };
        }
        case 'set_expression': {
            if (args.expression === undefined || args.value === undefined) {
                throw new DebugError('invalid_arguments', "action 'set_expression' requires both 'expression' and 'value'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const result = await session.setExpression(args.expression, args.value, args.frame_id, args.context, signal);
            return {
                action: 'set_expression',
                session_id: session.id,
                snapshot: session.snapshot(),
                set_result: { result: result.value, type: result.type, variables_reference: result.variablesReference },
            };
        }
        case 'exception_info': {
            const session = manager.sessionFor(owner, args.session_id);
            const info = await session.exceptionInfo(args.thread_id, signal);
            return {
                action: 'exception_info',
                session_id: session.id,
                snapshot: session.snapshot(),
                exception: {
                    exception_id: info.exceptionId,
                    description: info.description,
                    break_mode: info.breakMode,
                    message: info.message,
                    type_name: info.typeName,
                    stack: info.stack,
                },
            };
        }
        case 'select_thread': {
            if (args.thread_id === undefined) {
                throw new DebugError('invalid_arguments', "action 'select_thread' requires 'thread_id'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            await session.selectThread(args.thread_id, signal);
            return { action: 'select_thread', session_id: session.id, snapshot: session.snapshot() };
        }
        case 'add_watch': {
            if (args.expression === undefined || args.expression.length === 0) {
                throw new DebugError('invalid_arguments', "action 'add_watch' requires 'expression'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const id = session.addWatch(args.expression);
            // Evaluate immediately so the model sees the current value.
            await session.evaluateWatches(signal);
            return { action: 'add_watch', session_id: session.id, snapshot: session.snapshot(), watch_id: id };
        }
        case 'remove_watch': {
            if (args.watch_id === undefined) {
                throw new DebugError('invalid_arguments', "action 'remove_watch' requires 'watch_id'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const removed = session.removeWatch(args.watch_id);
            if (!removed)
                throw new DebugError('no_session', `No watch '${args.watch_id}'.`);
            return { action: 'remove_watch', session_id: session.id, snapshot: session.snapshot(), watch_id: args.watch_id };
        }
        case 'list_watches': {
            const session = manager.sessionFor(owner, args.session_id);
            return { action: 'list_watches', session_id: session.id, snapshot: session.snapshot(), watches: session.listWatches() };
        }
        case 'output': {
            const session = manager.sessionFor(owner, args.session_id);
            const page = session.readOutput({ offset: args.offset, maxChars: args.max_chars });
            // A full read (no explicit offset) consumes the tail so incremental
            // resume output continues from here; an explicit offset preserves it.
            if (args.offset === undefined)
                session.markOutputRead();
            return {
                action: 'output',
                session_id: session.id,
                snapshot: session.snapshot(),
                output: {
                    text: page.text,
                    offset: page.offset,
                    total_chars: page.totalChars,
                    truncated: page.truncated,
                },
            };
        }
        case 'disconnect': {
            const snapshot = await manager.disconnect(owner, args.session_id, args.terminate_debuggee ?? true);
            if (snapshot === undefined)
                return { action: 'disconnect', sessions: manager.list(owner) };
            return { action: 'disconnect', session_id: snapshot.id, snapshot };
        }
        case 'terminate': {
            const session = manager.sessionFor(owner, args.session_id);
            const snapshot = await session.terminate(false, signal);
            return { action: 'terminate', session_id: session.id, snapshot };
        }
        case 'sessions': {
            return { action: 'sessions', sessions: manager.list(owner) };
        }
        case 'ledger': {
            const kinds = args.ledger_kinds === undefined ? undefined : args.ledger_kinds.split(',').map(kind => kind.trim()).filter(kind => kind.length > 0);
            const result = manager.ledgerQuery({
                sessionId: args.session_id,
                kinds,
                since: args.ledger_since,
                limit: args.ledger_limit,
            });
            return {
                action: 'ledger',
                entries: result.entries.map(entry => ({
                    seq: entry.seq,
                    ts: entry.ts,
                    sessionId: entry.sessionId,
                    kind: entry.kind,
                    detail: entry.detail,
                })),
                truncated: result.truncated,
            };
        }
        case 'restart': {
            const session = manager.sessionFor(owner, args.session_id);
            const snapshot = await session.restart(signal);
            return { action: 'restart', session_id: session.id, snapshot };
        }
        case 'source': {
            const session = manager.sessionFor(owner, args.session_id);
            const content = await session.source(signal, args.source_reference);
            return { action: 'source', session_id: session.id, snapshot: session.snapshot(), content: content.content, mime_type: content.mimeType };
        }
        case 'loaded_sources': {
            const session = manager.sessionFor(owner, args.session_id);
            const sources = await session.loadedSources(signal);
            return { action: 'loaded_sources', session_id: session.id, snapshot: session.snapshot(), sources: sources.map(s => ({ path: s.path, name: s.name, source_reference: s.sourceReference })) };
        }
        case 'modules': {
            const session = manager.sessionFor(owner, args.session_id);
            const modules = await session.modules(signal, { start: args.start, count: args.count });
            return { action: 'modules', session_id: session.id, snapshot: session.snapshot(), modules: modules.map(m => ({ id: String(m.id), name: m.name, path: m.path, version: m.version, loaded: m.loaded })) };
        }
        case 'data_breakpoint_info': {
            if (args.name === undefined || args.name.length === 0) {
                throw new DebugError('invalid_arguments', "action 'data_breakpoint_info' requires 'name'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const info = await session.dataBreakpointInfo(args.name, args.variables_ref, args.frame_id, signal);
            return {
                action: 'data_breakpoint_info',
                session_id: session.id,
                snapshot: session.snapshot(),
                data_breakpoint_info: {
                    data_id: info.dataId,
                    description: info.description,
                    access_types: info.accessTypes,
                    can_persist: info.canPersist,
                },
            };
        }
        case 'set_data_breakpoints': {
            const session = manager.sessionFor(owner, args.session_id);
            const explicit = (args.data_breakpoints ?? []).map(bp => ({
                dataId: bp.data_id,
                address: bp.address,
                name: bp.name,
                accessType: bp.access_type,
                condition: bp.condition,
                hitCondition: bp.hit_condition,
            }));
            const shorthand = explicit.length === 0 && (args.address !== undefined || args.watch_name !== undefined || args.data_id !== undefined)
                ? [{ dataId: args.data_id, address: args.address, name: args.watch_name, accessType: args.access_type, condition: args.condition, hitCondition: args.hit_condition }]
                : [];
            const breakpoints = await session.setDataBreakpoints([...explicit, ...shorthand], signal);
            return { action: 'set_data_breakpoints', session_id: session.id, snapshot: session.snapshot(), breakpoints: breakpoints.map(bp => ({ id: String(bp.id), verified: bp.verified, message: bp.message })) };
        }
        case 'goto_targets': {
            const session = manager.sessionFor(owner, args.session_id);
            const targets = await session.gotoTargets(args.target_line ?? session.snapshot().frame?.line ?? 0, signal);
            return { action: 'goto_targets', session_id: session.id, snapshot: session.snapshot(), targets: targets.map(t => ({ id: t.id, label: t.label, line: t.line })) };
        }
        case 'goto': {
            if (args.target_id === undefined)
                throw new DebugError('invalid_arguments', "action 'goto' requires 'target_id'.");
            const session = manager.sessionFor(owner, args.session_id);
            const snapshot = await session.goto(args.target_id, signal);
            return { action: 'goto', session_id: session.id, snapshot };
        }
        case 'restart_frame': {
            const session = manager.sessionFor(owner, args.session_id);
            const snapshot = await session.restartFrame(args.restart_frame_id ?? args.frame_id, signal);
            return { action: 'restart_frame', session_id: session.id, snapshot };
        }
        case 'disassemble': {
            if (args.memory_reference === undefined || args.memory_reference.length === 0) {
                throw new DebugError('invalid_arguments', "action 'disassemble' requires 'memory_reference'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const instructions = await session.disassemble(args.memory_reference, args.instruction_count ?? 20, {
                offset: args.offset,
                instructionOffset: args.instruction_offset,
                resolveSymbols: args.resolve_symbols,
            }, signal);
            return {
                action: 'disassemble',
                session_id: session.id,
                snapshot: session.snapshot(),
                instructions: instructions.map(inst => ({
                    address: inst.address,
                    instruction: inst.instruction,
                    instruction_bytes: inst.instructionBytes,
                    symbol: inst.symbol,
                    location: inst.location ? { path: inst.location.path, name: inst.location.name } : undefined,
                    line: inst.line,
                    column: inst.column,
                })),
            };
        }
        case 'read_memory': {
            if (args.memory_reference === undefined || args.memory_reference.length === 0) {
                throw new DebugError('invalid_arguments', "action 'read_memory' requires 'memory_reference'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const mem = await session.readMemory(args.memory_reference, args.count ?? 64, args.offset, signal);
            return {
                action: 'read_memory',
                session_id: session.id,
                snapshot: session.snapshot(),
                memory: {
                    address: mem.address,
                    unreadable_bytes: mem.unreadableBytes,
                    data: mem.data,
                },
            };
        }
        case 'completions': {
            if (args.text === undefined) {
                throw new DebugError('invalid_arguments', "action 'completions' requires 'text'.");
            }
            const session = manager.sessionFor(owner, args.session_id);
            const items = await session.completions(args.text, args.column ?? (args.text.length + 1), args.frame_id, args.line, signal);
            return {
                action: 'completions',
                session_id: session.id,
                snapshot: session.snapshot(),
                completions: items.map(item => ({
                    label: item.label,
                    text: item.text,
                    sort_text: item.sortText,
                    detail: item.detail,
                    type: item.type,
                    start: item.start,
                    length: item.length,
                })),
            };
        }
    }
}
/** Build the registry-ready tool definition. */
export function createDebugTool(manager, limits) {
    return defineTool({
        name: 'debug',
        description: [
            'Interactive debugger over the Debug Adapter Protocol.',
            'Workflow: launch (debugpy/dlv/netcoredbg or a config adapter, stopped at entry by default) → set_breakpoints / set_function_breakpoints / set_exception_breakpoints → continue/step_* → stack_trace → scopes → variables → evaluate / set_variable / set_expression; read stdout/stderr via output; attach by pid; end with disconnect.',
            "Each agent's most recent launch/attach is its active session; pass session_id to address another. Resume actions wait for the next stop and return the new location, or report the program as still running on timeout (then use pause).",
            'Read-only inspection actions: threads, stack_trace, scopes, variables, exception_info, output, sessions, ledger.',
        ].join('\n'),
        parameters: debugParameters,
        output: {
            schema: debugOutputSchema,
            render: (_args, value) => [
                { type: 'text', text: renderDebugText(value, limits.maxResultChars, limits.stepTimeoutMs) },
            ],
        },
        isConcurrencySafe: args => {
            const action = args.action;
            return action !== undefined && CONCURRENT_SAFE_ACTIONS.has(action);
        },
        execute: async (args, exec) => {
            const owner = requireOwner(exec.agent);
            try {
                const value = await runDebugAction(owner, args, manager, limits, exec.signal);
                return omitUndefined(value);
            }
            catch (error) {
                manager.recordError(error, args.session_id);
                normalizeError(error);
            }
        },
    });
}
function requireOwner(agent) {
    if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) {
        throw new DebugError('no_active_session', 'The debug tool requires an initiating agent context.');
    }
    return agent;
}
/**
 * Normalize transport-level failures into stable DebugError codes so the
 * model gets a consistent, self-healable error vocabulary instead of raw
 * adapter errors and timeout strings.
 */
function normalizeError(error) {
    if (error instanceof DebugError)
        throw error;
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            throw new DebugError('timeout', `The debug adapter did not respond in time: ${error.message}`);
        }
        if (error.name === 'DapRequestError') {
            throw new DebugError('adapter_error', error.message);
        }
        if (error.name === 'DapDisconnectedError') {
            throw new DebugError('disconnected', `The debug adapter connection closed: ${error.message}`);
        }
        throw new DebugError('adapter_error', error.message);
    }
    throw new DebugError('adapter_error', String(error));
}
//# sourceMappingURL=tool.js.map