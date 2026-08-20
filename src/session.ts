/**
 * Debug session state machine and the owner-scoped session registry. One
 * session owns one adapter process; every model-facing result carries a
 * snapshot so the model always knows where the debuggee is.
 */

import { AdapterUnavailableError, type AdapterSpec } from './adapters.js'
import { DapConnection, DapDisconnectedError, type SpawnedAdapter } from './connection.js'
import {
  readBreakpoints,
  readCapabilities,
  readDataBreakpoints,
  readEvaluation,
  readExceptionInfo,
  readExitCode,
  readGotoTargets,
  readLoadedSources,
  readModules,
  readOutputEvent,
  readScopes,
  readSetResult,
  readSource,
  readStackFrames,
  readStoppedEvent,
  readThreads,
  readVariables,
  type DapCapabilities,
  type DapDataBreakpoint,
  type DapExceptionInfo,
  type DapGotoTarget,
  type DapLoadedSource,
  type DapModule,
  type DapScope,
  type DapSetResult,
  type DapSourceContent,
  type DapStackFrame,
  type DapThread,
  type DapVariable,
} from './protocol.js'

/** Session status as folded from DAP events. */
export type DebugStatus = 'configuring' | 'running' | 'stopped' | 'terminated'

/** Tunables carried from plugin config into every session. */
export interface SessionLimits {
  requestTimeoutMs: number
  stepTimeoutMs: number
  maxOutputChars: number
  maxStackFrames: number
  maxVariables: number
  maxResultChars: number
}

/** Where the debuggee currently is; part of every model-facing result. */
export interface DebugSnapshot {
  id: string
  adapter: string
  program: string
  cwd?: string
  status: DebugStatus
  stopReason?: string
  threadId?: number
  frame?: { id: number; name: string; path?: string; line: number; column: number }
  exitCode?: number
  configuring: boolean
  outputChars: number
}

/** One breakpoint as resolved by the adapter. */
export interface BreakpointRecord {
  line: number
  verified: boolean
  message?: string
  actualLine?: number
}

/** Outcome of a resume-class action (continue / step / pause). */
export interface StepOutcome {
  state: 'stopped' | 'running' | 'terminated'
  timedOut: boolean
  snapshot: DebugSnapshot
}

/** Page of captured debuggee output. */
export interface OutputPage {
  text: string
  offset: number
  totalChars: number
  truncated: boolean
}

/** Domain error with a stable code the tool layer can render. */
export class DebugError extends Error {
  constructor(
    readonly code:
      | 'no_session'
      | 'no_active_session'
      | 'foreign_session'
      | 'not_stopped'
      | 'no_thread'
      | 'invalid_arguments'
      | 'not_supported',
    message: string,
  ) {
    super(message)
    this.name = 'DebugError'
  }
}

export type SpawnAdapterFn = (spec: AdapterSpec) => SpawnedAdapter | Promise<SpawnedAdapter>

interface StopWaiter {
  resolve: (state: 'stopped' | 'terminated') => void
  timer: ReturnType<typeof setTimeout> | undefined
  onAbort: (() => void) | undefined
}

/** One live debug session: adapter connection plus folded state. */
export class DebugSession {
  status: DebugStatus = 'configuring'
  stopReason: string | undefined
  exitCode: number | undefined
  activeThreadId: number | undefined
  currentFrame: DapStackFrame | undefined
  capabilities: DapCapabilities = {}
  private stopReasonDescription: string | undefined
  private configurationDoneSent = false
  private readonly outputLines: string[] = []
  private outputChars = 0
  private evictedChars = 0
  private stopWaiter: StopWaiter | undefined
  private readonly breakpointsByFile = new Map<string, BreakpointRecord[]>()
  private readonly detach: Array<() => void> = []
  private disposed = false
  private cwdValue: string | undefined
  private initializedSeen = false

  constructor(
    readonly id: string,
    readonly adapterId: string,
    readonly program: string,
    private readonly spawned: SpawnedAdapter,
    private readonly limits: SessionLimits,
  ) {}

  get connection(): DapConnection {
    return this.spawned.connection
  }

  noteCwd(cwd: string | undefined): void {
    this.cwdValue = cwd
  }

