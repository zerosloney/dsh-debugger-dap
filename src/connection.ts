/**
 * DAP connection: request/response correlation and event dispatch over a
 * transport abstraction, plus the child-process transport used in production.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { encodeMessage, FramingError, MessageDecoder } from './framing.js'
import { classifyDapMessage, type DapResponse } from './protocol.js'

/** Byte-stream abstraction over the adapter's stdio (or a test double). */
export interface DapTransport {
  /** Queue one framed write; must not throw after close. */
  write(chunk: Buffer): void
  /** Close both directions. Idempotent. */
  close(): void
  /** Subscribe to readable bytes; returns an unsubscribe function. */
  onData(listener: (chunk: Buffer) => void): () => void
  /** Subscribe to transport failures; returns an unsubscribe function. */
  onError(listener: (error: Error) => void): () => void
  /** Subscribe to closure; returns an unsubscribe function. */
  onClose(listener: () => void): () => void
}

/** Error carrying the adapter's own message for one failed DAP request. */
export class DapRequestError extends Error {
  constructor(
    readonly command: string,
    readonly dapMessage: string | undefined,
  ) {
    super(dapMessage === undefined ? `DAP request ${command} failed` : `DAP ${command} failed: ${dapMessage}`)
    this.name = 'DapRequestError'
  }
}

/** Error for operations attempted after the connection closed. */
export class DapDisconnectedError extends Error {
  constructor(readonly cause?: string) {
    super(cause === undefined ? 'DAP adapter connection closed' : `DAP adapter connection closed: ${cause}`)
    this.name = 'DapDisconnectedError'
  }
}

interface PendingRequest {
  resolve: (body: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

function detachAbort(pending: PendingRequest): void {
  if (pending.signal !== undefined && pending.onAbort !== undefined) {
    pending.signal.removeEventListener('abort', pending.onAbort)
  }
}

/** Correlated request/event channel over one {@link DapTransport}. */
export class DapConnection {
  private seq = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventHandlers = new Map<string, Set<(body: Record<string, unknown> | undefined) => void>>()
  private readonly closeHandlers = new Set<() => void>()
  private readonly decoder: MessageDecoder
  private readonly requestTimeoutMs: number
  private closed = false
  private closeReason: string | undefined

  constructor(
    private readonly transport: DapTransport,
    options?: { requestTimeoutMs?: number; maxBodyBytes?: number },
  ) {
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000
    this.decoder = new MessageDecoder({ maxBodyBytes: options?.maxBodyBytes })
    transport.onData(chunk => this.receive(chunk))
    transport.onError(error => this.shutdown(`transport error: ${error.message}`))
    transport.onClose(() => this.shutdown('adapter exited'))
  }

  /** Whether the adapter connection has closed; further sends reject. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Send one request and resolve with the success body. Rejects with
   * {@link DapRequestError} on a DAP failure, {@link DapDisconnectedError}
   * after close, or `TimeoutError`-labelled `Error` past the deadline.
   */
  send(
    command: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new DapDisconnectedError(this.closeReason))
    const seq = ++this.seq
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, timer: undefined, signal: options?.signal, onAbort: undefined }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(seq)
          detachAbort(pending)
          const error = new Error(`DAP ${command} timed out after ${timeoutMs}ms`)
          error.name = 'TimeoutError'
          reject(error)
        }, timeoutMs)
      }
      pending.onAbort = () => {
        if (this.pending.get(seq) !== pending) return
        this.pending.delete(seq)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        reject(new Error(`DAP ${command} aborted`))
      }
      options?.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.pending.set(seq, pending)
      this.transport.write(encodeMessage({ seq, type: 'request', command, arguments: args }))
    })
  }

  /** Subscribe to one DAP event; returns an unsubscribe function. */
  onEvent(event: string, handler: (body: Record<string, unknown> | undefined) => void): () => void {
    let handlers = this.eventHandlers.get(event)
    if (handlers === undefined) {
      handlers = new Set()
      this.eventHandlers.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  /** Subscribe to connection closure; returns an unsubscribe function. */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  /** Tear down: reject pending work and close the transport. Idempotent. */
  dispose(): void {
    this.shutdown('disposed')
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      if (error instanceof FramingError) {
        this.shutdown(error.message)
        return
      }
      throw error
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    const classified = classifyDapMessage(message)
    if (classified === undefined) return
    if (classified.type === 'response') {
      this.settle(classified)
      return
    }
    if (classified.type === 'event') {
      const handlers = this.eventHandlers.get(classified.event)
      if (handlers !== undefined) for (const handler of [...handlers]) handler(classified.body)
    }
  }

  private settle(response: DapResponse): void {
    const seq = response.request_seq
    if (seq === undefined) return
    const pending = this.pending.get(seq)
    if (pending === undefined) return
    this.pending.delete(seq)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    detachAbort(pending)
    if (response.success === true) pending.resolve(response.body ?? {})
    else pending.reject(new DapRequestError(response.command ?? `#${seq}`, response.message))
  }

  private shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      detachAbort(pending)
      pending.reject(new DapDisconnectedError(reason))
    }
    this.pending.clear()
    for (const handler of [...this.closeHandlers]) handler()
    this.transport.close()
  }
}

/** A spawned adapter process plus its transport and teardown handle. */
export interface SpawnedAdapter {
  connection: DapConnection
  /** Kill the adapter process tree; resolves once the process is gone. */
  kill(): Promise<void>
  /** Recent adapter stderr tail for launch-failure diagnostics. */
  stderrTail(): string
}

const STDERR_TAIL_BYTES = 8 * 1024

/**
 * Spawn one DAP adapter over stdio and wrap it in a {@link DapConnection}.
 * The adapter's stderr is collected (bounded) for error reporting only.
 */
export function spawnDapAdapter(
  argv: readonly string[],
  options: {
    cwd?: string
    env?: Record<string, string>
    requestTimeoutMs?: number
    maxBodyBytes?: number
    signal?: AbortSignal
  } = {},
): SpawnedAdapter {
  const [command, ...args] = argv
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })
  let exitWaiter: Promise<void> | undefined
  const kill = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    if (exitWaiter === undefined) {
      exitWaiter = new Promise<void>(resolve => {
        child.once('exit', () => resolve())
      })
    }
    await exitWaiter
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) void kill()
    else options.signal.addEventListener('abort', () => void kill(), { once: true })
  }
  const transport = childProcessTransport(child)
  const connection = new DapConnection(transport, {
    requestTimeoutMs: options.requestTimeoutMs,
    maxBodyBytes: options.maxBodyBytes,
  })
  return { connection, kill, stderrTail: () => stderrTail }
}

/** Adapt one stdio child process into a {@link DapTransport}. */
export function childProcessTransport(child: ChildProcess): DapTransport {
  const dataListeners = new Set<(chunk: Buffer) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of [...dataListeners]) listener(chunk)
  })
  child.stderr?.on('data', () => {})
  child.on('error', error => {
    for (const listener of [...errorListeners]) listener(error)
  })
  child.on('close', () => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener()
  })
  return {
    write(chunk: Buffer): void {
      if (closed || child.stdin === null) return
      child.stdin.write(chunk)
    },
    close() {
      if (closed) return
      closed = true
      child.stdin?.end()
      child.stdout?.destroy()
    },
    onData(listener) {
      dataListeners.add(listener)
      return () => {
        dataListeners.delete(listener)
      }
    },
    onError(listener) {
      errorListeners.add(listener)
      return () => {
        errorListeners.delete(listener)
      }
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => {
        closeListeners.delete(listener)
      }
    },
  }
}
