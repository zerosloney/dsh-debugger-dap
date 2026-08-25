/**
 * Minimal Debug Adapter Protocol wire vocabulary. Only the operations and
 * payloads this plugin exchanges are modeled; every body is read defensively
 * because adapter output is an untrusted process boundary.
 */

/** Base fields shared by every DAP message. */
interface DapMessageBase {
  seq?: number
  type?: string
}

/** Client-to-adapter request. */
export interface DapRequest extends DapMessageBase {
  type: 'request'
  command: string
  arguments?: Record<string, unknown>
}

/** Adapter-to-client response. */
export interface DapResponse extends DapMessageBase {
  type: 'response'
  request_seq?: number
  success?: boolean
  command?: string
  message?: string
  body?: Record<string, unknown>
}

/** Adapter-to-client event. */
export interface DapEvent extends DapMessageBase {
  type: 'event'
  event: string
  body?: Record<string, unknown>
}

export type DapMessage = DapRequest | DapResponse | DapEvent

/** Classify one decoded JSON object into the DAP message union, or `undefined` when malformed. */
export function classifyDapMessage(message: unknown): DapMessage | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const record = message as Record<string, unknown>
  if (record.type === 'request' && typeof record.command === 'string') return record as unknown as DapRequest
  if (record.type === 'response') return record as unknown as DapResponse
  if (record.type === 'event' && typeof record.event === 'string') return record as unknown as DapEvent
  return undefined
}

// ---- Typed payload views (defensive readers) ----

/** `initialize` response capabilities subset used by this plugin. */
export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean
  supportsTerminateRequest?: boolean
  supportsRestartRequest?: boolean
  supportsSetVariable?: boolean
  supportsSetExpression?: boolean
  supportsConditionalBreakpoints?: boolean
  supportsFunctionBreakpoints?: boolean
  supportsExceptionOptions?: boolean
  supportsExceptionInfoRequest?: boolean
  supportsTerminateThreadsRequest?: boolean
  supportsLoadedSourcesRequest?: boolean
  supportsModulesRequest?: boolean
  supportsDataBreakpoints?: boolean
  supportsStepBack?: boolean
  supportsGotoTargetsRequest?: boolean
  supportsRestartFrame?: boolean
  supportsDisassembleRequest?: boolean
  supportsReadMemoryRequest?: boolean
  supportsCompletionsRequest?: boolean
}

export function readCapabilities(body: Record<string, unknown> | undefined): DapCapabilities {
  if (body === undefined) return {}
  const raw = body.capabilities
  if (raw === null || typeof raw !== 'object') return {}
  const record = raw as Record<string, unknown>
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
    supportsLoadedSourcesRequest: readBoolean(record.supportsLoadedSourcesRequest),
    supportsModulesRequest: readBoolean(record.supportsModulesRequest),
    supportsDataBreakpoints: readBoolean(record.supportsDataBreakpoints),
    supportsStepBack: readBoolean(record.supportsStepBack),
    supportsGotoTargetsRequest: readBoolean(record.supportsGotoTargetsRequest),
    supportsRestartFrame: readBoolean(record.supportsRestartFrame),
    supportsDisassembleRequest: readBoolean(record.supportsDisassembleRequest),
    supportsReadMemoryRequest: readBoolean(record.supportsReadMemoryRequest),
    supportsCompletionsRequest: readBoolean(record.supportsCompletionsRequest),
  }
}

/** `stopped` event body. */
export interface DapStoppedEvent {
  reason?: string
  description?: string
  threadId?: number
  allThreadsStopped?: boolean
  text?: string
}

export function readStoppedEvent(body: Record<string, unknown> | undefined): DapStoppedEvent {
  const record = body ?? {}
  return {
    reason: readString(record.reason),
    description: readString(record.description),
    threadId: readNumber(record.threadId),
    allThreadsStopped: readBoolean(record.allThreadsStopped),
    text: readString(record.text),
  }
}

/** `output` event body. */
export interface DapOutputEvent {
  category?: string
  output: string
}

export function readOutputEvent(body: Record<string, unknown> | undefined): DapOutputEvent {
  const record = body ?? {}
  return { category: readString(record.category), output: readString(record.output) ?? '' }
}

/** `exited` event body. */
export function readExitCode(body: Record<string, unknown> | undefined): number | undefined {
  return readNumber(body?.exitCode)
}

export interface DapThread {
  id: number
  name: string
}

export function readThreads(body: Record<string, unknown> | undefined): DapThread[] {
  const raw = body?.threads
  if (!Array.isArray(raw)) return []
  const threads: DapThread[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = readNumber(record.id)
    if (id === undefined) continue
    threads.push({ id, name: readString(record.name) ?? `thread ${id}` })
  }
  return threads
}

export interface DapSource {
  path?: string
  name?: string
  sourceReference?: number
}

