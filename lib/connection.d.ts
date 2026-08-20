import { type ChildProcess } from 'node:child_process';
import { type Socket as NetSocket } from 'node:net';
/** Byte-stream abstraction over the adapter's stdio (or a test double). */
export interface DapTransport {
    /** Queue one framed write; must not throw after close. */
    write(chunk: Buffer): void;
    /** Close both directions. Idempotent. */
    close(): void;
    /** Subscribe to readable bytes; returns an unsubscribe function. */
    onData(listener: (chunk: Buffer) => void): () => void;
    /** Subscribe to transport failures; returns an unsubscribe function. */
    onError(listener: (error: Error) => void): () => void;
    /** Subscribe to closure; returns an unsubscribe function. */
    onClose(listener: () => void): () => void;
}
/** Error carrying the adapter's own message for one failed DAP request. */
export declare class DapRequestError extends Error {
    readonly command: string;
    readonly dapMessage: string | undefined;
    constructor(command: string, dapMessage: string | undefined);
}
/** Error for operations attempted after the connection closed. */
export declare class DapDisconnectedError extends Error {
    readonly cause?: string | undefined;
    constructor(cause?: string | undefined);
}
/** Correlated request/event channel over one {@link DapTransport}. */
export declare class DapConnection {
    private readonly transport;
    private seq;
    private readonly pending;
    private readonly eventHandlers;
    private readonly closeHandlers;
    private readonly decoder;
    private readonly requestTimeoutMs;
    private closed;
    private closeReason;
    constructor(transport: DapTransport, options?: {
        requestTimeoutMs?: number;
        maxBodyBytes?: number;
    });
    /** Whether the adapter connection has closed; further sends reject. */
    get isClosed(): boolean;
    /**
     * Send one request and resolve with the success body. Rejects with
     * {@link DapRequestError} on a DAP failure, {@link DapDisconnectedError}
     * after close, or `TimeoutError`-labelled `Error` past the deadline.
     */
    send(command: string, args?: Record<string, unknown>, options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<Record<string, unknown>>;
    /** Subscribe to one DAP event; returns an unsubscribe function. */
    onEvent(event: string, handler: (body: Record<string, unknown> | undefined) => void): () => void;
    /** Subscribe to connection closure; returns an unsubscribe function. */
    onClose(handler: () => void): () => void;
    /** Tear down: reject pending work and close the transport. Idempotent. */
    dispose(): void;
    private receive;
    private dispatch;
    private settle;
    private shutdown;
}
/** A spawned adapter process plus its transport and teardown handle. */
export interface SpawnedAdapter {
    connection: DapConnection;
    /** Kill the adapter process tree; resolves once the process is gone. */
    kill(): Promise<void>;
    /** Recent adapter stderr tail for launch-failure diagnostics. */
    stderrTail(): string;
}
/**
 * Spawn one DAP adapter over stdio and wrap it in a {@link DapConnection}.
 * The adapter's stderr is collected (bounded) for error reporting only.
 */
export declare function spawnDapAdapter(argv: readonly string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
}): SpawnedAdapter;
import type { AdapterSpec } from './adapters.js';
/**
 * Unified spawn: dispatches to {@link spawnDapAdapter} (stdio) or
 * {@link spawnTcpAdapter} (tcp) based on `spec.transport`.
 * Returns a promise for TCP transports (needed for async socket connection)
 * and a plain value for stdio transports.
 */
export declare function spawnAdapter(spec: Pick<AdapterSpec, 'command' | 'args' | 'env' | 'cwd' | 'transport' | 'host' | 'port'>, options: {
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
}): SpawnedAdapter | Promise<SpawnedAdapter>;
/** Adapt one stdio child process into a {@link DapTransport}. */
export declare function childProcessTransport(child: ChildProcess): DapTransport;
/** Options for {@link tcpTransport}. */
export interface TcpTransportOptions {
    /** Host to connect to. */
    host: string;
    /** Port to connect to. */
    port: number;
    /** Called when the underlying socket is established. */
    onConnect?: (socket: NetSocket) => void;
    /** Called just before the socket is destroyed. */
    onDisconnect?: (reason: string) => void;
}
/**
 * Adapt one TCP socket into a {@link DapTransport}. The socket is already
 * connected when this function returns; the transport closes the socket on
 * {@link DapTransport.close} and notifies all listeners on unexpected EOF.
 */
export declare function tcpTransport(socket: NetSocket, options?: TcpTransportOptions): DapTransport;
/**
 * Options for {@link spawnTcpAdapter}.
 * All fields mirror {@link spawnDapAdapter} except `host`/`port` in place of `argv`.
 */
export interface TcpSpawnOptions {
    host?: string;
    port: number;
    /** Called when the TCP handshake completes. */
    onConnect?: (socket: NetSocket) => void;
    cwd?: string;
    env?: Record<string, string>;
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
}
/**
 * Connect to a DAP adapter over TCP (e.g. js-debug, codelldb in TCP mode) and
 * wrap it in a {@link DapConnection}.  Unlike {@link spawnDapAdapter}, no
 * child process is spawned — the adapter must already be listening on `port`.
 *
 * For adapters that bundle a `launch` command internally (e.g. codelldb
 * started with a listener port) prefer spawning the adapter as a child
 * process and connecting to the port it opens; this function only handles the
 * transport layer.
 */
export declare function spawnTcpAdapter(options: TcpSpawnOptions): Promise<SpawnedAdapter>;
/** Options for {@link spawnTcpAdapterWithDiscovery}. */
export interface TcpDiscoveryOptions {
    host?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** How long to wait for the adapter to announce its port on stdout. */
    discoveryTimeoutMs?: number;
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
}
/**
 * Spawn a TCP DAP adapter child process and discover its listening port from
 * stdout, then connect (e.g. codelldb started with `--port 0`, which prints
 * "Listening on port <N>"). The child's stderr is collected for failure
 * diagnostics; teardown kills the child and closes the socket.
 */
export declare function spawnTcpAdapterWithDiscovery(argv: readonly string[], options?: TcpDiscoveryOptions): Promise<SpawnedAdapter>;
