import { spawn, type ChildProcess } from 'node:child_process'
import { connect as netConnect, type Socket as NetSocket } from 'node:net'
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
  private lastResponseAt = Date.now()
  private stalled = false

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

  /** Whether the adapter stopped responding entirely (likely hung). */
  get isStalled(): boolean {
    return this.stalled
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
    if (options?.signal?.aborted) return Promise.reject(new Error(`DAP ${command} aborted`))
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
          // A timed-out request with no response traffic at all (and a live
          // connection) suggests a hung adapter: flag it so the caller can
          // advise disconnecting instead of retrying.
          if (!this.closed && Date.now() - this.lastResponseAt >= timeoutMs) this.stalled = true
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
      if (handlers !== undefined) for (const handler of Array.from(handlers)) handler(classified.body)
    }
  }

  private settle(response: DapResponse): void {
    this.lastResponseAt = Date.now()
    const seq = response.request_seq
    if (seq === undefined) return
    const pending = this.pending.get(seq)
    if (pending === undefined) return
    this.pending.delete(seq)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    detachAbort(pending)
    if (response.success === true) pending.resolve(response.body ?? {})
    else {
      const bodyError = response.body?.error as Record<string, unknown> | undefined
      const msg =
        response.message ??
        (typeof bodyError?.format === 'string' ? bodyError.format : undefined) ??
        (typeof bodyError?.message === 'string' ? bodyError.message : undefined) ??
        (typeof response.body?.message === 'string' ? response.body.message : undefined)
      pending.reject(new DapRequestError(response.command ?? `#${seq}`, msg))
    }
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
    for (const handler of Array.from(this.closeHandlers)) handler()
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

/** Grace before escalating a POSIX SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 2000

/**
 * Kill the process tree rooted at `child` on Windows. `taskkill /T` walks the
 * parent-child relationships, so the adapter's own debuggee children die too.
 */
function taskkillTree(child: ChildProcess): Promise<void> {
  return new Promise<void>(resolve => {
    const pid = child.pid
    if (pid === undefined) {
      resolve()
      return
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('exit', () => resolve())
    killer.on('error', () => {
      // taskkill unavailable (unusual): fall back to a plain kill of the adapter.
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve()
    })
  })
}

/** Spawn one child, collect its stderr tail, and return a kill handle. */
function spawnChildProcess(
  argv: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
): { child: ChildProcess; stderrTail: () => string; kill: () => Promise<void> } {
  const [command, ...args] = argv
  // POSIX: run the adapter in its own process group so killing the group also
  // kills the debuggee tree it spawned. Windows has no process groups; tree
  // kill goes through `taskkill /T` instead.
  const detached = process.platform !== 'win32'
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached,
  })
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })
  let exitWaiter: Promise<void> | undefined
  const kill = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (exitWaiter === undefined) {
      exitWaiter = new Promise<void>(resolve => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          // Grace passed: escalate to SIGKILL (POSIX group / direct).
          if (detached) {
            try {
              process.kill(-child.pid!, 'SIGKILL')
            } catch {
              // already gone
            }
          } else {
            try {
              child.kill('SIGKILL')
            } catch {
              // already gone
            }
          }
          // Give the kill a moment to land, then settle regardless so the
          // caller never hangs on a zombie that ignores signals.
          setTimeout(done, 500)
        }, KILL_GRACE_MS)
        child.once('exit', done)
        if (child.exitCode !== null || child.signalCode !== null) {
          done()
        }
      })
    }
    if (detached) {
      // Terminate the whole process group; individual fallback if the group
      // signal cannot be delivered (e.g. the child already reaped).
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }
    } else if (process.platform === 'win32') {
      await taskkillTree(child)
    } else {
      child.kill()
    }
    await exitWaiter
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) void kill()
    else options.signal.addEventListener('abort', () => void kill(), { once: true })
  }
  return { child, stderrTail: () => stderrTail, kill }
}

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
  const { child, stderrTail, kill } = spawnChildProcess(argv, options)
  const transport = childProcessTransport(child)
  const connection = new DapConnection(transport, {
    requestTimeoutMs: options.requestTimeoutMs,
    maxBodyBytes: options.maxBodyBytes,
  })
  return { connection, kill, stderrTail }
}

import type { AdapterSpec } from './adapters.js'

/**
 * Unified spawn: dispatches to {@link spawnDapAdapter} (stdio) or
 * {@link spawnTcpAdapter} (tcp) based on `spec.transport`.
 * Returns a promise for TCP transports (needed for async socket connection)
 * and a plain value for stdio transports.
 */