export interface DapStackFrame {
  id: number
  name: string
  source?: DapSource
  line: number
  column: number
}

export function readStackFrames(body: Record<string, unknown> | undefined): DapStackFrame[] {
  const raw = body?.stackFrames
  if (!Array.isArray(raw)) return []
  const frames: DapStackFrame[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = readNumber(record.id)
    if (id === undefined) continue
    const source = readSourceRef(record.source)
    frames.push({
      id,
      name: readString(record.name) ?? `frame ${id}`,
      source,
      line: readNumber(record.line) ?? 0,
      column: readNumber(record.column) ?? 0,
    })
  }
  return frames
}

function readSourceRef(value: unknown): DapSource | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return {
    path: readString(record.path),
    name: readString(record.name),
    sourceReference: readNumber(record.sourceReference),
  }
}

export interface DapScope {
  name: string
  variablesReference: number
  expensive: boolean
  namedVariables?: number
  indexedVariables?: number
}

export function readScopes(body: Record<string, unknown> | undefined): DapScope[] {
  const raw = body?.scopes
  if (!Array.isArray(raw)) return []
  const scopes: DapScope[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const ref = readNumber(record.variablesReference)
    if (ref === undefined) continue
    scopes.push({
      name: readString(record.name) ?? `scope ${ref}`,
      variablesReference: ref,
      expensive: readBoolean(record.expensive) ?? false,
      namedVariables: readNumber(record.namedVariables),
      indexedVariables: readNumber(record.indexedVariables),
    })
  }
  return scopes
}

export interface DapVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
}

export function readVariables(body: Record<string, unknown> | undefined): DapVariable[] {
  const raw = body?.variables
  if (!Array.isArray(raw)) return []
  const variables: DapVariable[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = readString(record.name)
    if (name === undefined) continue
    variables.push({
      name,
      value: readString(record.value) ?? '',
      type: readString(record.type),
      variablesReference: readNumber(record.variablesReference) ?? 0,
      namedVariables: readNumber(record.namedVariables),
      indexedVariables: readNumber(record.indexedVariables),
    })
  }
  return variables
}

export interface DapEvaluation {
  result: string
  type?: string
  variablesReference: number
}

export function readEvaluation(body: Record<string, unknown> | undefined): DapEvaluation {
  const record = body ?? {}
  return {
    result: readString(record.result) ?? '',
    type: readString(record.type),
    variablesReference: readNumber(record.variablesReference) ?? 0,
  }
}

/** Shared result shape of `setVariable` / `setExpression` and `evaluate`. */
export interface DapSetResult {
  value: string
  type?: string
  variablesReference: number
}

export function readSetResult(body: Record<string, unknown> | undefined): DapSetResult {
  const record = body ?? {}
  return {
    value: readString(record.value) ?? '',
    type: readString(record.type),
    variablesReference: readNumber(record.variablesReference) ?? 0,
  }
}

/** `exceptionInfo` response. */
export interface DapExceptionInfo {
  exceptionId: string
  description?: string
  breakMode?: string
  message?: string
  typeName?: string
  stack?: string
}

export function readExceptionInfo(body: Record<string, unknown> | undefined): DapExceptionInfo {
  const record = body ?? {}
  const details = record.details as Record<string, unknown> | undefined
  return {
    exceptionId: readString(record.exceptionId) ?? '',
    description: readString(record.description),
    breakMode: readString(record.breakMode),
    message: readString(details?.message),
    typeName: readString(details?.typeName),
    stack: readString(details?.stackTrace),
  }
}

/** One resolved breakpoint as reported by the adapter. */
export interface DapBreakpoint {
  verified: boolean
  line?: number
  message?: string
}

export function readBreakpoints(body: Record<string, unknown> | undefined): DapBreakpoint[] {
  const raw = body?.breakpoints
  if (!Array.isArray(raw)) return []
  const breakpoints: DapBreakpoint[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    breakpoints.push({
      verified: readBoolean(record.verified) ?? false,
      line: readNumber(record.line),
      message: readString(record.message),
    })
  }
  return breakpoints
}

/** `source` response: contents of a source file. */
export interface DapSourceContent {
  content: string
  mimeType?: string
}

export function readSource(body: Record<string, unknown> | undefined): DapSourceContent {
  const record = body ?? {}
  return {
    content: readString(record.content) ?? '',
    mimeType: readString(record.mimeType),
  }
}

/** `loadedSources` response: all source files currently loaded in the debuggee. */
export interface DapLoadedSource {
  path?: string
  name?: string
  sourceReference?: number
}

export function readLoadedSources(body: Record<string, unknown> | undefined): DapLoadedSource[] {
  const raw = body?.sources
  if (!Array.isArray(raw)) return []
  const sources: DapLoadedSource[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    sources.push({
      path: readString(record.path),
      name: readString(record.name),
      sourceReference: readNumber(record.sourceReference),
    })
  }
  return sources
}

