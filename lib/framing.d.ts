/**
 * DAP/LSP base-protocol framing: `Content-Length: N\r\n\r\n` headers over a
 * byte stream. Pure Buffer code with no dependencies so unit tests cover it
 * directly.
 */
/** Default cap on one decoded message body. */
export declare const DEFAULT_MAX_BODY_BYTES: number;
/** Error thrown for malformed or oversized frames; carries the partial header text for diagnostics. */
export declare class FramingError extends Error {
    readonly detail?: string | undefined;
    constructor(message: string, detail?: string | undefined);
}
/** Encode one JSON message into a framed wire buffer. */
export declare function encodeMessage(message: unknown): Buffer<ArrayBufferLike>;
/**
 * Streaming frame decoder. Feed arbitrary chunk boundaries; each push returns
 * the complete messages that became available. Throws {@link FramingError} on
 * malformed headers or bodies exceeding `maxBodyBytes`.
 */
export declare class MessageDecoder {
    private buffer;
    private readonly maxBodyBytes;
    constructor(options?: {
        maxBodyBytes?: number;
    });
    /** Append one chunk and return every message it completed. */
    push(chunk: Buffer): unknown[];
    private tryTake;
}
