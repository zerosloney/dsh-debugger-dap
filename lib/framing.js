/**
 * DAP/LSP base-protocol framing: `Content-Length: N\r\n\r\n` headers over a
 * byte stream. Pure Buffer code with no dependencies so unit tests cover it
 * directly.
 */
/** Hard cap on the header block, matching the LSP base-protocol scale. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Default cap on one decoded message body. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Error thrown for malformed or oversized frames; carries the partial header text for diagnostics. */
export class FramingError extends Error {
    detail;
    constructor(message, detail) {
        super(message);
        this.detail = detail;
        this.name = 'FramingError';
    }
}
/** Encode one JSON message into a framed wire buffer. */
export function encodeMessage(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
}
/**
 * Streaming frame decoder. Feed arbitrary chunk boundaries; each push returns
 * the complete messages that became available. Throws {@link FramingError} on
 * malformed headers or bodies exceeding `maxBodyBytes`.
 */
export class MessageDecoder {
    buffer = Buffer.alloc(0);
    maxBodyBytes;
    constructor(options) {
        this.maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    }
    /** Append one chunk and return every message it completed. */
    push(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const messages = [];
        for (;;) {
            const message = this.tryTake();
            if (message === undefined)
                break;
            messages.push(message);
        }
        return messages;
    }
    tryTake() {
        const headerEnd = this.buffer.indexOf('\r\n\r\n', 0, 'ascii');
        if (headerEnd < 0) {
            if (this.buffer.length > MAX_HEADER_BYTES) {
                throw new FramingError('DAP frame header exceeds 64 KiB', this.buffer.subarray(0, 256).toString('latin1'));
            }
            return undefined;
        }
        const headerBlock = this.buffer.subarray(0, headerEnd).toString('ascii');
        let contentLength = -1;
        for (const line of headerBlock.split('\r\n')) {
            const sep = line.indexOf(':');
            if (sep < 0)
                continue;
            const name = line.slice(0, sep).trim().toLowerCase();
            if (name !== 'content-length')
                continue;
            const value = Number.parseInt(line.slice(sep + 1).trim(), 10);
            if (!Number.isFinite(value) || value < 0) {
                throw new FramingError('DAP frame has an invalid Content-Length', headerBlock);
            }
            contentLength = value;
        }
        if (contentLength < 0)
            throw new FramingError('DAP frame header is missing Content-Length', headerBlock);
        if (contentLength > this.maxBodyBytes) {
            throw new FramingError(`DAP frame body of ${contentLength} bytes exceeds the ${this.maxBodyBytes} byte cap`);
        }
        const bodyStart = headerEnd + 4;
        if (this.buffer.length < bodyStart + contentLength)
            return undefined;
        const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
        this.buffer = this.buffer.subarray(bodyStart + contentLength);
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch (error) {
            throw new FramingError('DAP frame body is not valid JSON', body.slice(0, 256));
        }
        if (parsed === null || typeof parsed !== 'object') {
            throw new FramingError('DAP frame body is not a JSON object');
        }
        return parsed;
    }
}
//# sourceMappingURL=framing.js.map