/** `modules` response: loaded program modules or shared libraries. */
export interface DapModule {
  id: number | string
  name?: string
  path?: string
  version?: string
  loaded?: boolean
}

export function readModules(body: Record<string, unknown> | undefined): DapModule[] {
  const raw = body?.modules
  if (!Array.isArray(raw)) return []
  const modules: DapModule[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = record.id
    if (id === undefined) continue
    modules.push({
      id: typeof id === 'number' || typeof id === 'string' ? id : String(id),
      name: readString(record.name),
      path: readString(record.path),
      version: readString(record.version),
      loaded: readBoolean(record.loaded),
    })
  }
  return modules
}

/** `setDataBreakpoints` response: verified data breakpoints. */
export interface DapDataBreakpoint {
  id?: number
  verified: boolean
  message?: string
}

export function readDataBreakpoints(body: Record<string, unknown> | undefined): DapDataBreakpoint[] {
  const raw = body?.breakpoints
  if (!Array.isArray(raw)) return []
  const breakpoints: DapDataBreakpoint[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    breakpoints.push({
      id: readNumber(record.id),
      verified: readBoolean(record.verified) ?? false,
      message: readString(record.message),
    })
  }
  return breakpoints
}

/** `gotoTargets` response: valid jump targets for `goto`. */
export interface DapGotoTarget {
  id: number
  label: string
  line: number
}

export function readGotoTargets(body: Record<string, unknown> | undefined): DapGotoTarget[] {
  const raw = body?.targets
  if (!Array.isArray(raw)) return []
  const targets: DapGotoTarget[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = readNumber(record.id)
    if (id === undefined) continue
    targets.push({ id, label: readString(record.label) ?? `line ${record.line}`, line: readNumber(record.line) ?? 0 })
  }
  return targets
}

/** `disassemble` response: one disassembled instruction. */
export interface DapDisassembledInstruction {
  address: string
  instructionBytes?: string
  instruction: string
  symbol?: string
  location?: DapSource
  line?: number
  column?: number
}

export function readDisassembledInstructions(body: Record<string, unknown> | undefined): DapDisassembledInstruction[] {
  const raw = body?.instructions
  if (!Array.isArray(raw)) return []
  const instructions: DapDisassembledInstruction[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const address = readString(record.address)
    const instruction = readString(record.instruction)
    if (address === undefined || instruction === undefined) continue
    instructions.push({
      address,
      instructionBytes: readString(record.instructionBytes),
      instruction,
      symbol: readString(record.symbol),
      location: readSourceRef(record.location),
      line: readNumber(record.line),
      column: readNumber(record.column),
    })
  }
  return instructions
}

/** `readMemory` response. */
export interface DapReadMemoryResult {
  address: string
  unreadableBytes?: number
  data?: string
}

export function readMemoryResult(body: Record<string, unknown> | undefined): DapReadMemoryResult {
  return {
    address: readString(body?.address) ?? '0x0',
    unreadableBytes: readNumber(body?.unreadableBytes),
    data: readString(body?.data),
  }
}

/** `dataBreakpointInfo` response. */
export interface DapDataBreakpointInfo {
  dataId: string | null
  description: string
  accessTypes?: ('read' | 'write' | 'readWrite')[]
  canPersist?: boolean
}

export function readDataBreakpointInfo(body: Record<string, unknown> | undefined): DapDataBreakpointInfo {
  const rawAccess = body?.accessTypes
  const accessTypes: ('read' | 'write' | 'readWrite')[] = []
  if (Array.isArray(rawAccess)) {
    for (const item of rawAccess) {
      if (item === 'read' || item === 'write' || item === 'readWrite') {
        accessTypes.push(item)
      }
    }
  }
  return {
    dataId: readString(body?.dataId) ?? null,
    description: readString(body?.description) ?? '',
    accessTypes: accessTypes.length > 0 ? accessTypes : undefined,
    canPersist: readBoolean(body?.canPersist),
  }
}

/** `completions` response: one completion target. */
export interface DapCompletionItem {
  label: string
  text?: string
  sortText?: string
  detail?: string
  type?: string
  start?: number
  length?: number
}

export function readCompletions(body: Record<string, unknown> | undefined): DapCompletionItem[] {
  const raw = body?.targets
  if (!Array.isArray(raw)) return []
  const items: DapCompletionItem[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = readString(record.label)
    if (label === undefined) continue
    items.push({
      label,
      text: readString(record.text),
      sortText: readString(record.sortText),
      detail: readString(record.detail),
      type: readString(record.type),
      start: readNumber(record.start),
      length: readNumber(record.length),
    })
  }
  return items
}

// ---- Defensive primitive readers ----

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
