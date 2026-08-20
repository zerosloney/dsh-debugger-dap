/**
 * DAP connection: request/response correlation and event dispatch over a
 * transport abstraction, plus the child-process transport used in production.
 */
import { type ChildProcess } from 'node:child_process';
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
/** Adapt one stdio child process into a {@link DapTransport}. */
export declare function childProcessTransport(child: ChildProcess): DapTransport;