export function spawnAdapter(
  spec: Pick<AdapterSpec, 'command' | 'args' | 'env' | 'cwd' | 'transport' | 'host' | 'port' | 'portPattern' | 'announceStream'>,
  options: {
    requestTimeoutMs?: number
    maxBodyBytes?: number
    signal?: AbortSignal
  } = {},
): SpawnedAdapter | Promise<SpawnedAdapter> {
  if (spec.transport === 'tcp') {
    if (spec.port !== undefined && spec.port > 0) {
      // Explicit port: spawn the configured adapter command and connect to the
      // port it listens on. The command/args are honored here — the adapter
      // child is the one that binds the port.
      return spawnTcpAdapterWithPort([spec.command, ...spec.args], {
        host: spec.host,
        port: spec.port,
        cwd: spec.cwd,
        env: spec.env,
        requestTimeoutMs: options.requestTimeoutMs,
        maxBodyBytes: options.maxBodyBytes,
        signal: options.signal,
      })
    }
    // No explicit port: spawn the adapter child and discover its listening
    // port from stdout (e.g. codelldb with '--port 0' prints "Listening on port <N>").
    return spawnTcpAdapterWithDiscovery([spec.command, ...spec.args], {
      host: spec.host,
      cwd: spec.cwd,
      env: spec.env,
      portPattern: spec.portPattern,
      announceStream: spec.announceStream,
      requestTimeoutMs: options.requestTimeoutMs,
      maxBodyBytes: options.maxBodyBytes,
      signal: options.signal,
    })
  }
  return spawnDapAdapter([spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    requestTimeoutMs: options.requestTimeoutMs,
    maxBodyBytes: options.maxBodyBytes,
    signal: options.signal,
  })
}

