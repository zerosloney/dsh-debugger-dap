/**
 * Minimal Debug Adapter Protocol wire vocabulary. Only the operations and
 * payloads this plugin exchanges are modeled; every body is read defensively
 * because adapter output is an untrusted process boundary.
 */
/** Classify one decoded JSON object into the DAP message union, or `undefined` when malformed. */
export function classifyDapMessage(message) {
    if (message === null || typeof message !== 'object')
        return undefined;
    const record = message;
    if (record.type === 'request' && typeof record.command === 'string')
        return record;
    if (record.type === 'response')
        return record;
    if (record.type === 'event' && typeof record.event === 'string')
        return record;
    return undefined;
}
export function readCapabilities(body) {
    if (body === undefined)
        return {};
    const raw = body.capabilities;
    if (raw === null || typeof raw !== 'object')
        return {};
    const record = raw;
    return {
        supportsConfigurationDoneRequest: readBoolean(record.supportsConfigurationDoneRequest),
        supportsTerminateRequest: readBoolean(record.supportsTerminateRequest),
        supportsRestartRequest: readBoolean(record.supportsRestartRequest),
        supportsSetVariable: readBoolean(record.supportsSetVariable),
        supportsSetExpression: readBoolean(record.supportsSetExpression),
        supportsConditionalBreakpoints: readBoolean(record.supportsConditionalBreakpoints),
        supportsFunctionBreakpoints: readBoolean(record.supportsFunctionBreakpoints),
        supportsExceptionOptions: readBoolean(record.supportsExceptionOptions),
        supportsExceptionInfoRequest: readBoolean(record.supportsExceptionInfoRequest),
        supportsTerminateThreadsRequest: readBoolean(record.supportsTerminateThreadsRequest),
    };
}
export function readStoppedEvent(body) {
    const record = body ?? {};
    return {
        reason: readString(record.reason),
        description: readString(record.description),
        threadId: readNumber(record.threadId),
        allThreadsStopped: readBoolean(record.allThreadsStopped),
        text: readString(record.text),
    };
}
export function readOutputEvent(body) {
    const record = body ?? {};
    return { category: readString(record.category), output: readString(record.output) ?? '' };
}
/** `exited` event body. */
export function readExitCode(body) {
    return readNumber(body?.exitCode);
}
export function readThreads(body) {
    const raw = body?.threads;
    if (!Array.isArray(raw))
        return [];
    const threads = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const id = readNumber(record.id);
        if (id === undefined)
            continue;
        threads.push({ id, name: readString(record.name) ?? `thread ${id}` });
    }
    return threads;
}
export function readStackFrames(body) {
    const raw = body?.stackFrames;
    if (!Array.isArray(raw))
        return [];
    const frames = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const id = readNumber(record.id);
        if (id === undefined)
            continue;
        const source = readSource(record.source);
        frames.push({
            id,
            name: readString(record.name) ?? `frame ${id}`,
            source,
            line: readNumber(record.line) ?? 0,
            column: readNumber(record.column) ?? 0,
        });
    }
    return frames;
}
function readSource(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    return { path: readString(record.path), name: readString(record.name) };
}
export function readScopes(body) {
    const raw = body?.scopes;
    if (!Array.isArray(raw))
        return [];
    const scopes = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const ref = readNumber(record.variablesReference);
        if (ref === undefined)
            continue;
        scopes.push({
            name: readString(record.name) ?? `scope ${ref}`,
            variablesReference: ref,
            expensive: readBoolean(record.expensive) ?? false,
            namedVariables: readNumber(record.namedVariables),
            indexedVariables: readNumber(record.indexedVariables),
        });
    }
    return scopes;
}
export function readVariables(body) {
    const raw = body?.variables;
    if (!Array.isArray(raw))
        return [];
    const variables = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const name = readString(record.name);
        if (name === undefined)
            continue;
        variables.push({
            name,
            value: readString(record.value) ?? '',
            type: readString(record.type),
            variablesReference: readNumber(record.variablesReference) ?? 0,
            namedVariables: readNumber(record.namedVariables),
            indexedVariables: readNumber(record.indexedVariables),
        });
    }
    return variables;
}
export function readEvaluation(body) {
    const record = body ?? {};
    return {
        result: readString(record.result) ?? '',
        type: readString(record.type),
        variablesReference: readNumber(record.variablesReference) ?? 0,
    };
}
export function readSetResult(body) {
    const record = body ?? {};
    return {
        value: readString(record.value) ?? '',
        type: readString(record.type),
        variablesReference: readNumber(record.variablesReference) ?? 0,
    };
}
export function readExceptionInfo(body) {
    const record = body ?? {};
    const details = record.details;
    return {
        exceptionId: readString(record.exceptionId) ?? '',
        description: readString(record.description),
        breakMode: readString(record.breakMode),
        message: readString(details?.message),
        typeName: readString(details?.typeName),
        stack: readString(details?.stackTrace),
    };
}
export function readBreakpoints(body) {
    const raw = body?.breakpoints;
    if (!Array.isArray(raw))
        return [];
    const breakpoints = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        breakpoints.push({
            verified: readBoolean(record.verified) ?? false,
            line: readNumber(record.line),
            message: readString(record.message),
        });
    }
    return breakpoints;
}
// ---- Defensive primitive readers ----
export function readString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function readBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
//# sourceMappingURL=protocol.js.map