  wireEvents(): void {
    const { connection } = this
    this.detach.push(
      connection.onEvent('initialized', () => {
        this.initializedSeen = true
      }),
      connection.onEvent('stopped', body => {
        const stopped = readStoppedEvent(body)
        this.status = 'stopped'
        this.stopReason = stopped.reason
        this.stopReasonDescription = stopped.description
        if (stopped.threadId !== undefined) this.activeThreadId = stopped.threadId
        this.wakeStopWaiter('stopped')
      }),
      connection.onEvent('thread', () => {}),
      connection.onEvent('terminated', () => {
        this.status = 'terminated'
        this.wakeStopWaiter('terminated')
      }),
      connection.onEvent('exited', body => {
        this.exitCode = readExitCode(body)
      }),
      connection.onEvent('output', body => {
        const output = readOutputEvent(body)
        this.appendOutput(output.category === 'stderr' ? `[stderr] ${output.output}` : output.output)
      }),
      connection.onEvent('capabilities', body => {
        this.capabilities = { ...this.capabilities, ...readCapabilities(body) }
      }),
      connection.onClose(() => {
        if (this.status !== 'terminated') {
          this.status = 'terminated'
          this.wakeStopWaiter('terminated')
        }
      }),
    )
  }

  private async start(
    mode: 'launch' | 'attach',
    body: Record<string, unknown>,
    stopOnEntry: boolean,
    stopOnEntryKey: string,
    signal?: AbortSignal,
  ): Promise<DebugSnapshot> {
    try {
      const initBody = await this.connection.send(
        'initialize',
        {
          adapterID: this.adapterId,
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
          supportsVariableType: true,
          supportsRunInTerminalRequest: false,
        },
        { signal },
      )
      this.capabilities = { ...this.capabilities, ...readCapabilities(initBody) }
      await this.connection.send(mode, body, { signal })
      if (!this.initializedSeen) {
        await this.waitForEvent('initialized', this.limits.requestTimeoutMs, signal)
      }
      await this.finishConfiguration(signal)
      if (stopOnEntry) {
        await this.waitForStop(this.limits.requestTimeoutMs, signal)
        if (this.readStatus() === 'stopped') await this.refreshLocation(signal)
      }
      return this.snapshot()
    } catch (error) {
      if (error instanceof DapDisconnectedError) {
        const tail = this.spawned.stderrTail().trim()
        const detail = tail.length > 0 ? ` Adapter stderr: ${tail.slice(-800)}` : ''
        throw new Error(`Debug adapter '${this.adapterId}' exited during ${mode}.${detail}`, { cause: error })
      }
      throw error
    }
  }

  async launch(
    options: {
      args?: readonly string[]
      cwd?: string
      stopOnEntry: boolean
      launchArgs?: Record<string, unknown>
      stopOnEntryKey?: string
      signal?: AbortSignal
    },
  ): Promise<DebugSnapshot> {
    const stopKey = options.stopOnEntryKey ?? 'stopOnEntry'
    return this.start(
      'launch',
      {
        type: 'launch',
        request: 'launch',
        program: this.program,
        args: options.args ?? [],
        cwd: options.cwd,
        [stopKey]: options.stopOnEntry,
        ...options.launchArgs,
      },
      options.stopOnEntry,
      stopKey,
      options.signal,
    )
  }

  async attach(
    options: {
      processId: number
      args?: readonly string[]
      cwd?: string
      stopOnEntry: boolean
      launchArgs?: Record<string, unknown>
      stopOnEntryKey?: string
      signal?: AbortSignal
    },
  ): Promise<DebugSnapshot> {
    const stopKey = options.stopOnEntryKey ?? 'stopOnEntry'
    return this.start(
      'attach',
      {
        request: 'attach',
        processId: options.processId,
        args: options.args ?? [],
        cwd: options.cwd,
        [stopKey]: options.stopOnEntry,
        ...options.launchArgs,
      },
      options.stopOnEntry,
      stopKey,
      options.signal,
    )
  }