/** Adapt one stdio child process into a {@link DapTransport}. */
export function childProcessTransport(child: ChildProcess): DapTransport {
  const dataListeners = new Set<(chunk: Buffer) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of Array.from(dataListeners)) listener(chunk)
  })
  child.stderr?.on('data', () => {})
  child.on('error', error => {
    for (const listener of Array.from(errorListeners)) listener(error)
  })
  child.on('close', () => {
    if (closed) return
    closed = true
    for (const listener of Array.from(closeListeners)) listener()
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

/** Options for {@link tcpTransport}. */
export interface TcpTransportOptions {
  /** Host to connect to. */
  host: string
  /** Port to connect to. */
  port: number
  /** Called when the underlying socket is established. */
  onConnect?: (socket: NetSocket) => void
  /** Called just before the socket is destroyed. */
  onDisconnect?: (reason: string) => void
}

/**
 * Adapt one TCP socket into a {@link DapTransport}. The socket is already
 * connected when this function returns; the transport closes the socket on
 * {@link DapTransport.close} and notifies all listeners on unexpected EOF.
 */
export function tcpTransport(socket: NetSocket, options?: TcpTransportOptions): DapTransport {
  const dataListeners = new Set<(chunk: Buffer) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false
  socket.on('data', (chunk: Buffer) => {
    for (const listener of Array.from(dataListeners)) listener(chunk)
  })
  socket.on('error', error => {
    for (const listener of Array.from(errorListeners)) listener(error)
  })
  socket.on('close', hadError => {
    if (closed) return
    closed = true
    options?.onDisconnect?.(hadError ? 'error' : 'close')
    for (const listener of Array.from(closeListeners)) listener()
  })
  // Notify as soon as the TCP handshake completes.
  socket.on('connect', () => options?.onConnect?.(socket))
  return {
    write(chunk: Buffer): void {
      if (closed) return
      socket.write(chunk)
    },
    close() {
      if (closed) return
      closed = true
      socket.destroy()
    },
    onData(listener) {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onError(listener) {
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
  }
}

/**
 * Options for {@link spawnTcpAdapter}.
 * All fields mirror {@link spawnDapAdapter} except `host`/`port` in place of `argv`.
 */
export interface TcpSpawnOptions {
  host?: string
  port: number
  /** Called when the TCP handshake completes. */
  onConnect?: (socket: NetSocket) => void
  cwd?: string
  env?: Record<string, string>
  requestTimeoutMs?: number
  maxBodyBytes?: number
  signal?: AbortSignal
}

/**
 * Connect to an already-listening DAP adapter over TCP (e.g. a server started
 * outside this plugin) and wrap it in a {@link DapConnection}. No child is
 * spawned here; to launch a configured adapter command and connect to its
 * port, use {@link spawnAdapter} (tcp transport) or
 * {@link spawnTcpAdapterWithPort}.
 */
export function spawnTcpAdapter(options: TcpSpawnOptions): Promise<SpawnedAdapter> {
  return new Promise<SpawnedAdapter>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`TCP connection to ${host}:${port} timed out`))
      reject(new Error(`TCP connection to ${host}:${port} timed out`))
    }, options.requestTimeoutMs ?? 30_000)
    const { host = '127.0.0.1', port } = options
    const socket = netConnect(port, host, () => {
      clearTimeout(timeout)
      const transport = tcpTransport(socket, {
        host,
        port,
        onConnect: options.onConnect,
      })
      const connection = new DapConnection(transport, {
        requestTimeoutMs: options.requestTimeoutMs,
        maxBodyBytes: options.maxBodyBytes,
      })
      resolve({ connection, kill: () => new Promise<void>(res => { socket.destroy(); res() }), stderrTail: () => '' })
    })
    socket.on('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** Options for {@link spawnTcpAdapterWithPort}. */
export interface TcpPortOptions {
  host?: string
  port: number
  cwd?: string
  env?: Record<string, string>
  /** How long to wait for the child to accept connections on `port`. */
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  maxBodyBytes?: number
  signal?: AbortSignal
}

/**
 * Spawn one TCP DAP adapter child and connect to its fixed port. Unlike
 * {@link spawnTcpAdapter}, the configured command is actually launched: the
 * adapter may take a moment to bind, so connection attempts retry until the
 * child is listening, exits, or the deadline passes. Teardown kills the child
 * and closes the socket.
 */
export function spawnTcpAdapterWithPort(
  argv: readonly string[],
  options: TcpPortOptions,
): Promise<SpawnedAdapter> {
  return new Promise<SpawnedAdapter>((resolve, reject) => {
    const { child, stderrTail, kill } = spawnChildProcess(argv, options)
    const host = options.host ?? '127.0.0.1'
    const port = options.port
    const connectTimeoutMs = options.connectTimeoutMs ?? options.requestTimeoutMs ?? 30_000
    let settled = false
    let socket: NetSocket | undefined

    const fail = (error: Error, killFirst = false): void => {
      if (settled) return
      settled = true
      clearTimeout(overallTimer)
      if (killFirst) void kill().then(() => reject(error))
      else reject(error)
    }

    const overallTimer = setTimeout(() => {
      const tail = stderrTail().trim()
      const detail = tail.length > 0 ? ` Adapter stderr: ${tail.slice(-800)}` : ''
      fail(new Error(`Timed out waiting for the adapter to accept connections on ${host}:${port}.${detail}`), true)
    }, connectTimeoutMs)

    // Spawn failure (e.g. ENOENT): nothing to kill, reject immediately.
    child.on('error', error => fail(error))
    // The child died before accepting connections: surface stderr.
    child.on('exit', code => {
      const tail = stderrTail().trim()
      const detail = tail.length > 0 ? ` Adapter stderr: ${tail.slice(-800)}` : ''
      fail(new Error(`Debug adapter exited (code ${code ?? 'unknown'}) before accepting connections on ${host}:${port}.${detail}`))
    })

    function tryConnect(): void {
      if (settled) return
      socket = netConnect(port, host)
      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(overallTimer)
        const transport = tcpTransport(socket!, { host, port })
        const connection = new DapConnection(transport, {
          requestTimeoutMs: options.requestTimeoutMs,
          maxBodyBytes: options.maxBodyBytes,
        })
        resolve({
          connection,
          kill: () =>
            new Promise<void>(res => {
              socket?.destroy()
              void kill().then(res)
            }),
          stderrTail,
        })
      })
      socket.once('error', () => {
        // Not listening yet: destroy and retry shortly (the overall timer is
        // the backstop, and the child-exit handler settles on early death).
        socket?.destroy()
        if (!settled) setTimeout(tryConnect, 50)
      })
    }
    tryConnect()
  })
}

/** Options for {@link spawnTcpAdapterWithDiscovery}. */
export interface TcpDiscoveryOptions {
  host?: string
  cwd?: string
  env?: Record<string, string>
  /** How long to wait for the adapter to announce its port on stdout/stderr. */
  discoveryTimeoutMs?: number
  /** How long to keep retrying the TCP connect after the port is announced (default: `requestTimeoutMs` ?? 30s). */
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  maxBodyBytes?: number
  signal?: AbortSignal
  /** Regex (string or RegExp) matching the adapter's port announcement, with one capture group for the port. Default: /Listening on port (\d+)/. */
  portPattern?: string | RegExp
  /** Which child stream(s) carry the port announcement (default `'both'`; `'stdout'` pins the old behavior). */
  announceStream?: 'stdout' | 'stderr' | 'both'
}

const DEFAULT_PORT_ANNOUNCE_PATTERN = /Listening on port (\d+)/

/**
 * Spawn a TCP DAP adapter child process and discover its listening port from
 * stdout, then connect (e.g. codelldb started with `--port 0`, which prints
 * "Listening on port <N>"). Connection attempts retry until the announced
 * port accepts, the child dies, or the deadline passes — an announcement can
 * precede the actual bind. The child's stderr is collected for failure
 * diagnostics; teardown kills the child and closes the socket.
 */
