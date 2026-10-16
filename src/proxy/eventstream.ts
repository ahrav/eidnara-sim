/**
 * The AWS event stream framing Bedrock's `converse-stream` answers in: each message is a
 * 12-byte prelude (total length, headers length, prelude CRC32), typed headers, a JSON
 * payload, and a CRC32 over everything before it. Every header here is a string header.
 */

export function crc32(bytes: Uint8Array): number {
    return Bun.hash.crc32(bytes);
}

/** The header type tag of a UTF-8 string value. */
const STRING_HEADER = 7;

/** A string header value longer than the format's `uint16` length field is cut to 65,535 bytes; a header name longer than its `uint8` field is cut to 255. */
function clamp(text: string, max: number): Buffer {
    const bytes = Buffer.from(text, "utf8");
    return bytes.length <= max ? bytes : bytes.subarray(0, max);
}

/** One event stream message whose headers are all strings. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Buffer {
    const encodedHeaders = Buffer.concat(
        Object.entries(headers).map(([name, value]) => {
            const nameBytes = clamp(name, 255);
            const valueBytes = clamp(value, 65_535);
            const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
            let at = header.writeUInt8(nameBytes.length, 0);
            at += nameBytes.copy(header, at);
            at = header.writeUInt8(STRING_HEADER, at);
            at = header.writeUInt16BE(valueBytes.length, at);
            valueBytes.copy(header, at);
            return header;
        }),
    );
    const total = 12 + encodedHeaders.length + payload.length + 4;
    const message = Buffer.alloc(total);
    message.writeUInt32BE(total, 0);
    message.writeUInt32BE(encodedHeaders.length, 4);
    message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
    encodedHeaders.copy(message, 12);
    Buffer.from(payload).copy(message, 12 + encodedHeaders.length);
    message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);
    return message;
}

/** A JSON value whose binary members are already base64 text. */
type WireJson = string | number | boolean | null | WireJson[] | { [key: string]: WireJson };

function toWire(value: unknown): WireJson {
    if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
    if (Array.isArray(value)) return value.map(toWire);
    if (value !== null && typeof value === "object") {
        const out: { [key: string]: WireJson } = Object.create(null);
        for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
        return out;
    }
    return value as WireJson;
}

/** `toWire` converts `Buffer` and `Uint8Array` values to base64 strings before `JSON.stringify` applies its `toJSON()` protocol. */
export function wireJson(value: unknown): string {
    return JSON.stringify(toWire(value));
}

/** One `converse-stream` event: its `:event-type` and the JSON member it carries. */
export function encodeEvent(eventType: string, member: unknown): Buffer {
    return encodeMessage(
        {
            ":event-type": eventType,
            ":content-type": "application/json",
            ":message-type": "event",
        },
        Buffer.from(wireJson(member), "utf8"),
    );
}

export function encodeException(exceptionType: string, member: unknown): Buffer {
    return encodeMessage(
        {
            ":exception-type": exceptionType,
            ":content-type": "application/json",
            ":message-type": "exception",
        },
        Buffer.from(wireJson(member), "utf8"),
    );
}

export function encodeError(code: string, message: string): Buffer {
    return encodeMessage(
        { ":error-code": code, ":error-message": message, ":message-type": "error" },
        Buffer.alloc(0),
    );
}