  async setBreakpoints(
    file: string,
    lines: readonly { line: number; condition?: string; hitCondition?: string; logMessage?: string }[],
    signal?: AbortSignal,
  ): Promise<BreakpointRecord[]> {
    const body = await this.connection.send(
      'setBreakpoints',
      {
        source: { path: file },
        lines: lines.map(entry => entry.line),
        breakpoints: lines.map(entry => ({
          line: entry.line,
          ...(entry.condition === undefined ? {} : { condition: entry.condition }),
          ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
          ...(entry.logMessage === undefined ? {} : { logMessage: entry.logMessage }),
        })),
      },
      { signal },
    )
    const resolved = readBreakpoints(body)
    const records: BreakpointRecord[] = lines.map((requested, index) => {
      const adapter = resolved[index]
      return {
        line: requested.line,
        verified: adapter?.verified ?? false,
        message: adapter?.message,
        actualLine: adapter?.line,
      }
    })
    this.breakpointsByFile.set(file, records)
    return records
  }

  async resume(
    action: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause',
    signal?: AbortSignal,
  ): Promise<StepOutcome> {
    if (this.status === 'terminated') {
      return { state: 'terminated', timedOut: false, snapshot: this.snapshot() }
    }
    await this.finishConfiguration(signal)
    const threadId = await this.resolveThreadId(signal)
    await this.connection.send(action, { threadId }, { signal })
    if (action !== 'pause') this.status = 'running'
    const timeoutMs = action === 'pause' ? this.limits.requestTimeoutMs : this.limits.stepTimeoutMs
    const state = await this.waitForStop(timeoutMs, signal)
    const finalStatus = this.readStatus()
    const timedOut = state === 'stopped' ? false : finalStatus !== 'terminated'
    if (state === 'stopped') await this.refreshLocation(signal)
    return {
      state: state === 'stopped' && finalStatus === 'stopped' ? 'stopped' : finalStatus === 'terminated' ? 'terminated' : 'running',
      timedOut,
      snapshot: this.snapshot(),
    }
  }

  private readStatus(): DebugStatus {
    return this.status
  }

  async threads(signal?: AbortSignal): Promise<DapThread[]> {
    const body = await this.connection.send('threads', undefined, { signal })
    return readThreads(body)
  }

  async stackTrace(levels: number, signal?: AbortSignal): Promise<DapFrameView[]> {
    const threadId = await this.resolveThreadId(signal)
    const body = await this.connection.send(
      'stackTrace',
      { threadId, startFrame: 0, levels: Math.max(1, Math.min(levels, this.limits.maxStackFrames)) },
      { signal },
    )
    const frames = readStackFrames(body)
    this.currentFrame = frames[0]
    return frames.map(frame => toFrameView(frame))
  }

  async scopes(frameId: number | undefined, signal?: AbortSignal): Promise<DapScope[]> {
    const resolved = frameId ?? this.currentFrame?.id
    if (resolved === undefined) {
      throw new DebugError('not_stopped', 'No current frame: stop at a breakpoint first or pass frame_id from stack_trace.')
    }
    const body = await this.connection.send('scopes', { frameId: resolved }, { signal })
    return readScopes(body)
  }

  async variables(variablesReference: number, signal?: AbortSignal): Promise<{ variables: DapVariable[]; omitted: number }> {
    const body = await this.connection.send('variables', { variablesReference }, { signal })
    const all = readVariables(body)
    const shown = all.slice(0, this.limits.maxVariables)
    return { variables: shown, omitted: all.length - shown.length }
  }

  async evaluate(
    expression: string,
    frameId: number | undefined,
    context: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ result: string; type?: string; variablesReference: number }> {
    const resolved = frameId ?? this.currentFrame?.id
    const body = await this.connection.send(
      'evaluate',
      { expression, context: context ?? 'repl', ...(resolved === undefined ? {} : { frameId: resolved }) },
      { signal },
    )
    return readEvaluation(body)
  }

  async setVariable(variablesReference: number, name: string, value: string, signal?: AbortSignal): Promise<DapSetResult> {
    const body = await this.connection.send('setVariable', { variablesReference, name, value }, { signal })
    return readSetResult(body)
  }

