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
/**
 * Read the capabilities subset used by this plugin. Per the DAP spec the
 * `initialize` response body (and the `capabilities` event body) IS the
 * Capabilities object — its fields sit at the top level, not nested under
 * a `capabilities` key.
 */
export function readCapabilities(body) {
    if (body === undefined)
        return {};
    return {
        supportsConfigurationDoneRequest: readBoolean(body.supportsConfigurationDoneRequest),
        supportsTerminateRequest: readBoolean(body.supportsTerminateRequest),
        supportsRestartRequest: readBoolean(body.supportsRestartRequest),
        supportsSetVariable: readBoolean(body.supportsSetVariable),
        supportsSetExpression: readBoolean(body.supportsSetExpression),
        supportsConditionalBreakpoints: readBoolean(body.supportsConditionalBreakpoints),
        supportsFunctionBreakpoints: readBoolean(body.supportsFunctionBreakpoints),
        supportsExceptionOptions: readBoolean(body.supportsExceptionOptions),
        supportsExceptionInfoRequest: readBoolean(body.supportsExceptionInfoRequest),
        supportsTerminateThreadsRequest: readBoolean(body.supportsTerminateThreadsRequest),
        supportsLoadedSourcesRequest: readBoolean(body.supportsLoadedSourcesRequest),
        supportsModulesRequest: readBoolean(body.supportsModulesRequest),
        supportsDataBreakpoints: readBoolean(body.supportsDataBreakpoints),
        supportsStepBack: readBoolean(body.supportsStepBack),
        supportsGotoTargetsRequest: readBoolean(body.supportsGotoTargetsRequest),
        supportsRestartFrame: readBoolean(body.supportsRestartFrame),
        supportsDisassembleRequest: readBoolean(body.supportsDisassembleRequest),
        supportsReadMemoryRequest: readBoolean(body.supportsReadMemoryRequest),
        supportsCompletionsRequest: readBoolean(body.supportsCompletionsRequest),
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
        const source = readSourceRef(record.source);
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
function readSourceRef(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    return {
        path: readString(record.path),
        name: readString(record.name),
        sourceReference: readNumber(record.sourceReference),
    };
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
export function readSource(body) {
    const record = body ?? {};
    return {
        content: readString(record.content) ?? '',
        mimeType: readString(record.mimeType),
    };
}
export function readLoadedSources(body) {
    const raw = body?.sources;
    if (!Array.isArray(raw))
        return [];
    const sources = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        sources.push({
            path: readString(record.path),
            name: readString(record.name),
            sourceReference: readNumber(record.sourceReference),
        });
    }
    return sources;
}
export function readModules(body) {
    const raw = body?.modules;
    if (!Array.isArray(raw))
        return [];
    const modules = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const id = record.id;
        if (id === undefined)
            continue;
        modules.push({
            id: typeof id === 'number' || typeof id === 'string' ? id : String(id),
            name: readString(record.name),
            path: readString(record.path),
            version: readString(record.version),
            loaded: readBoolean(record.loaded),
        });
    }
    return modules;
}
export function readDataBreakpoints(body) {
    const raw = body?.breakpoints;
    if (!Array.isArray(raw))
        return [];
    const breakpoints = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        breakpoints.push({
            id: readNumber(record.id),
            verified: readBoolean(record.verified) ?? false,
            message: readString(record.message),
        });
    }
    return breakpoints;
}
export function readGotoTargets(body) {
    const raw = body?.targets;
    if (!Array.isArray(raw))
        return [];
    const targets = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const id = readNumber(record.id);
        if (id === undefined)
            continue;
        targets.push({ id, label: readString(record.label) ?? `line ${record.line}`, line: readNumber(record.line) ?? 0 });
    }
    return targets;
}
export function readDisassembledInstructions(body) {
    const raw = body?.instructions;
    if (!Array.isArray(raw))
        return [];
    const instructions = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const address = readString(record.address);
        const instruction = readString(record.instruction);
        if (address === undefined || instruction === undefined)
            continue;
        instructions.push({
            address,
            instructionBytes: readString(record.instructionBytes),
            instruction,
            symbol: readString(record.symbol),
            location: readSourceRef(record.location),
            line: readNumber(record.line),
            column: readNumber(record.column),
        });
    }
    return instructions;
}
export function readMemoryResult(body) {
    return {
        address: readString(body?.address) ?? '0x0',
        unreadableBytes: readNumber(body?.unreadableBytes),
        data: readString(body?.data),
    };
}
export function readDataBreakpointInfo(body) {
    const rawAccess = body?.accessTypes;
    const accessTypes = [];
    if (Array.isArray(rawAccess)) {
        for (const item of rawAccess) {
            if (item === 'read' || item === 'write' || item === 'readWrite') {
                accessTypes.push(item);
            }
        }
    }
    return {
        dataId: readString(body?.dataId) ?? null,
        description: readString(body?.description) ?? '',
        accessTypes: accessTypes.length > 0 ? accessTypes : undefined,
        canPersist: readBoolean(body?.canPersist),
    };
}
export function readCompletions(body) {
    const raw = body?.targets;
    if (!Array.isArray(raw))
        return [];
    const items = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const label = readString(record.label);
        if (label === undefined)
            continue;
        items.push({
            label,
            text: readString(record.text),
            sortText: readString(record.sortText),
            detail: readString(record.detail),
            type: readString(record.type),
            start: readNumber(record.start),
            length: readNumber(record.length),
        });
    }
    return items;
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