/**
 * Debug session state machine and the owner-scoped session registry. One
 * session owns one adapter process; every model-facing result carries a
 * snapshot so the model always knows where the debuggee is.
 */
import { isAbsolute, resolve } from 'node:path';
import { DapDisconnectedError } from './connection.js';
import { DebugLedger } from './ledger.js';
import { readBreakpoints, readCapabilities, readCompletions, readDataBreakpointInfo, readDataBreakpoints, readDisassembledInstructions, readEvaluation, readExceptionInfo, readExitCode, readGotoTargets, readLoadedSources, readMemoryResult, readModules, readOutputEvent, readScopes, readSetResult, readSource, readStackFrames, readStoppedEvent, readThreads, readVariables, } from './protocol.js';
/** Domain error with a stable code the tool layer can render. */
export class DebugError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DebugError';
    }
}
/** One live debug session: adapter connection plus folded state. */
export class DebugSession {
    id;
    adapterId;
    program;
    spawned;
    limits;
    launchMode;
    ledger;
    exceptionFilterMap;
    status = 'configuring';
    stopReason;
    exitCode;
    activeThreadId;
    currentFrame;
    capabilities = {};
    /** Whether the last stop halted every thread (allThreadsStopped). */
    allThreadsStopped;
    exceptionDetails;
    threadsSummary;
    stopReasonDescription;
    configurationDoneSent = false;
    outputLines = [];
    outputChars = 0;
    evictedChars = 0;
    stopWaiter;
    breakpointsByFile = new Map();
    detach = [];
    disposed = false;
    cwdValue;
    initializedSeen = false;
    multipleThreadsSeen = false;
    lastActivityAt = Date.now();
    /** Session creation time; also the ledger's duration baseline. */
    startedAt = Date.now();
    /** Whether a session_end ledger entry was already written (write-once). */
    ledgerEnded = false;
    /** Monotonic creation order, so LRU eviction is stable when timestamps tie. */
    createdSeq;
    /** Absolute char offset up to which output has been consumed by the model. */
    outputReadOffset = 0;
    /** Watch id → expression; evaluated on every stop. */
    watches = new Map();
    /** Latest watch results (id → { value, error }). */
    watchResults = new Map();
    nextWatchId = 1;
    constructor(id, adapterId, program, spawned, limits, 
    /** Whether this session launched its own debuggee ('launch') or attached to a foreign one ('attach'). */
    launchMode, createdSeq, 
    /** Optional session trace ledger; absent = no recording. */
    ledger, 
    /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
    exceptionFilterMap) {
        this.id = id;
        this.adapterId = adapterId;
        this.program = program;
        this.spawned = spawned;
        this.limits = limits;
        this.launchMode = launchMode;
        this.ledger = ledger;
        this.exceptionFilterMap = exceptionFilterMap;
        this.createdSeq = createdSeq;
    }
    get connection() {
        return this.spawned.connection;
    }
    noteCwd(cwd) {
        this.cwdValue = cwd;
    }
    /** Refresh the idle clock; called by every model-facing action. */
    touch() {
        this.lastActivityAt = Date.now();
    }
    /**
     * Best-effort ledger write for this session; no-op without a ledger.
     * @param kind - event kind (session_start / breakpoint_hit / ...).
     * @param detail - JSON-safe detail object.
     */
    recordLedger(kind, detail = {}) {
        this.ledger?.record(this.id, kind, detail);
    }
    /**
     * Ledger: record a stop. For breakpoint/exception stops, best-effort
     * enrich with the top frame location (one lightweight stackTrace request,
     * never blocking the stop pipeline and never failing the debug flow).
     */
    async recordStopLedger(stopped) {
        const reason = stopped.reason ?? 'unknown';
        const detail = { reason, threadId: stopped.threadId };
        if (stopped.allThreadsStopped !== undefined)
            detail.allThreadsStopped = stopped.allThreadsStopped;
        if (stopped.description !== undefined)
            detail.description = stopped.description;
        const enrich = reason === 'breakpoint' || reason === 'exception';
        if (enrich && stopped.threadId !== undefined) {
            try {
                const body = await this.connection.send('stackTrace', { threadId: stopped.threadId, startFrame: 0, levels: 1 }, { timeoutMs: 2000 });
                const frame = readStackFrames(body)[0];
                if (frame !== undefined) {
                    detail.file = frame.source?.path;
                    detail.line = frame.line;
                    detail.function = frame.name;
                }
            }
            catch {
                // 位置补全是尽力而为：停机本身仍然入账。
            }
        }
        const kind = reason === 'breakpoint' ? 'breakpoint_hit' : reason === 'exception' ? 'exception' : 'stop';
        this.recordLedger(kind, detail);
    }
    /** Ledger: write the session_end entry exactly once. */
    endLedger(endReason) {
        if (this.ledgerEnded)
            return;
        this.ledgerEnded = true;
        this.recordLedger('session_end', {
            endReason,
            exitCode: this.exitCode,
            durationMs: Date.now() - this.startedAt,
            status: 'terminated',
        });
    }
    /** Milliseconds since the last activity. */
    idleMs() {
        return Date.now() - this.lastActivityAt;
    }
    wireEvents() {
        const { connection } = this;
        this.detach.push(connection.onEvent('initialized', () => {
            this.initializedSeen = true;
        }), connection.onEvent('stopped', body => {
            const stopped = readStoppedEvent(body);
            this.status = 'stopped';
            this.stopReason = stopped.reason;
            this.stopReasonDescription = stopped.description;
            if (stopped.threadId !== undefined)
                this.activeThreadId = stopped.threadId;
            this.allThreadsStopped = stopped.allThreadsStopped;
            this.wakeStopWaiter('stopped');
            void this.recordStopLedger(stopped);
        }), connection.onEvent('thread', () => {
            this.multipleThreadsSeen = true;
        }), connection.onEvent('terminated', () => {
            this.status = 'terminated';
            this.wakeStopWaiter('terminated');
            this.endLedger('debuggee_exit');
        }), connection.onEvent('exited', body => {
            this.exitCode = readExitCode(body);
        }), connection.onEvent('output', body => {
            const output = readOutputEvent(body);
            this.appendOutput(output.category === 'stderr' ? `[stderr] ${output.output}` : output.output);
        }), connection.onEvent('capabilities', body => {
            this.capabilities = { ...this.capabilities, ...readCapabilities(body) };
        }), connection.onClose(() => {
            if (this.status !== 'terminated') {
                this.status = 'terminated';
                this.wakeStopWaiter('terminated');
            }
            this.endLedger('adapter_close');
        }));
    }
    async start(mode, body, stopOnEntry, stopOnEntryKey, signal) {
        try {
            const initBody = await this.connection.send('initialize', {
                adapterID: this.adapterId,
                linesStartAt1: true,
                columnsStartAt1: true,
                pathFormat: 'path',
                supportsVariableType: true,
                supportsRunInTerminalRequest: false,
            }, { signal });
            this.capabilities = { ...this.capabilities, ...readCapabilities(initBody) };
            // DAP start orchestration: `launch`/`attach` is sent first, but
            // spec-conforming adapters (debugpy) defer the start response until
            // `configurationDone` arrives (launch → initialized → configurationDone
            // → start response). Awaiting the start response before configuration
            // deadlocks those adapters, so wait for `initialized`, finish
            // configuration, and only then await the start response. Adapters that
            // answer immediately are unaffected: the response is just awaited later.
            // A failed start (error response) must surface right away rather than
            // wait for an `initialized` event that will never come.
            const startResponse = this.connection.send(mode, body, { signal });
            const startOutcome = startResponse.then(() => 'start-ok', (error) => ({ error }));
            if (!this.initializedSeen) {
                const initialized = this.waitForEvent('initialized', this.limits.requestTimeoutMs, signal)
                    .then(() => 'initialized');
                const raced = await Promise.race([initialized, startOutcome]);
                if (raced !== 'initialized' && raced !== 'start-ok')
                    throw raced.error;
                // The start succeeded before `initialized` arrived (immediate
                // adapters): keep waiting for `initialized` before configuration.
                if (raced === 'start-ok')
                    await initialized;
            }
            if (stopOnEntry) {
                // Register the entry-stop waiter before configurationDone so a stop
                // that lands while the request is in flight is never missed.
                const stopPromise = this.registerStopWaiter(this.limits.requestTimeoutMs, signal);
                await this.finishConfiguration(signal);
                await startResponse;
                const state = await stopPromise;
                if (state === 'stopped' && this.readStatus() === 'stopped')
                    await this.refreshLocation(signal);
            }
            else {
                await this.finishConfiguration(signal);
                await startResponse;
            }
            return this.snapshot();
        }
        catch (error) {
            if (error instanceof DapDisconnectedError) {
                const tail = this.spawned.stderrTail().trim();
                const detail = tail.length > 0 ? ` Adapter stderr: ${tail.slice(-800)}` : '';
                throw new Error(`Debug adapter '${this.adapterId}' exited during ${mode}.${detail}`, { cause: error });
            }
            throw error;
        }
    }
    async launch(options) {
        const stopKey = options.stopOnEntryKey ?? 'stopOnEntry';
        return this.start('launch', {
            type: 'launch',
            request: 'launch',
            program: this.program,
            args: options.args ?? [],
            cwd: options.cwd,
            [stopKey]: options.stopOnEntry,
            ...options.launchArgs,
        }, options.stopOnEntry, stopKey, options.signal);
    }
    async attach(options) {
        const stopKey = options.stopOnEntryKey ?? 'stopOnEntry';
        return this.start('attach', {
            request: 'attach',
            processId: options.processId,
            args: options.args ?? [],
            cwd: options.cwd,
            [stopKey]: options.stopOnEntry,
            ...options.launchArgs,
        }, options.stopOnEntry, stopKey, options.signal);
    }
    async setBreakpoints(file, lines, signal) {
        const resolvedPath = isAbsolute(file) ? file : resolve(this.cwdValue ?? process.cwd(), file);
        const body = await this.connection.send('setBreakpoints', {
            source: { path: resolvedPath },
            lines: lines.map(entry => entry.line),
            breakpoints: lines.map(entry => ({
                line: entry.line,
                ...(entry.condition === undefined ? {} : { condition: entry.condition }),
                ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
                ...(entry.logMessage === undefined ? {} : { logMessage: entry.logMessage }),
            })),
        }, { signal });
        const resolved = readBreakpoints(body);
        const records = lines.map((requested, index) => {
            const adapter = resolved[index];
            return {
                line: requested.line,
                verified: adapter?.verified ?? false,
                message: adapter?.message,
                actualLine: adapter?.line,
            };
        });
        this.breakpointsByFile.set(file, records);
        this.recordLedger('breakpoints_set', {
            file,
            lines: lines.map(entry => entry.line),
            verified: records.filter(record => record.verified).length,
        });
        return records;
    }
    async resume(action, signal, options) {
        if (this.status === 'terminated') {
            return { state: 'terminated', timedOut: false, snapshot: this.snapshot() };
        }
        if (action === 'reverseContinue' && this.capabilities.supportsStepBack !== true) {
            throw new DebugError('not_supported', "The adapter does not support reverse execution ('reverseContinue').");
        }
        await this.finishConfiguration(signal);
        const threadId = options?.threadId ?? (await this.resolveThreadId(signal));
        const previousStatus = this.status;
        if (action !== 'pause')
            this.status = 'running';
        const timeoutMs = action === 'pause' ? this.limits.requestTimeoutMs : this.limits.stepTimeoutMs;
        const stopPromise = this.registerStopWaiter(timeoutMs, signal);
        try {
            await this.connection.send(action, {
                threadId,
                ...(options?.singleThread !== undefined ? { singleThread: options.singleThread } : {}),
            }, { signal });
        }
        catch (error) {
            // The adapter refused the resume (e.g. "not stopped"): fold back to the
            // pre-request status so later snapshots keep telling the truth. A
            // termination that raced the failure has already folded and wins.
            if (this.readStatus() === 'running')
                this.status = previousStatus;
            throw error;
        }
        const state = await stopPromise;
        const finalStatus = this.readStatus();
        const timedOut = state === 'stopped' ? false : finalStatus !== 'terminated';
        if (state === 'stopped') {
            await this.refreshLocation(signal);
            await this.evaluateWatches(signal);
        }
        return {
            state: state === 'stopped' && finalStatus === 'stopped' ? 'stopped' : finalStatus === 'terminated' ? 'terminated' : 'running',
            timedOut,
            snapshot: this.snapshot(),
            output: this.takeIncrementalOutput(),
        };
    }
    /** Output produced since the last consumed offset (empty when nothing new). */
    takeIncrementalOutput() {
        if (this.outputChars <= this.outputReadOffset)
            return undefined;
        const page = this.readOutput({ offset: this.outputReadOffset });
        this.outputReadOffset = page.offset + page.text.length;
        return page;
    }
    readStatus() {
        return this.status;
    }
    async threads(signal) {
        const body = await this.connection.send('threads', undefined, { signal });
        return readThreads(body);
    }
    /** Switch the session's focus thread; later steps and stack_trace use it. */
    async selectThread(threadId, signal) {
        const threads = await this.threads(signal);
        if (!threads.some(thread => thread.id === threadId)) {
            throw new DebugError('no_thread', `Thread ${threadId} does not exist (available: ${threads.map(thread => thread.id).join(', ')}).`);
        }
        this.activeThreadId = threadId;
        this.currentFrame = undefined;
    }
    /** Step backwards (requires adapter supportsStepBack); waits for the next stop. */
    async stepBack(signal, options) {
        if (this.capabilities.supportsStepBack !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'stepBack'. Upgrade the debugger or step forward instead.");
        }
        if (this.status === 'terminated') {
            return { state: 'terminated', timedOut: false, snapshot: this.snapshot() };
        }
        await this.finishConfiguration(signal);
        const threadId = options?.threadId ?? (await this.resolveThreadId(signal));
        const previousStatus = this.status;
        this.status = 'running';
        const stopPromise = this.registerStopWaiter(this.limits.stepTimeoutMs, signal);
        try {
            await this.connection.send('stepBack', {
                threadId,
                ...(options?.singleThread !== undefined ? { singleThread: options.singleThread } : {}),
            }, { signal });
        }
        catch (error) {
            // Adapter refused the reverse step: restore the truthful stop state.
            if (this.readStatus() === 'running')
                this.status = previousStatus;
            throw error;
        }
        const state = await stopPromise;
        const finalStatus = this.readStatus();
        const timedOut = state === 'stopped' ? false : finalStatus !== 'terminated';
        if (state === 'stopped') {
            await this.refreshLocation(signal);
            await this.evaluateWatches(signal);
        }
        return {
            state: state === 'stopped' && finalStatus === 'stopped' ? 'stopped' : finalStatus === 'terminated' ? 'terminated' : 'running',
            timedOut,
            snapshot: this.snapshot(),
            output: this.takeIncrementalOutput(),
        };
    }
    /** Add or replace a watch expression; returns its id. */
    addWatch(expression) {
        const id = `w${this.nextWatchId++}`;
        this.watches.set(id, expression);
        this.watchResults.delete(id);
        return id;
    }
    removeWatch(id) {
        const removed = this.watches.delete(id);
        this.watchResults.delete(id);
        return removed;
    }
    listWatches() {
        return [...this.watches.entries()].map(([id, expression]) => ({
            id,
            expression,
            ...this.watchResults.get(id),
        }));
    }
    /** Evaluate every watch in the current frame; failures are captured per watch. */
    async evaluateWatches(signal) {
        if (this.watches.size === 0 || this.currentFrame === undefined)
            return;
        for (const [id, expression] of this.watches) {
            try {
                const evaluation = await this.evaluate(expression, this.currentFrame.id, 'watch', signal);
                this.watchResults.set(id, { value: evaluation.result });
            }
            catch (error) {
                this.watchResults.set(id, { error: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    async stackTrace(levels, signal) {
        const threadId = await this.resolveThreadId(signal);
        const body = await this.connection.send('stackTrace', { threadId, startFrame: 0, levels: Math.max(1, Math.min(levels, this.limits.maxStackFrames)) }, { signal });
        const frames = readStackFrames(body);
        this.currentFrame = frames[0];
        return frames.map(frame => toFrameView(frame));
    }
    async scopes(frameId, signal) {
        const resolved = frameId ?? this.currentFrame?.id;
        if (resolved === undefined) {
            throw new DebugError('not_stopped', 'No current frame: stop at a breakpoint first or pass frame_id from stack_trace.');
        }
        const body = await this.connection.send('scopes', { frameId: resolved }, { signal });
        return readScopes(body);
    }
    async variables(variablesReference, signal, paging) {
        const body = await this.connection.send('variables', {
            variablesReference,
            ...(paging?.start === undefined ? {} : { start: paging.start }),
            ...(paging?.count === undefined ? {} : { count: paging.count }),
            ...(paging?.filter === undefined ? {} : { filter: paging.filter }),
            ...(paging?.hex === undefined ? {} : { format: { hex: paging.hex } }),
        }, { signal });
        const all = readVariables(body);
        const shown = all.slice(0, paging?.count ?? this.limits.maxVariables);
        // Truncate oversized scalar values in the data layer (not just at render
        // time) so one giant string cannot blow up the model-facing result.
        const perValueCap = Math.max(200, Math.floor(this.limits.maxResultChars / 4));
        const bounded = shown.map(variable => variable.value.length > perValueCap
            ? { ...variable, value: `${variable.value.slice(0, perValueCap)}…(${variable.value.length} chars)` }
            : variable);
        return { variables: bounded, omitted: all.length - shown.length };
    }
    async evaluate(expression, frameId, context, signal, options) {
        const resolved = frameId ?? this.currentFrame?.id;
        const body = await this.connection.send('evaluate', {
            expression,
            context: context ?? 'repl',
            ...(resolved === undefined ? {} : { frameId: resolved }),
            ...(options?.hex !== undefined ? { format: { hex: options.hex } } : {}),
        }, { signal });
        const evaluation = readEvaluation(body);
        const cap = Math.max(200, Math.floor(this.limits.maxResultChars / 4));
        if (evaluation.result.length > cap) {
            evaluation.result = `${evaluation.result.slice(0, cap)}…(${evaluation.result.length} chars)`;
        }
        return evaluation;
    }
    async setVariable(variablesReference, name, value, signal) {
        const body = await this.connection.send('setVariable', { variablesReference, name, value }, { signal });
        return readSetResult(body);
    }
    async setExpression(expression, value, frameId, context, signal) {
        const resolved = frameId ?? this.currentFrame?.id;
        const body = await this.connection.send('setExpression', { expression, value, context: context ?? 'repl', ...(resolved === undefined ? {} : { frameId: resolved }) }, { signal });
        return readSetResult(body);
    }
    async setFunctionBreakpoints(functions, signal) {
        const body = await this.connection.send('setFunctionBreakpoints', {
            breakpoints: functions.map(entry => ({
                name: entry.name,
                ...(entry.condition === undefined ? {} : { condition: entry.condition }),
                ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
            })),
        }, { signal });
        const resolved = readBreakpoints(body);
        return functions.map((entry, index) => {
            const adapter = resolved[index];
            return { name: entry.name, verified: adapter?.verified ?? false, line: adapter?.line, message: adapter?.message };
        });
    }
    async setExceptionBreakpoints(filters, filterOptions, signal) {
        // 配方级过滤器映射（如 debugpy 的 'all' → 'raised'）：模型侧保持标准 DAP 词汇。
        const mapped = [...filters].map(filter => this.exceptionFilterMap?.[filter] ?? filter);
        const body = {
            filters: mapped,
            ...(filterOptions !== undefined && this.capabilities.supportsExceptionOptions ? { filterOptions } : {}),
        };
        await this.connection.send('setExceptionBreakpoints', body, { signal });
    }
    async exceptionInfo(threadId, signal) {
        const resolved = threadId ?? this.activeThreadId;
        if (resolved === undefined) {
            throw new DebugError('no_thread', 'No thread to inspect: stop on an exception first or pass thread_id.');
        }
        const body = await this.connection.send('exceptionInfo', { threadId: resolved }, { signal });
        return readExceptionInfo(body);
    }
    async restart(signal) {
        if (this.capabilities.supportsRestartRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'restart'. Upgrade the debugger or launch again.");
        }
        const previousStatus = this.status;
        const previousStopReason = this.stopReason;
        const previousThread = this.activeThreadId;
        const previousFrame = this.currentFrame;
        this.status = 'running';
        this.stopReason = undefined;
        this.activeThreadId = undefined;
        this.currentFrame = undefined;
        const stopPromise = this.registerStopWaiter(this.limits.stepTimeoutMs, signal);
        try {
            await this.connection.send('restart', undefined, { signal });
        }
        catch (error) {
            // Adapter refused the restart: restore the pre-restart stop state (the
            // fields cleared above included), unless a termination already folded.
            if (this.readStatus() === 'running') {
                this.status = previousStatus;
                this.stopReason = previousStopReason;
                this.activeThreadId = previousThread;
                this.currentFrame = previousFrame;
            }
            throw error;
        }
        const state = await stopPromise;
        if (state === 'stopped') {
            await this.refreshLocation(signal);
            await this.evaluateWatches(signal);
        }
        return this.snapshot();
    }
    async source(signal, sourceReference) {
        const frame = this.currentFrame;
        // An explicit sourceReference wins; otherwise fall back to the current
        // frame's source. In-memory sources (REPL code, eval'd scripts) carry a
        // sourceReference but no path — support both.
        const ref = sourceReference ?? frame?.source?.sourceReference;
        const path = frame?.source?.path;
        if (ref === undefined && path === undefined) {
            throw new DebugError('not_stopped', 'No current frame with a source: stop at a breakpoint first, or pass source_reference.');
        }
        const body = await this.connection.send('source', {
            source: path === undefined ? {} : { path },
            sourceReference: ref ?? 0,
        }, { signal });
        return readSource(body);
    }
    async loadedSources(signal) {
        if (this.capabilities.supportsLoadedSourcesRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'loadedSources'.");
        }
        const body = await this.connection.send('loadedSources', undefined, { signal });
        return readLoadedSources(body);
    }
    async modules(signal, paging) {
        if (this.capabilities.supportsModulesRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'modules'.");
        }
        const body = await this.connection.send('modules', {
            ...(paging?.start === undefined ? {} : { startModule: paging.start }),
            ...(paging?.count === undefined ? {} : { moduleCount: paging.count }),
        }, { signal });
        return readModules(body);
    }
    async dataBreakpointInfo(name, variablesReference, frameId, signal) {
        if (this.capabilities.supportsDataBreakpoints !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'dataBreakpoints'.");
        }
        const resolvedFrame = frameId ?? this.currentFrame?.id;
        const body = await this.connection.send('dataBreakpointInfo', {
            name,
            ...(variablesReference !== undefined ? { variablesReference } : {}),
            ...(resolvedFrame !== undefined ? { frameId: resolvedFrame } : {}),
        }, { signal });
        return readDataBreakpointInfo(body);
    }
    async setDataBreakpoints(breakpoints, signal) {
        if (this.capabilities.supportsDataBreakpoints !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'setDataBreakpoints'.");
        }
        const resolvedBreakpoints = [];
        for (const bp of breakpoints) {
            let dataId = bp.dataId;
            if (!dataId && (bp.name !== undefined || bp.address !== undefined)) {
                try {
                    const info = await this.dataBreakpointInfo(bp.name ?? bp.address, bp.variablesReference, bp.frameId, signal);
                    if (info.dataId) {
                        dataId = info.dataId;
                    }
                }
                catch {
                    // Fallback to using name or address directly
                }
            }
            resolvedBreakpoints.push({
                dataId: dataId ?? bp.name ?? bp.address ?? '',
                ...(bp.accessType !== undefined ? { accessType: bp.accessType } : {}),
                ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
                ...(bp.hitCondition !== undefined ? { hitCondition: bp.hitCondition } : {}),
            });
        }
        const body = await this.connection.send('setDataBreakpoints', { breakpoints: resolvedBreakpoints }, { signal });
        return readDataBreakpoints(body);
    }
    async gotoTargets(targetLine, signal) {
        const frame = this.currentFrame;
        if (frame === undefined) {
            throw new DebugError('not_stopped', 'No current frame: stop at a breakpoint first.');
        }
        if (this.capabilities.supportsGotoTargetsRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'gotoTargets'.");
        }
        const source = frame.source?.path !== undefined
            ? { path: frame.source.path }
            : frame.source?.sourceReference !== undefined
                ? { sourceReference: frame.source.sourceReference }
                : undefined;
        if (source === undefined) {
            throw new DebugError('not_stopped', 'Current frame does not carry a source location.');
        }
        const body = await this.connection.send('gotoTargets', { source, line: targetLine }, { signal });
        return readGotoTargets(body);
    }
    async goto(targetId, signal) {
        if (this.capabilities.supportsGotoTargetsRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'goto'.");
        }
        const threadId = await this.resolveThreadId(signal);
        const previousStatus = this.status;
        const previousStopReason = this.stopReason;
        this.status = 'running';
        this.stopReason = undefined;
        const stopPromise = this.registerStopWaiter(this.limits.stepTimeoutMs, signal);
        try {
            await this.connection.send('goto', { threadId, targetId }, { signal });
        }
        catch (error) {
            // Adapter refused the jump: restore the truthful stop state.
            if (this.readStatus() === 'running') {
                this.status = previousStatus;
                this.stopReason = previousStopReason;
            }
            throw error;
        }
        const state = await stopPromise;
        if (state === 'stopped') {
            await this.refreshLocation(signal);
            await this.evaluateWatches(signal);
        }
        return this.snapshot();
    }
    async restartFrame(frameId, signal) {
        if (this.capabilities.supportsRestartFrame !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'restartFrame'.");
        }
        const resolved = frameId ?? this.currentFrame?.id;
        if (resolved === undefined) {
            throw new DebugError('not_stopped', 'No current frame: stop at a breakpoint first or pass frame_id.');
        }
        const previousStatus = this.status;
        const previousStopReason = this.stopReason;
        this.status = 'running';
        this.stopReason = undefined;
        const stopPromise = this.registerStopWaiter(this.limits.stepTimeoutMs, signal);
        try {
            await this.connection.send('restartFrame', { frameId: resolved }, { signal });
        }
        catch (error) {
            if (this.readStatus() === 'running') {
                this.status = previousStatus;
                this.stopReason = previousStopReason;
            }
            throw error;
        }
        const state = await stopPromise;
        if (state === 'stopped') {
            await this.refreshLocation(signal);
            await this.evaluateWatches(signal);
        }
        return this.snapshot();
    }
    async disassemble(memoryReference, instructionCount, options, signal) {
        if (this.capabilities.supportsDisassembleRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'disassemble'.");
        }
        const body = await this.connection.send('disassemble', {
            memoryReference,
            instructionCount,
            ...(options?.offset !== undefined ? { offset: options.offset } : {}),
            ...(options?.instructionOffset !== undefined ? { instructionOffset: options.instructionOffset } : {}),
            ...(options?.resolveSymbols !== undefined ? { resolveSymbols: options.resolveSymbols } : {}),
        }, { signal });
        return readDisassembledInstructions(body);
    }
    async readMemory(memoryReference, count, offset, signal) {
        if (this.capabilities.supportsReadMemoryRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'readMemory'.");
        }
        const body = await this.connection.send('readMemory', {
            memoryReference,
            count,
            ...(offset !== undefined ? { offset } : {}),
        }, { signal });
        return readMemoryResult(body);
    }
    async completions(text, column, frameId, line, signal) {
        if (this.capabilities.supportsCompletionsRequest !== true) {
            throw new DebugError('not_supported', "The adapter does not support 'completions'.");
        }
        const resolved = frameId ?? this.currentFrame?.id;
        const body = await this.connection.send('completions', {
            text,
            column,
            ...(resolved !== undefined ? { frameId: resolved } : {}),
            ...(line !== undefined ? { line } : {}),
        }, { signal });
        return readCompletions(body);
    }
    async terminate(restart = false, signal) {
        if (this.capabilities.supportsTerminateRequest !== true) {
            await this.disconnect(true);
            return this.snapshot();
        }
        try {
            await this.connection.send('terminate', { restart }, { signal });
        }
        catch {
            // ignore
        }
        this.status = 'terminated';
        this.recordLedger('session_end', { reason: 'terminate' });
        return this.snapshot();
    }
    readOutput(request) {
        const maxChars = Math.max(200, Math.min(request?.maxChars ?? 4000, this.limits.maxOutputChars));
        const wanted = request?.offset ?? Math.max(0, this.outputChars - maxChars);
        const start = Math.max(wanted, this.evictedChars);
        const truncatedByEviction = start > wanted;
        let text = '';
        let position = this.evictedChars;
        for (const line of this.outputLines) {
            const end = position + line.length;
            if (end <= start) {
                position = end;
                continue;
            }
            const slice = position >= start ? line : line.slice(start - position);
            if (text.length + slice.length > maxChars) {
                text += slice.slice(0, Math.max(0, maxChars - text.length));
                return { text, offset: start, totalChars: this.outputChars, truncated: true };
            }
            text += slice;
            position = end;
        }
        return { text, offset: start, totalChars: this.outputChars, truncated: truncatedByEviction };
    }
    /** Mark output consumed up to `offset` (or the current tail); incremental reads start there. */
    markOutputRead(offset) {
        this.outputReadOffset = Math.max(this.outputReadOffset, Math.min(offset ?? this.outputChars, this.outputChars));
    }
    snapshot() {
        const frame = this.currentFrame;
        return {
            id: this.id,
            adapter: this.adapterId,
            program: this.program,
            cwd: this.cwdValue,
            status: this.status,
            stopReason: this.stopReason,
            threadId: this.activeThreadId,
            allThreadsStopped: this.allThreadsStopped,
            frame: frame === undefined
                ? undefined
                : { id: frame.id, name: frame.name, path: frame.source?.path, line: frame.line, column: frame.column },
            exitCode: this.exitCode,
            configuring: this.status === 'configuring',
            outputChars: this.outputChars,
            watches: this.listWatches().length > 0 ? this.listWatches() : undefined,
            exceptionDetails: this.exceptionDetails,
            threadsSummary: this.threadsSummary,
            capabilities: {
                set_variable: this.capabilities.supportsSetVariable,
                set_expression: this.capabilities.supportsSetExpression,
                restart: this.capabilities.supportsRestartRequest,
                data_breakpoints: this.capabilities.supportsDataBreakpoints,
                goto_targets: this.capabilities.supportsGotoTargetsRequest,
                restart_frame: this.capabilities.supportsRestartFrame,
                loaded_sources: this.capabilities.supportsLoadedSourcesRequest,
                modules: this.capabilities.supportsModulesRequest,
                exception_info: this.capabilities.supportsExceptionInfoRequest,
                step_back: this.capabilities.supportsStepBack,
                terminate: this.capabilities.supportsTerminateRequest,
                disassemble: this.capabilities.supportsDisassembleRequest,
                read_memory: this.capabilities.supportsReadMemoryRequest,
                completions: this.capabilities.supportsCompletionsRequest,
            },
        };
    }
    async disconnect(terminateDebuggee) {
        if (this.disposed)
            return;
        this.disposed = true;
        this.status = 'terminated';
        this.wakeStopWaiter('terminated');
        this.endLedger('disconnect');
        try {
            await this.connection.send('disconnect', { terminateDebuggee }, { timeoutMs: 2000 });
        }
        catch {
            // the adapter is gone or refused; the kill below is the authority
        }
        this.connection.dispose();
        await this.spawned.kill();
        for (const detach of this.detach)
            detach();
    }
    async finishConfiguration(signal) {
        if (this.configurationDoneSent || this.status === 'terminated')
            return;
        if (this.capabilities.supportsConfigurationDoneRequest === false) {
            this.configurationDoneSent = true;
            if (this.status === 'configuring')
                this.status = 'running';
            return;
        }
        await this.connection.send('configurationDone', undefined, { signal });
        this.configurationDoneSent = true;
        if (this.status === 'configuring')
            this.status = 'running';
    }
    async resolveThreadId(signal) {
        if (this.activeThreadId !== undefined)
            return this.activeThreadId;
        let threads;
        try {
            threads = await this.threads(signal);
        }
        catch (error) {
            // The debuggee may have just exited: some adapters fail `threads`
            // outright (netcoredbg answers 0x80004005) before the terminated event
            // folds. Give the exit a brief window to land so the failure names it
            // instead of surfacing the raw adapter error.
            if (this.status === 'stopped')
                throw error;
            if (this.status === 'terminated')
                throw this.exitedError();
            await this.waitForStop(Math.min(this.limits.stepTimeoutMs, 500), signal);
            // readStatus() defeats property narrowing: the wait above may have
            // folded a termination even though earlier guards excluded it.
            if (this.readStatus() === 'terminated')
                throw this.exitedError();
            throw error;
        }
        if (threads.length > 0) {
            this.activeThreadId = threads[0].id;
            return this.activeThreadId;
        }
        // Empty list: the same in-flight-exit possibility applies.
        if (this.status !== 'stopped') {
            await this.waitForStop(Math.min(this.limits.stepTimeoutMs, 500), signal);
            if (this.status === 'terminated')
                throw this.exitedError();
            try {
                threads = await this.threads(signal);
            }
            catch {
                threads = [];
            }
        }
        const thread = threads[0];
        if (thread === undefined) {
            throw new DebugError('no_thread', `The debuggee reports no threads (status: ${this.status}). If the program already finished, launch again — stop_on_entry (the default) keeps quick programs stoppable while breakpoints are set.`);
        }
        this.activeThreadId = thread.id;
        return thread.id;
    }
    /** Error for actions that need live state on a debuggee that has exited. */
    exitedError() {
        const exit = this.exitCode !== undefined ? ` Exit code ${this.exitCode}.` : '';
        return new DebugError('no_thread', `The debuggee has already exited.${exit} Launch again with action "launch" — stop_on_entry (the default) keeps quick programs stoppable while breakpoints are set.`);
    }
    async refreshLocation(signal) {
        try {
            const threadId = this.activeThreadId ?? (await this.resolveThreadId(signal));
            const body = await this.connection.send('stackTrace', { threadId, startFrame: 0, levels: 1 }, { signal, timeoutMs: Math.min(this.limits.requestTimeoutMs, 5000) });
            this.currentFrame = readStackFrames(body)[0];
        }
        catch {
            // location is best-effort decoration; the stop itself already folded
        }
        if (this.stopReason === 'exception' && this.capabilities.supportsExceptionInfoRequest) {
            try {
                const threadId = this.activeThreadId ?? (await this.resolveThreadId(signal));
                const body = await this.connection.send('exceptionInfo', { threadId }, { signal, timeoutMs: Math.min(this.limits.requestTimeoutMs, 3000) });
                const info = readExceptionInfo(body);
                this.exceptionDetails = {
                    exceptionId: info.exceptionId,
                    description: info.description,
                    breakMode: info.breakMode,
                    message: info.message,
                    typeName: info.typeName,
                    stack: info.stack,
                };
            }
            catch {
                // best-effort
            }
        }
        else {
            this.exceptionDetails = undefined;
        }
        if (this.allThreadsStopped === true || this.multipleThreadsSeen) {
            try {
                const body = await this.connection.send('threads', undefined, {
                    signal,
                    timeoutMs: Math.min(this.limits.requestTimeoutMs, 3000),
                });
                const threads = readThreads(body);
                if (threads.length > 1) {
                    this.multipleThreadsSeen = true;
                    this.threadsSummary = threads.map(t => ({
                        id: t.id,
                        name: t.name,
                        stopped: this.allThreadsStopped || t.id === this.activeThreadId,
                        reason: t.id === this.activeThreadId ? this.stopReason : undefined,
                    }));
                }
                else {
                    this.threadsSummary = undefined;
                }
            }
            catch {
                // best-effort
            }
        }
        else {
            this.threadsSummary = undefined;
        }
    }
    waitForEvent(event, timeoutMs, signal) {
        if (signal?.aborted)
            return Promise.reject(new Error(`Aborted while waiting for the ${event} event`));
        return new Promise((resolve, reject) => {
            const unsubscribe = this.connection.onEvent(event, () => {
                cleanup();
                resolve();
            });
            const timer = setTimeout(() => {
                cleanup();
                const error = new Error(`Timed out waiting for the adapter's ${event} event`);
                error.name = 'TimeoutError';
                reject(error);
            }, timeoutMs);
            const onAbort = () => {
                cleanup();
                reject(new Error(`Aborted while waiting for the ${event} event`));
            };
            const cleanup = () => {
                clearTimeout(timer);
                unsubscribe();
                signal?.removeEventListener('abort', onAbort);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
    waitForStop(timeoutMs, signal) {
        if (this.status === 'stopped')
            return Promise.resolve('stopped');
        if (this.status === 'terminated')
            return Promise.resolve('terminated');
        if (signal?.aborted)
            return Promise.reject(new Error('Aborted while waiting for the debuggee to stop'));
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.stopWaiter = undefined;
                clearTimeout(waiter.timer);
                reject(new Error('Aborted while waiting for the debuggee to stop'));
            };
            const waiter = {
                resolve: state => {
                    this.stopWaiter = undefined;
                    clearTimeout(waiter.timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve(state);
                },
                timer: undefined,
                onAbort,
                signal,
            };
            waiter.timer = setTimeout(() => {
                this.stopWaiter = undefined;
                signal?.removeEventListener('abort', onAbort);
                resolve(this.status === 'terminated' ? 'terminated' : 'running');
            }, timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.stopWaiter = waiter;
        });
    }
    /**
     * {@link waitForStop} for waiters registered before their paired request is
     * sent (resume/restart/goto/start). When that request rejects first — e.g.
     * one abort fires both the request's and the waiter's onAbort — the
     * never-awaited waiter would surface as an unhandled rejection. Mark its
     * rejection handled here; callers that reach their own `await` still see it.
     */
    registerStopWaiter(timeoutMs, signal) {
        const stopPromise = this.waitForStop(timeoutMs, signal);
        stopPromise.catch(() => { });
        return stopPromise;
    }
    wakeStopWaiter(state) {
        this.stopWaiter?.resolve(state);
    }
    appendOutput(text) {
        for (const piece of text.split('\n')) {
            const line = piece === '' ? '' : `${piece}\n`;
            this.outputLines.push(line);
            this.outputChars += line.length;
        }
        while (this.outputChars - this.evictedChars > this.limits.maxOutputChars && this.outputLines.length > 1) {
            const evicted = this.outputLines.shift();
            this.evictedChars += evicted?.length ?? 0;
        }
        if (this.outputChars - this.evictedChars > this.limits.maxOutputChars) {
            const head = this.outputLines[0];
            if (head !== undefined) {
                const excess = head.length - (this.outputChars - this.evictedChars - this.limits.maxOutputChars);
                this.outputLines[0] = head.slice(Math.max(0, excess));
                this.evictedChars += Math.max(0, excess);
            }
        }
    }
}
function toFrameView(frame) {
    return {
        id: frame.id,
        name: frame.name,
        path: frame.source?.path,
        sourceReference: frame.source?.sourceReference,
        line: frame.line,
        column: frame.column,
    };
}
/** Owner-scoped registry of live debug sessions. */
export class DebugSessionManager {
    deps;
    nextId = 1;
    sessions = new Map();
    activeByOwner = new WeakMap();
    constructor(deps) {
        this.deps = deps;
        const idleMs = deps.sessionIdleTimeoutMs ?? 30 * 60 * 1000;
        this.maxPerOwner = deps.maxSessionsPerOwner ?? 5;
        this.ledger = deps.ledger ?? DebugLedger.create();
        if (idleMs > 0) {
            const timer = setInterval(() => void this.reapIdle(idleMs), Math.min(idleMs, 60_000));
            timer.unref?.();
            this.reaper = timer;
        }
    }
    reaper;
    maxPerOwner;
    /** Session trace ledger backing every session; never null (default file path). */
    ledger;
    async launch(owner, request, signal) {
        const spec = this.deps.resolveAdapter({ adapter: request.adapterId, program: request.program });
        const id = `dbg-${this.nextId++}`;
        const spawned = await this.deps.spawn(spec);
        const session = new DebugSession(id, spec.command, request.program, spawned, this.deps.limits, 'launch', this.nextId, this.ledger, spec.exceptionFilterMap);
        session.noteCwd(request.cwd);
        session.wireEvents();
        session.recordLedger('session_start', {
            mode: 'launch',
            adapter: spec.command,
            program: request.program,
            cwd: request.cwd,
        });
        this.sessions.set(id, { session, owner });
        try {
            const snapshot = await session.launch({
                args: request.args,
                cwd: request.cwd,
                stopOnEntry: request.stopOnEntry ?? true,
                launchArgs: {
                    ...spec.launchArgs,
                    ...(request.env !== undefined ? { env: request.env } : {}),
                    ...request.extraLaunchArgs,
                },
                stopOnEntryKey: spec.stopOnEntryKey,
                signal,
            });
            this.activeByOwner.set(owner, id);
            this.evictIfOverLimit(owner);
            return snapshot;
        }
        catch (error) {
            this.sessions.delete(id);
            // Launch sessions own the (possibly half-started) debuggee: kill it.
            await session.disconnect(true);
            throw error;
        }
    }
    async attach(owner, request, signal) {
        const spec = this.deps.resolveAdapter({ adapter: request.adapterId, program: request.program ?? '' });
        const id = `dbg-${this.nextId++}`;
        const spawned = await this.deps.spawn(spec);
        const session = new DebugSession(id, spec.command, request.program ?? `pid:${request.processId}`, spawned, this.deps.limits, 'attach', this.nextId, this.ledger, spec.exceptionFilterMap);
        session.noteCwd(request.cwd);
        session.wireEvents();
        session.recordLedger('session_start', {
            mode: 'attach',
            adapter: spec.command,
            program: request.program ?? `pid:${request.processId}`,
            cwd: request.cwd,
        });
        this.sessions.set(id, { session, owner });
        try {
            const snapshot = await session.attach({
                processId: request.processId,
                args: request.args,
                cwd: request.cwd,
                stopOnEntry: request.stopOnEntry ?? false,
                launchArgs: spec.launchArgs,
                stopOnEntryKey: spec.stopOnEntryKey,
                signal,
            });
            this.activeByOwner.set(owner, id);
            this.evictIfOverLimit(owner);
            return snapshot;
        }
        catch (error) {
            this.sessions.delete(id);
            // Attach sessions never own the target: leave the foreign process alone.
            await session.disconnect(false);
            throw error;
        }
    }
    sessionFor(owner, id) {
        let record;
        if (id !== undefined) {
            record = this.sessions.get(id);
            if (record === undefined)
                throw new DebugError('no_session', `No debug session '${id}'.`);
            if (record.owner !== owner)
                throw new DebugError('foreign_session', `Debug session '${id}' belongs to another agent.`);
            record.session.touch();
            return record.session;
        }
        const activeId = this.activeByOwner.get(owner);
        if (activeId === undefined) {
            throw new DebugError('no_active_session', 'No active debug session. Launch first with action "launch".');
        }
        record = this.sessions.get(activeId);
        if (record === undefined) {
            throw new DebugError('no_active_session', 'No active debug session. Launch first with action "launch".');
        }
        record.session.touch();
        return record.session;
    }
    list(owner) {
        return [...this.sessions.values()].filter(record => record.owner === owner).map(record => record.session.snapshot());
    }
    /** Query the session trace ledger (跨会话、跨重启可回溯)。 */
    ledgerQuery(options) {
        return this.ledger.query(options);
    }
    /** Ledger: record one model-action failure with its stable error code. */
    recordError(error, sessionId) {
        const detail = {
            message: error instanceof Error ? error.message : String(error),
        };
        if (error instanceof DebugError)
            detail.code = error.code;
        this.ledger.record(sessionId, 'request_error', detail);
    }
    async disconnect(owner, id, terminateDebuggee) {
        const session = id === undefined ? this.tryActive(owner) : this.sessionFor(owner, id);
        if (session === undefined)
            return undefined;
        this.sessions.delete(session.id);
        const snapshot = { ...session.snapshot(), status: 'terminated' };
        await session.disconnect(terminateDebuggee);
        return snapshot;
    }
    async disposeAll() {
        if (this.reaper !== undefined) {
            clearInterval(this.reaper);
            this.reaper = undefined;
        }
        // Sessions we launched own their debuggee, so teardown terminates it;
        // attach sessions must leave the foreign process running.
        const pending = [...this.sessions.values()].map(record => record.session.disconnect(record.session.launchMode === 'launch'));
        this.sessions.clear();
        await Promise.allSettled(pending);
    }
    tryActive(owner) {
        const activeId = this.activeByOwner.get(owner);
        if (activeId === undefined)
            return undefined;
        const record = this.sessions.get(activeId);
        return record?.session;
    }
    /** Disconnect sessions idle longer than `idleMs`. */
    async reapIdle(idleMs) {
        const stale = [...this.sessions.entries()].filter(([, record]) => record.session.idleMs() > idleMs);
        for (const [id, record] of stale) {
            this.sessions.delete(id);
            if (this.activeByOwner.get(record.owner) === id)
                this.activeByOwner.delete(record.owner);
            await record.session.disconnect(record.session.launchMode === 'launch');
        }
    }
    /** Evict the oldest session beyond the per-owner cap, if any. */
    evictIfOverLimit(owner) {
        if (this.maxPerOwner <= 0)
            return;
        const owned = [...this.sessions.entries()].filter(([, record]) => record.owner === owner);
        if (owned.length <= this.maxPerOwner)
            return;
        const activeId = this.activeByOwner.get(owner);
        // Most-idle first (descending idleMs); createdSeq breaks timestamp ties.
        // The owner's active session is pinned to the end so eviction never
        // silently disconnects the session the model is actually using.
        owned.sort((a, b) => {
            const aActive = a[0] === activeId ? 1 : 0;
            const bActive = b[0] === activeId ? 1 : 0;
            if (aActive !== bActive)
                return aActive - bActive;
            const byActivity = b[1].session.idleMs() - a[1].session.idleMs();
            return byActivity !== 0 ? byActivity : a[1].session.createdSeq - b[1].session.createdSeq;
        });
        const excess = owned.length - this.maxPerOwner;
        for (let i = 0; i < excess; i += 1) {
            const [id, record] = owned[i];
            this.sessions.delete(id);
            if (this.activeByOwner.get(record.owner) === id)
                this.activeByOwner.delete(record.owner);
            void record.session.disconnect(record.session.launchMode === 'launch');
        }
    }
}
/** Re-exported so the tool layer can catch adapter resolution failures uniformly. */
export { AdapterUnavailableError } from './adapters.js';
//# sourceMappingURL=session.js.map