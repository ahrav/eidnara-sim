import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    ftruncateSync,
    openSync,
    readSync,
    realpathSync,
    writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { keepCompleteLines } from "../run/journal";
import type { ConverseBody } from "./classify";

/**
 * A forwarded request body as the call record names it: the SHA-256 of the JSON the proxy
 * handed upstream, its UTF-8 length, and the ids of its parts in body order.
 */
export interface RequestRef {
    sha256: string;
    bytes: number;
    parts: string[];
}

/** One stored piece of a request body: a top-level field, or one element of `messages`. */
export interface RequestPart {
    field: string;
    value: unknown;
}

const ID = /^[0-9a-f]{32}$/;

/**
 * The first 128 bits of the SHA-256 of the part's JSON as serialized, key order included, so a
 * stored part rebuilds the exact bytes of every body that names it.
 */
export function partId(part: RequestPart): string {
    return createHash("sha256").update(JSON.stringify(part)).digest("hex").slice(0, 32);
}

/**
 * A body split into parts: each message on its own, so a conversation that grows by one message
 * per call adds one part per call, and every other top-level field whole.
 */
export function requestParts(body: ConverseBody): RequestPart[] {
    const parts: RequestPart[] = [];
    for (const [field, value] of Object.entries(body)) {
        if (field === "messages" && Array.isArray(value) && value.length > 0) {
            for (const message of value) parts.push({ field, value: message });
        } else {
            parts.push({ field, value });
        }
    }
    return parts;
}

/** Stored parts by id: a whole log read into a map, or a `RequestPartLog` that reads on demand. */
export interface PartLookup {
    get(id: string): RequestPart | undefined;
}

/**
 * The body a reference names, rebuilt from stored parts; null when a part is missing or the
 * rebuilt JSON differs from the reference's digest or length.
 */
export function rebuildRequest(ref: RequestRef, parts: PartLookup): ConverseBody | null {
    const body: Record<string, unknown> = {};
    for (const id of ref.parts) {
        const part = parts.get(id);
        if (!part) return null;
        // A message is an object; an array stands for the whole (empty) `messages` field.
        if (part.field === "messages" && !Array.isArray(part.value)) {
            const messages = (body.messages ??= []) as unknown[];
            messages.push(part.value);
        } else {
            body[part.field] = part.value;
        }
    }
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) !== ref.bytes) return null;
    if (createHash("sha256").update(json).digest("hex") !== ref.sha256) return null;
    return body as ConverseBody;
}

export function isRequestRef(value: unknown): value is RequestRef {
    const v = value as RequestRef;
    return (
        typeof v === "object" &&
        v !== null &&
        typeof v.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(v.sha256) &&
        Number.isSafeInteger(v.bytes) &&
        v.bytes >= 0 &&
        Array.isArray(v.parts) &&
        v.parts.every((p) => typeof p === "string" && ID.test(p))
    );
}

/**
 * The run's request part log, `requests.jsonl`: one `{id, part}` line per distinct part, written
 * before the call record that names it. The file opens without following a link after its
 * parent directory resolves without one; a reopened log drops a line a kill cut and keeps the
 * ids already written, so a resumed run writes each part once.
 */
export class RequestStore {
    private readonly fd: number;
    private readonly ids = new Set<string>();
    /** Bytes of complete lines; a failed append is cut back to this length. */
    private size: number;
    private broken: Error | null = null;

    constructor(path: string) {
        const full = resolve(path);
        if (realpathSync(dirname(full)) !== dirname(full)) {
            throw new Error(`${full}: its directory resolves through a link`);
        }
        if (existsSync(full)) {
            keepCompleteLines(full);
            eachRequestLine(full, (id) => this.ids.add(id));
        }
        this.fd = openSync(
            full,
            constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
        );
        const stat = fstatSync(this.fd);
        if (!stat.isFile()) {
            closeSync(this.fd);
            throw new Error(`${full} is not a regular file`);
        }
        this.size = stat.size;
    }

    /** Writes the parts not yet in the log and returns the body's reference. */
    store(body: ConverseBody): RequestRef {
        const json = JSON.stringify(body);
        const parts = requestParts(body);
        const ids = parts.map(partId);
        const lines: string[] = [];
        parts.forEach((part, i) => {
            const id = ids[i] as string;
            if (this.ids.has(id)) return;
            lines.push(`${JSON.stringify({ id, part })}\n`);
        });
        if (this.broken) throw this.broken;
        if (lines.length > 0) {
            const bytes = Buffer.from(lines.join(""));
            let written = 0;
            try {
                while (written < bytes.length) {
                    written += writeSync(this.fd, bytes, written, bytes.length - written);
                }
            } catch (caught) {
                // A cut line followed by a whole one would not parse on resume.
                try {
                    ftruncateSync(this.fd, this.size);
                } catch (cut) {
                    this.broken = new Error(
                        `request log cut mid-line and not truncated: ${(cut as Error).message}`,
                    );
                }
                throw caught;
            }
            this.size += bytes.length;
            for (const id of ids) this.ids.add(id);
        }
        return {
            sha256: createHash("sha256").update(json).digest("hex"),
            bytes: Buffer.byteLength(json),
            parts: ids,
        };
    }

