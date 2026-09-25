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
export declare function spawnAdapter(spec: Pick<AdapterSpec, 'command' | 'args' | 'env' | 'cwd' | 'transport' | 'host' | 'port' | 'portPattern' | 'announceStream'>, options?: {
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
 * Connect to an already-listening DAP adapter over TCP (e.g. a server started
 * outside this plugin) and wrap it in a {@link DapConnection}. No child is
 * spawned here; to launch a configured adapter command and connect to its
 * port, use {@link spawnAdapter} (tcp transport) or
 * {@link spawnTcpAdapterWithPort}.
 */
export declare function spawnTcpAdapter(options: TcpSpawnOptions): Promise<SpawnedAdapter>;
/** Options for {@link spawnTcpAdapterWithPort}. */
export interface TcpPortOptions {
    host?: string;
    port: number;
    cwd?: string;
    env?: Record<string, string>;
    /** How long to wait for the child to accept connections on `port`. */
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
}
/**
 * Spawn one TCP DAP adapter child and connect to its fixed port. Unlike
 * {@link spawnTcpAdapter}, the configured command is actually launched: the
 * adapter may take a moment to bind, so connection attempts retry until the
 * child is listening, exits, or the deadline passes. Teardown kills the child
 * and closes the socket.
 */
export declare function spawnTcpAdapterWithPort(argv: readonly string[], options: TcpPortOptions): Promise<SpawnedAdapter>;
/** Options for {@link spawnTcpAdapterWithDiscovery}. */
export interface TcpDiscoveryOptions {
    host?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** How long to wait for the adapter to announce its port on stdout/stderr. */
    discoveryTimeoutMs?: number;
    /** How long to keep retrying the TCP connect after the port is announced (default: `requestTimeoutMs` ?? 30s). */
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
    maxBodyBytes?: number;
    signal?: AbortSignal;
    /** Regex (string or RegExp) matching the adapter's port announcement: the last capture group is the port; with two groups the first is the announced host. Default: /Listening on port (\d+)/. */
    portPattern?: string | RegExp;
    /** Which child stream(s) carry the port announcement (default `'both'`; `'stdout'` pins the old behavior). */
    announceStream?: 'stdout' | 'stderr' | 'both';
}
/**
 * Spawn a TCP DAP adapter child process and discover its listening port from
 * stdout, then connect (e.g. codelldb started with `--port 0`, which prints
 * "Listening on port <N>"). Connection attempts retry until the announced
 * port accepts, the child dies, or the deadline passes — an announcement can
 * precede the actual bind. The child's stderr is collected for failure
 * diagnostics; teardown kills the child and closes the socket.
 */
export declare function spawnTcpAdapterWithDiscovery(argv: readonly string[], options?: TcpDiscoveryOptions): Promise<SpawnedAdapter>;