  async setExpression(
    expression: string,
    value: string,
    frameId: number | undefined,
    context: string | undefined,
    signal?: AbortSignal,
  ): Promise<DapSetResult> {
    const resolved = frameId ?? this.currentFrame?.id
    const body = await this.connection.send(
      'setExpression',
      { expression, value, context: context ?? 'repl', ...(resolved === undefined ? {} : { frameId: resolved }) },
      { signal },
    )
    return readSetResult(body)
  }

  async setFunctionBreakpoints(
    functions: readonly { name: string; condition?: string; hitCondition?: string }[],
    signal?: AbortSignal,
  ): Promise<{ name: string; verified: boolean; line?: number; message?: string }[]> {
    const body = await this.connection.send(
      'setFunctionBreakpoints',
      {
        breakpoints: functions.map(entry => ({
          name: entry.name,
          ...(entry.condition === undefined ? {} : { condition: entry.condition }),
          ...(entry.hitCondition === undefined ? {} : { hitCondition: entry.hitCondition }),
        })),
      },
      { signal },
    )
    const resolved = readBreakpoints(body)
    return functions.map((entry, index) => {
      const adapter = resolved[index]
      return { name: entry.name, verified: adapter?.verified ?? false, line: adapter?.line, message: adapter?.message }
    })
  }

  async setExceptionBreakpoints(filters: readonly string[], filterOptions: unknown[] | undefined, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = filterOptions !== undefined && this.capabilities.supportsExceptionOptions
      ? { filterOptions }
      : { filters: [...filters] }
    await this.connection.send('setExceptionBreakpoints', body, { signal })
  }

  async exceptionInfo(threadId: number | undefined, signal?: AbortSignal): Promise<DapExceptionInfo> {
    const resolved = threadId ?? this.activeThreadId
    if (resolved === undefined) {
      throw new DebugError('no_thread', 'No thread to inspect: stop on an exception first or pass thread_id.')
    }
    const body = await this.connection.send('exceptionInfo', { threadId: resolved }, { signal })
    return readExceptionInfo(body)
  }

  async restart(signal?: AbortSignal): Promise<DebugSnapshot> {
    if (this.capabilities.supportsRestartRequest !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'restart'. Upgrade the debugger or launch again.")
    }
    await this.connection.send('restart', undefined, { signal })
    this.status = 'running'
    this.stopReason = undefined
    this.activeThreadId = undefined
    this.currentFrame = undefined
    const state = await this.waitForStop(this.limits.stepTimeoutMs, signal)
    if (state === 'stopped') await this.refreshLocation(signal)
    return this.snapshot()
  }

  async source(signal?: AbortSignal): Promise<DapSourceContent> {
    const frame = this.currentFrame
    if (frame === undefined || frame.source?.path === undefined) {
      throw new DebugError('not_stopped', 'No current frame with a source path: stop at a breakpoint first.')
    }
    const body = await this.connection.send('source', { source: { path: frame.source.path }, sourceReference: 0 }, { signal })
    return readSource(body)
  }

  async loadedSources(signal?: AbortSignal): Promise<DapLoadedSource[]> {
    if (this.capabilities.supportsLoadedSourcesRequest !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'loadedSources'.")
    }
    const body = await this.connection.send('loadedSources', undefined, { signal })
    return readLoadedSources(body)
  }

  async modules(signal?: AbortSignal): Promise<DapModule[]> {
    if (this.capabilities.supportsModulesRequest !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'modules'.")
    }
    const body = await this.connection.send('modules', undefined, { signal })
    return readModules(body)
  }

  async setDataBreakpoints(
    breakpoints: readonly { address?: string; name?: string; accessType?: 'read' | 'write' | 'readWrite' }[],
    signal?: AbortSignal,
  ): Promise<DapDataBreakpoint[]> {
    if (this.capabilities.supportsDataBreakpoints !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'setDataBreakpoints'.")
    }
    const body = await this.connection.send(
      'setDataBreakpoints',
      {
        breakpoints: breakpoints.map(bp => ({
          ...(bp.address !== undefined ? { address: bp.address } : {}),
          ...(bp.name !== undefined ? { name: bp.name } : {}),
          ...(bp.accessType !== undefined ? { accessType: bp.accessType } : {}),
        })),
      },
      { signal },
    )
    return readDataBreakpoints(body)
  }

