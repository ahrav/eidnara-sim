import { crc32 } from "../src/proxy/eventstream";

const STRING_HEADER = 7;

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
