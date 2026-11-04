import { closeSync, constants, openSync, readSync } from "node:fs";
import type { CallRecord } from "../proxy/records";
import { isRequestRef, type RequestRef } from "../proxy/requests";
import { eachJsonl } from "./journal";

export type HeldRequest = Omit<RequestRef, "parts"> & { parts?: string[] };

export type HeldCall = Omit<CallRecord, "request"> & { request?: HeldRequest };

export function heldCall(record: CallRecord): HeldCall {
    if (record.request === undefined) return record;
    const { sha256, bytes } = record.request;
    return { ...record, request: { sha256, bytes } };
}

/** Part ids a `CallLog` keeps between reads, summed over the cached records. */
const PART_IDS_CACHED = 1 << 21;

/**
 * `CallLog` keeps each record's fields with its request's digest and length, and the byte range
 * of its line, so `request` loads the part ids on demand and refuses a line that no longer
 * matches the record kept. The cache evicts least-recently-used lists until it holds at most
 * `PART_IDS_CACHED` part ids or only the requested list remains. `CallLog` opens the log with
 * `O_NOFOLLOW` and holds the descriptor until `close`; the saved byte ranges require the log's
 * existing contents to stay unchanged.
 */
export class CallLog {
    readonly calls: HeldCall[] = [];
    private readonly ranges: Array<{ offset: number; length: number }> = [];
    private readonly cache = new Map<number, string[]>();
    private cachedIds = 0;
    private fd: number | null = null;

    /**
     * `check` sees each parsed record whole, with its 0-based position, before it is kept.
     * `cacheIds` sets the cached part-id budget; the requested call stays cached even when its
     * part ids exceed that budget.
     */
    constructor(
        private readonly path: string,
        check: (record: CallRecord, position: number) => void = () => {},
        private readonly cacheIds = PART_IDS_CACHED,
    ) {
        eachJsonl<CallRecord>(path, (record, position, offset, length) => {
            check(record, position);
            this.calls.push(heldCall(record));
            this.ranges.push({ offset, length });
        });
        if (this.calls.length > 0) {
            this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
    }

    request(position: number): RequestRef | null {
        const held = this.calls[position];
        const range = this.ranges[position];
        if (!held || !range) throw new Error(`${this.path}: no call at position ${position}`);
        if (this.fd === null) throw new Error(`${this.path}: call log read after close`);
        if (held.request === undefined) return null;
        const { sha256, bytes } = held.request;
        let parts = this.cache.get(position);
        if (parts) {
            this.cache.delete(position);
        } else {
            const buf = Buffer.alloc(range.length);
            for (let got = 0; got < range.length; ) {
                const n = readSync(this.fd, buf, got, range.length - got, range.offset + got);
                if (n === 0)
                    throw new Error(`${this.path}: call ${position} ends past the log's end`);
                got += n;
            }
            const changed = new Error(`${this.path}: call ${position} changed since it was read`);
            let record: Partial<CallRecord> | null;
            try {
                record = JSON.parse(buf.toString("utf8")) as Partial<CallRecord> | null;
            } catch {
                throw changed;
            }
            const ref = record?.request;
            if (
                record?.seq !== held.seq ||
                !isRequestRef(ref) ||
                ref.sha256 !== sha256 ||
                ref.bytes !== bytes
            ) {
                throw changed;
            }
            parts = ref.parts;
            this.cachedIds += parts.length;
        }
        this.cache.set(position, parts);
        for (const [old, ids] of this.cache) {
            if (this.cachedIds <= this.cacheIds || old === position) break;
            this.cache.delete(old);
            this.cachedIds -= ids.length;
        }
        return { sha256, bytes, parts };
    }

    close(): void {
        if (this.fd === null) return;
        closeSync(this.fd);
        this.fd = null;
        this.cache.clear();
        this.cachedIds = 0;
    }
}