  async gotoTargets(targetLine: number, signal?: AbortSignal): Promise<DapGotoTarget[]> {
    const frame = this.currentFrame
    if (frame === undefined || frame.source?.path === undefined) {
      throw new DebugError('not_stopped', 'No current frame with a source path: stop at a breakpoint first.')
    }
    if (this.capabilities.supportsGotoTargetsRequest !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'gotoTargets'.")
    }
    const body = await this.connection.send('gotoTargets', { source: { path: frame.source.path }, line: targetLine }, { signal })
    return readGotoTargets(body)
  }

  async goto(targetId: number, signal?: AbortSignal): Promise<DebugSnapshot> {
    if (this.capabilities.supportsGotoTargetsRequest !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'goto'.")
    }
    await this.connection.send('goto', { targetId }, { signal })
    this.status = 'running'
    this.stopReason = undefined
    const state = await this.waitForStop(this.limits.stepTimeoutMs, signal)
    if (state === 'stopped') await this.refreshLocation(signal)
    return this.snapshot()
  }

  async restartFrame(frameId: number | undefined, signal?: AbortSignal): Promise<void> {
    if (this.capabilities.supportsRestartFrame !== true) {
      throw new DebugError('not_supported', "The adapter does not support 'restartFrame'.")
    }
    const resolved = frameId ?? this.currentFrame?.id
    if (resolved === undefined) {
      throw new DebugError('not_stopped', 'No current frame: stop at a breakpoint first or pass frame_id.')
    }
    await this.connection.send('restartFrame', { frameId: resolved }, { signal })
  }

  readOutput(request?: { offset?: number; maxChars?: number }): OutputPage {
    const maxChars = Math.max(200, Math.min(request?.maxChars ?? 4000, this.limits.maxOutputChars))
    const wanted = request?.offset ?? Math.max(0, this.outputChars - maxChars)
    const start = Math.max(wanted, this.evictedChars)
    const truncatedByEviction = start > wanted
    let text = ''
    let position = this.evictedChars
    for (const line of this.outputLines) {
      const end = position + line.length
      if (end <= start) {
        position = end
        continue
      }
      const slice = position >= start ? line : line.slice(start - position)
      if (text.length + slice.length > maxChars) {
        text += slice.slice(0, Math.max(0, maxChars - text.length))
        return { text, offset: start, totalChars: this.outputChars, truncated: true }
      }
      text += slice
      position = end
    }
    return { text, offset: start, totalChars: this.outputChars, truncated: truncatedByEviction }
  }

  snapshot(): DebugSnapshot {
    const frame = this.currentFrame
    return {
      id: this.id,
      adapter: this.adapterId,
      program: this.program,
      cwd: this.cwdValue,
      status: this.status,
      stopReason: this.stopReason,
      threadId: this.activeThreadId,
      frame:
        frame === undefined
          ? undefined
          : { id: frame.id, name: frame.name, path: frame.source?.path, line: frame.line, column: frame.column },
      exitCode: this.exitCode,
      configuring: this.status === 'configuring',
      outputChars: this.outputChars,
    }
  }

