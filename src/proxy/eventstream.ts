/**
 * The AWS event stream framing Bedrock's `converse-stream` answers in: each message is a
 * 12-byte prelude (total length, headers length, prelude CRC32), typed headers, a JSON
 * payload, and a CRC32 over everything before it. Every header here is a string header.
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 (IEEE 802.3), the checksum the event stream prelude and message trailer carry. */
export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
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

/** One `converse-stream` event: its `:event-type` and the JSON member it carries. */
export function encodeEvent(eventType: string, member: unknown): Buffer {
    return encodeMessage(
        {
            ":event-type": eventType,
            ":content-type": "application/json",
            ":message-type": "event",
        },
        Buffer.from(JSON.stringify(member), "utf8"),
    );
}

export interface DecodedMessage {
    headers: Record<string, string>;
    payload: Buffer;
}

/** Splits a byte stream into messages, checking both checksums of each; refuses a non-string header. */
export function decodeMessages(stream: Uint8Array): DecodedMessage[] {
    const bytes = Buffer.from(stream);
    const messages: DecodedMessage[] = [];
    let offset = 0;
    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) throw new Error("event stream prelude is truncated");
        const total = bytes.readUInt32BE(offset);
        const headersLength = bytes.readUInt32BE(offset + 4);
        if (total < 16 || offset + total > bytes.length || headersLength > total - 16) {
            throw new Error("event stream message length is out of bounds");
        }
        const message = bytes.subarray(offset, offset + total);
        if (message.readUInt32BE(8) !== crc32(message.subarray(0, 8))) {
            throw new Error("event stream prelude checksum mismatch");
        }
        if (message.readUInt32BE(total - 4) !== crc32(message.subarray(0, total - 4))) {
            throw new Error("event stream message checksum mismatch");
        }
        const headers: Record<string, string> = {};
        let at = 12;
        while (at < 12 + headersLength) {
            const nameLength = message.readUInt8(at);
            const name = message.toString("utf8", at + 1, at + 1 + nameLength);
            at += 1 + nameLength;
            if (message.readUInt8(at) !== STRING_HEADER)
                throw new Error(`header ${name} is not a string`);
            const valueLength = message.readUInt16BE(at + 1);
            headers[name] = message.toString("utf8", at + 3, at + 3 + valueLength);
            at += 3 + valueLength;
        }
        messages.push({ headers, payload: message.subarray(12 + headersLength, total - 4) });
        offset += total;
    }
    return messages;
}
