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

/** One event stream message whose headers are all strings. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Buffer {
    const encodedHeaders = Buffer.concat(
        Object.entries(headers).map(([name, value]) => {
            const nameBytes = Buffer.from(name, "utf8");
            const valueBytes = Buffer.from(value, "utf8");
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

/** Serializes bytes as the base64 string the Converse wire format carries for blob fields. */
export function wireJson(value: unknown): string {
    return JSON.stringify(value, (_key, v) =>
        v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v,
    );
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