  async disconnect(terminateDebuggee: boolean): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.status = 'terminated'
    this.wakeStopWaiter('terminated')
    try {
      await this.connection.send('disconnect', { terminateDebuggee }, { timeoutMs: 2000 })
    } catch {
      // the adapter is gone or refused; the kill below is the authority
    }
    this.connection.dispose()
    await this.spawned.kill()
    for (const detach of this.detach) detach()
  }

  private async finishConfiguration(signal?: AbortSignal): Promise<void> {
    if (this.configurationDoneSent || this.status === 'terminated') return
    if (this.capabilities.supportsConfigurationDoneRequest === false) {
      this.configurationDoneSent = true
      if (this.status === 'configuring') this.status = 'running'
      return
    }
    await this.connection.send('configurationDone', undefined, { signal })
    this.configurationDoneSent = true
    if (this.status === 'configuring') this.status = 'running'
  }

  private async resolveThreadId(signal?: AbortSignal): Promise<number> {
    if (this.activeThreadId !== undefined) return this.activeThreadId
    const threads = await this.threads(signal)
    const thread = threads[0]
    if (thread === undefined) throw new DebugError('no_thread', 'The debuggee reports no threads.')
    this.activeThreadId = thread.id
    return thread.id
  }

  private async refreshLocation(signal?: AbortSignal): Promise<void> {
    try {
      const threadId = this.activeThreadId ?? (await this.resolveThreadId(signal))
      const body = await this.connection.send(
        'stackTrace',
        { threadId, startFrame: 0, levels: 1 },
        { signal, timeoutMs: Math.min(this.limits.requestTimeoutMs, 5000) },
      )
      this.currentFrame = readStackFrames(body)[0]
    } catch {
      // location is best-effort decoration; the stop itself already folded
    }
  }

  private waitForEvent(event: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.connection.onEvent(event, () => {
        cleanup()
        resolve()
      })
      const timer = setTimeout(() => {
        cleanup()
        const error = new Error(`Timed out waiting for the adapter's ${event} event`)
        error.name = 'TimeoutError'
        reject(error)
      }, timeoutMs)
      const onAbort = () => {
        cleanup()
        reject(new Error(`Aborted while waiting for the ${event} event`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private waitForStop(timeoutMs: number, signal?: AbortSignal): Promise<'stopped' | 'terminated' | 'running'> {
    if (this.status === 'stopped') return Promise.resolve('stopped')
    if (this.status === 'terminated') return Promise.resolve('terminated')
    return new Promise<'stopped' | 'terminated' | 'running'>((resolve, reject) => {
      const onAbort = () => {
        this.stopWaiter = undefined
        clearTimeout(waiter.timer)
        reject(new Error('Aborted while waiting for the debuggee to stop'))
      }
      const waiter: StopWaiter = {
        resolve: state => {
          this.stopWaiter = undefined
          clearTimeout(waiter.timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(state)
        },
        timer: undefined,
        onAbort,
      }
      waiter.timer = setTimeout(() => {
        this.stopWaiter = undefined
        signal?.removeEventListener('abort', onAbort)
        resolve(this.status === 'terminated' ? 'terminated' : 'running')
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.stopWaiter = waiter
    })
  }

  private wakeStopWaiter(state: 'stopped' | 'terminated'): void {
    this.stopWaiter?.resolve(state)
  }

  private appendOutput(text: string): void {
    for (const piece of text.split('\n')) {
      const line = piece === '' ? '' : `${piece}\n`
      this.outputLines.push(line)
      this.outputChars += line.length
    }
    while (this.outputChars - this.evictedChars > this.limits.maxOutputChars && this.outputLines.length > 1) {
      const evicted = this.outputLines.shift()
      this.evictedChars += evicted?.length ?? 0
    }
    if (this.outputChars - this.evictedChars > this.limits.maxOutputChars) {
      const head = this.outputLines[0]
      if (head !== undefined) {
        const excess = head.length - (this.outputChars - this.evictedChars - this.limits.maxOutputChars)
        this.outputLines[0] = head.slice(Math.max(0, excess))
        this.evictedChars += Math.max(0, excess)
      }
    }
  }
}

/** Public frame view with an optional source path. */
export interface DapFrameView {
  id: number
  name: string
  path?: string
  line: number
  column: number
}

function toFrameView(frame: DapStackFrame): DapFrameView {
  return { id: frame.id, name: frame.name, path: frame.source?.path, line: frame.line, column: frame.column }
}

/** One launch request as handed to the manager. */
export interface ManagerLaunchRequest {
  adapterId?: string
  program: string
  args?: readonly string[]
  cwd?: string
  stopOnEntry?: boolean
}

/** One attach request as handed to the manager. */
export interface ManagerAttachRequest {
  adapterId?: string
  program?: string
  processId: number
  args?: readonly string[]
  cwd?: string
  stopOnEntry?: boolean
}

/** Owner-scoped registry of live debug sessions. */
export class DebugSessionManager {
  private nextId = 1
  private readonly sessions = new Map<string, { session: DebugSession; owner: object }>()
  private readonly activeByOwner = new WeakMap<object, string>()

  constructor(
    private readonly deps: {
      spawn: SpawnAdapterFn
      resolveAdapter: (options: { adapter?: string; program: string }) => AdapterSpec
      limits: SessionLimits
    },
  ) {}

  async launch(owner: object, request: ManagerLaunchRequest, signal?: AbortSignal): Promise<DebugSnapshot> {
    const spec = this.deps.resolveAdapter({ adapter: request.adapterId, program: request.program })
    const id = `dbg-${this.nextId++}`
    const spawned = await this.deps.spawn(spec)
    const session = new DebugSession(id, spec.command, request.program, spawned, this.deps.limits)
    session.noteCwd(request.cwd)
    session.wireEvents()
    this.sessions.set(id, { session, owner })
    try {
      const snapshot = await session.launch({
        args: request.args,
        cwd: request.cwd,
        stopOnEntry: request.stopOnEntry ?? true,
        launchArgs: spec.launchArgs,
        stopOnEntryKey: spec.stopOnEntryKey,
        signal,
      })
      this.activeByOwner.set(owner, id)
      return snapshot
    } catch (error) {
      this.sessions.delete(id)
      await session.disconnect(false)
      throw error
    }
  }

  async attach(owner: object, request: ManagerAttachRequest, signal?: AbortSignal): Promise<DebugSnapshot> {
    const spec = this.deps.resolveAdapter({ adapter: request.adapterId, program: request.program ?? '' })
    const id = `dbg-${this.nextId++}`
    const spawned = await this.deps.spawn(spec)
    const session = new DebugSession(id, spec.command, request.program ?? `pid:${request.processId}`, spawned, this.deps.limits)
    session.noteCwd(request.cwd)
    session.wireEvents()
    this.sessions.set(id, { session, owner })
    try {
      const snapshot = await session.attach({
        processId: request.processId,
        args: request.args,
        cwd: request.cwd,
        stopOnEntry: request.stopOnEntry ?? false,
        launchArgs: spec.launchArgs,
        stopOnEntryKey: spec.stopOnEntryKey,
        signal,
      })
      this.activeByOwner.set(owner, id)
      return snapshot
    } catch (error) {
      this.sessions.delete(id)
      await session.disconnect(false)
      throw error
    }
  }

  sessionFor(owner: object, id?: string): DebugSession {
    let record: { session: DebugSession; owner: object } | undefined
    if (id !== undefined) {
      record = this.sessions.get(id)
      if (record === undefined) throw new DebugError('no_session', `No debug session '${id}'.`)
      if (record.owner !== owner) throw new DebugError('foreign_session', `Debug session '${id}' belongs to another agent.`)
      return record.session
    }
    const activeId = this.activeByOwner.get(owner)
    if (activeId === undefined) {
      throw new DebugError('no_active_session', 'No active debug session. Launch first with action "launch".')
    }
    record = this.sessions.get(activeId)
    if (record === undefined) {
      throw new DebugError('no_active_session', 'No active debug session. Launch first with action "launch".')
    }
    return record.session
  }

  list(owner: object): DebugSnapshot[] {
    return [...this.sessions.values()].filter(record => record.owner === owner).map(record => record.session.snapshot())
  }

  async disconnect(owner: object, id: string | undefined, terminateDebuggee: boolean): Promise<DebugSnapshot | undefined> {
    const session = id === undefined ? this.tryActive(owner) : this.sessionFor(owner, id)
    if (session === undefined) return undefined
    this.sessions.delete(session.id)
    const snapshot = { ...session.snapshot(), status: 'terminated' as const }
    await session.disconnect(terminateDebuggee)
    return snapshot
  }

  async disposeAll(): Promise<void> {
    const pending = [...this.sessions.values()].map(record => record.session.disconnect(false))
    this.sessions.clear()
    await Promise.allSettled(pending)
  }

  private tryActive(owner: object): DebugSession | undefined {
    const activeId = this.activeByOwner.get(owner)
    if (activeId === undefined) return undefined
    const record = this.sessions.get(activeId)
    return record?.session
  }
}

/** Re-exported so the tool layer can catch adapter resolution failures uniformly. */
export { AdapterUnavailableError }