export function spawnTcpAdapterWithDiscovery(
  argv: readonly string[],
  options: TcpDiscoveryOptions = {},
): Promise<SpawnedAdapter> {
  return new Promise<SpawnedAdapter>((resolve, reject) => {
    const { child, stderrTail, kill } = spawnChildProcess(argv, options)
    const host = options.host ?? '127.0.0.1'
    const portPattern =
      options.portPattern === undefined
        ? DEFAULT_PORT_ANNOUNCE_PATTERN
        : options.portPattern instanceof RegExp
          ? options.portPattern
          : new RegExp(options.portPattern)
    let settled = false
    const stderrDetail = (): string => {
      const tail = stderrTail().trim()
      return tail.length > 0 ? ` Adapter stderr: ${tail.slice(-800)}` : ''
    }
    const discoveryTimer = setTimeout(() => {
      void kill().then(() =>
        reject(new Error(`Timed out waiting for the adapter to announce its port on stdout.${stderrDetail()}`)),
      )
    }, options.discoveryTimeoutMs ?? 30_000)
    let connectBackstop: ReturnType<typeof setTimeout> | undefined
    const clearTimers = (): void => {
      clearTimeout(discoveryTimer)
      if (connectBackstop !== undefined) clearTimeout(connectBackstop)
      connectBackstop = undefined
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimers()
    }
    /** Reject exactly once; killing the child is part of settlement. */
    const fail = (error: Error, killFirst = true): void => {
      if (settled) return
      settled = true
      clearTimers()
      if (killFirst) void kill().then(() => reject(error))
      else reject(error)
    }
    // Spawn failure (e.g. ENOENT): nothing to kill, reject immediately.
    child.on('error', error => fail(error, false))
    // Death at any phase — before or after the announcement — settles early,
    // so an adapter that crashes right after printing its port surfaces its
    // stderr instead of stalling until a timer.
    child.on('exit', code => {
      fail(
        new Error(
          `Debug adapter exited (code ${code ?? 'unknown'}) before accepting connections.${stderrDetail()}`,
        ),
      )
    })
    let stdoutBuffer = ''
    /**
     * Connect to the announced port, retrying briefly like the fixed-port
     * path: some adapters print the announcement just before their listener
     * is bound, so the first attempt can hit ECONNREFUSED. Child death
     * settles via the exit handler; the deadline is the backstop.
     */
    function tryConnect(port: number, deadline: number): void {
      if (settled) return
      const socket = netConnect(port, host)
      socket.once('connect', () => {
        if (settled) {
          socket.destroy()
          return
        }
        finish()
        const transport = tcpTransport(socket, { host, port })
        const connection = new DapConnection(transport, {
          requestTimeoutMs: options.requestTimeoutMs,
          maxBodyBytes: options.maxBodyBytes,
        })
        resolve({
          connection,
          kill: () =>
            new Promise<void>(res => {
              socket.destroy()
              void kill().then(res)
            }),
          stderrTail,
        })
      })
      socket.once('error', () => {
        socket.destroy()
        if (settled) return
        if (Date.now() >= deadline) {
          fail(new Error(`Timed out connecting to ${host}:${port} after the adapter announced its port.${stderrDetail()}`))
        } else {
          setTimeout(() => tryConnect(port, deadline), 50)
        }
      })
    }
    let announced = false
    const onAnnounceChunk = (chunk: Buffer): void => {
      stdoutBuffer = (stdoutBuffer + chunk.toString('utf8')).slice(-64 * 1024)
      const match = portPattern.exec(stdoutBuffer)
      // The buffer keeps re-matching on later chunks: announce exactly once.
      if (match === null || settled || announced) return
      announced = true
      // The announcement ends the discovery phase: only the connect window
      // may bound the retries from here on, or a late discovery timer could
      // kill the adapter while the bind is still completing.
      clearTimeout(discoveryTimer)
      const port = Number(match[1])
      // Announcement received: swap the discovery window for the connect
      // window, so a slow bind is bounded by its own deadline.
      const windowMs = options.connectTimeoutMs ?? options.requestTimeoutMs ?? 30_000
      connectBackstop = setTimeout(() => {
        fail(new Error(`Timed out connecting to ${host}:${port} after the adapter announced its port.${stderrDetail()}`))
      }, windowMs)
      tryConnect(port, Date.now() + windowMs)
    }
    child.stdout?.on('data', onAnnounceChunk)
    // Some adapters announce the port on stderr (e.g. `node --inspect`
    // prints "Debugger listening on ws://..." there). Scan it too unless
    // the caller pinned the stream.
    if (options.announceStream !== 'stdout') child.stderr?.on('data', onAnnounceChunk)
  })
}