    close(): void {
        closeSync(this.fd);
    }
}

/** Every complete line of a request part log, in file order; a cut last line is skipped. */
export function readRequestLines(path: string): Array<{ id: string; part: RequestPart }> {
    const out: Array<{ id: string; part: RequestPart }> = [];
    eachRequestLine(path, (id, part) => out.push({ id, part }));
    return out;
}

/**
 * Visits each complete line in turn with its byte offset and length (newline excluded), so a
 * reader that keeps only ids or offsets holds one line at a time.
 */
function eachRequestLine(
    path: string,
    visit: (id: string, part: RequestPart, offset: number, length: number) => void,
): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const size = fstatSync(fd).size;
        const chunk = Buffer.alloc(1 << 20);
        let carry = Buffer.alloc(0);
        let offset = 0;
        let line = 0;
        // The file offset of `buf`'s first byte.
        let start = 0;
        while (offset < size) {
            const read = readSync(fd, chunk, 0, chunk.length, offset);
            offset += read;
            let buf = Buffer.concat([carry, chunk.subarray(0, read)]);
            let at = buf.indexOf(0x0a);
            while (at !== -1) {
                line++;
                const value = JSON.parse(buf.subarray(0, at).toString("utf8")) as {
                    id?: unknown;
                    part?: RequestPart;
                };
                if (typeof value.id !== "string" || !ID.test(value.id) || !value.part) {
                    throw new Error(`${path} line ${line} is not a request part`);
                }
                if (partId(value.part) !== value.id) {
                    throw new Error(`${path} line ${line} does not match its part id`);
                }
                visit(value.id, value.part, start, at);
                start += at + 1;
                buf = buf.subarray(at + 1);
                at = buf.indexOf(0x0a);
            }
            carry = Buffer.from(buf);
        }
    } finally {
        closeSync(fd);
    }
}

/** The parts of a request part log keyed by id. */
export function readRequestParts(path: string): Map<string, RequestPart> {
    return new Map(readRequestLines(path).map((l) => [l.id, l.part]));
}

/** Parsed parts a `RequestPartLog` keeps between reads, by the bytes of their lines. */
const PART_CACHE_BYTES = 64 << 20;

/**
 * A request part log read on demand: one streaming pass checks every line and keeps each id's
 * offset and length, and `get` reads and parses one line, so a run's bodies never sit in memory
 * at once. A small cache keeps the parts read last, since consecutive calls of a session share
 * most of their messages. The file is opened once without following a link and held until
 * `close`; the log is append-only, so the lines indexed at open stay in place.
 */
export class RequestPartLog implements PartLookup {
    private readonly fd: number;
    private readonly index = new Map<string, { offset: number; length: number }>();
    private readonly cache = new Map<string, { part: RequestPart; length: number }>();
    private cached = 0;

    constructor(
        path: string,
        private readonly cacheBytes = PART_CACHE_BYTES,
    ) {
        this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!fstatSync(this.fd).isFile()) throw new Error(`${path} is not a regular file`);
            eachRequestLine(path, (id, _part, offset, length) => {
                this.index.set(id, { offset, length });
            });
        } catch (caught) {
            closeSync(this.fd);
            throw caught;
        }
    }

    get size(): number {
        return this.index.size;
    }

    has(id: string): boolean {
        return this.index.has(id);
    }

    get(id: string): RequestPart | undefined {
        const hit = this.cache.get(id);
        if (hit) {
            this.cache.delete(id);
            this.cache.set(id, hit);
            return hit.part;
        }
        const at = this.index.get(id);
        if (!at) return undefined;
        const buf = Buffer.alloc(at.length);
        for (let got = 0; got < at.length; ) {
            const n = readSync(this.fd, buf, got, at.length - got, at.offset + got);
            if (n === 0) throw new Error(`request part ${id} ends past the log's end`);
            got += n;
        }
        const { part } = JSON.parse(buf.toString("utf8")) as { part: RequestPart };
        this.cache.set(id, { part, length: at.length });
        this.cached += at.length;
        for (const [old, entry] of this.cache) {
            if (this.cached <= this.cacheBytes || old === id) break;
            this.cache.delete(old);
            this.cached -= entry.length;
        }
        return part;
    }

    close(): void {
        closeSync(this.fd);
    }
}
