import {
    closeSync,
    constants,
    fstatSync,
    ftruncateSync,
    openSync,
    readSync,
    realpathSync,
    writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { keepCompleteLines } from "../run/journal";

export const COMPONENTS = [
    "agent",
    "native_compaction",
    "title",
    "history_summarizer",
    "memory_capture",
    "memory_classifier",
    "context_researcher",
    "user-sim",
    "judge",
    "other",
    "rejected",
] as const;
export type Component = (typeof COMPONENTS)[number];

export interface CallRecord {
    seq: number;
    arm: string;
    session: string | null;
    turn: string | null;
    component: Component;
    componentSource: "asserted" | "inferred";
    model: string;
    status: number;
    finish_reason: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    started_wall_ms: number;
    wall_ms: number;
    scenario_ms: number;
    first_byte_ms: number | null;
    proxy_retries: number;
    fault_ref: string | null;
    error: string | null;
    /** Request fields the proxy removed before forwarding, keyed by field path. */
    stripped?: Record<string, unknown>;
    /** The response text the proxy relayed for agent, user-sim, and judge calls, first 262,144 characters. */
    response_text?: string;
    /** Set when the relayed text ran past that cap, so `response_text` is a prefix. */
    response_text_truncated?: true;
    /** The request's arrival ordinal within its proxy process, so restores can order same-ms calls. */
    arrival?: number;
}

const NUMBERS = [
    "seq",
    "status",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "started_wall_ms",
    "wall_ms",
    "scenario_ms",
    "proxy_retries",
] as const;
const NULLABLE = ["session", "turn", "finish_reason", "fault_ref", "error"] as const;

export function recordProblems(input: Partial<CallRecord> | Record<string, unknown>): string[] {
    const value: Record<string, unknown> = { ...input };
    const problems: string[] = [];
    for (const k of NUMBERS) if (!Number.isFinite(value[k])) problems.push(`${k} missing`);
    for (const k of NULLABLE) {
        if (!(k in value) || (value[k] !== null && typeof value[k] !== "string")) {
            problems.push(`${k} missing`);
        }
    }
    if (!COMPONENTS.includes(value.component as Component)) problems.push("component missing");
    if (value.componentSource !== "asserted" && value.componentSource !== "inferred") {
        problems.push("componentSource missing");
    }
    if (typeof value.arm !== "string" || typeof value.model !== "string") {
        problems.push("arm or model missing");
    }
    if (value.first_byte_ms !== null && !Number.isFinite(value.first_byte_ms)) {
        problems.push("first_byte_ms missing");
    }
    const arrival = value.arrival;
    if (arrival !== undefined && (!Number.isInteger(arrival) || (arrival as number) < 0)) {
        problems.push("arrival invalid");
    }
    return problems;
}

/** The last newline-terminated line of a file whose complete prefix ends at `end`, read backwards in chunks. */
function lastLine(path: string, end: number): string | null {
    const fd = openSync(path, "r");
    try {
        const chunk = Buffer.alloc(Math.min(1 << 20, end));
        let stop = end - 1;
        let tail = Buffer.alloc(0);
        while (stop > 0) {
            const start = Math.max(0, stop - chunk.length);
            const read = readSync(fd, chunk, 0, stop - start, start);
            const piece = chunk.subarray(0, read);
            const newline = piece.lastIndexOf(0x0a);
            if (newline !== -1) {
                return Buffer.concat([piece.subarray(newline + 1), tail]).toString("utf8");
            }
            tail = Buffer.concat([piece, tail]);
            stop = start;
        }
        return tail.length > 0 ? tail.toString("utf8") : null;
    } finally {
        closeSync(fd);
    }
}

/**
 * Opens the journal without following a symlink in any path component, so a linked file or a
 * linked parent is refused. A fresh journal is created exclusively, so an existing path is
 * refused; a resumed one opens an existing regular file or creates it.
 */
function openJournal(given: string, resume: boolean): number {
    const path = resolve(given);
    const parent = dirname(path);
    let real: string;
    try {
        real = realpathSync(parent);
    } catch (caught) {
        throw new Error(`journal refused: ${path} (${(caught as Error).message})`);
    }
    if (real !== parent) throw new Error(`journal refused: ${parent} resolves through a link`);
    const exclusive = resume ? 0 : constants.O_EXCL;
    const flags = constants.O_WRONLY | constants.O_CREAT | exclusive | constants.O_NOFOLLOW;
    let fd: number;
    try {
        fd = openSync(path, flags, 0o600);
    } catch (caught) {
        throw new Error(`journal refused: ${path} (${(caught as Error).message})`);
    }
    if (!fstatSync(fd).isFile()) throw new Error(`journal refused: ${path} is not a regular file`);
    return fd;
}

/** `wall_ms` is the write-time Unix timestamp in milliseconds, clamped to the preceding record's value and to the record's own `started_wall_ms`. */
export class RecordWriter {
    private seq = 0;
    private lastWall = 0;
    private bytes = 0;
    private uncertain: Error | null = null;
    private fd: number | null;
    private closed = false;
    readonly records: CallRecord[] = [];
    private readonly retain: boolean;

    /**
     * `resume` reopens an existing journal: a line a kill cut mid-append is dropped and the
     * sequence continues after the last complete record. `retain` keeps every record in
     * `records` for callers that read them back in memory; a run-long writer passes false,
     * since its records live on disk and in the call index. The record file exists from
     * construction, so a run with no calls still has a `calls.jsonl`.
     */
    constructor(path: string | null, options: { resume?: boolean; retain?: boolean } = {}) {
        this.retain = options.retain ?? true;
        const resume = options.resume ?? false;
        this.fd = path === null ? null : openJournal(path, resume);
        if (path === null || !resume) return;
        this.bytes = keepCompleteLines(path);
        if (this.bytes === 0) return;
        const last = lastLine(path, this.bytes);
        if (last === null) return;
        const corrupt = (why: string) => {
            this.close();
            return new Error(`${path} last record is corrupt: ${why}`);
        };
        let value: unknown;
        try {
            value = JSON.parse(last);
        } catch {
            throw corrupt("not JSON");
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw corrupt("not an object");
        }
        const problems = recordProblems(value as Record<string, unknown>);
        if (problems.length > 0) throw corrupt(problems.join(", "));
        const record = value as CallRecord;
        this.seq = record.seq + 1;
        this.lastWall = record.wall_ms;
    }

    /** Releases the journal descriptor; later writes throw. Calling it again has no effect. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.fd !== null) closeSync(this.fd);
        this.fd = null;
    }

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        if (this.closed) throw new Error("journal refused: the writer is closed");
        if (this.uncertain) {
            throw new Error(
                `journal refused: an earlier append left it uncertain (${this.uncertain.message})`,
            );
        }
        const wall_ms = Math.max(this.lastWall, partial.started_wall_ms, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms };
        const problems = recordProblems(record);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        if (this.fd !== null) {
            const offset = this.bytes;
            const length = this.append(this.fd, `${JSON.stringify(record)}\n`);
            this.placed(record, offset, length);
        }
        this.seq++;
        this.lastWall = wall_ms;
        if (this.retain) this.records.push(record);
        return record;
    }

    /** Called after each record is appended, with its byte position in the log. */
    protected placed(_record: CallRecord, _offset: number, _length: number): void {}

    /** On append failure, RecordWriter attempts to truncate the file to its successfully appended byte count; if truncation fails, subsequent write calls throw. */
    private append(fd: number, line: string): number {
        const bytes = Buffer.from(line, "utf8");
        try {
            let written = 0;
            while (written < bytes.length) {
                written += writeSync(
                    fd,
                    bytes,
                    written,
                    bytes.length - written,
                    this.bytes + written,
                );
            }
            this.bytes += bytes.length;
            return bytes.length;
        } catch (caught) {
            try {
                ftruncateSync(fd, this.bytes);
            } catch {
                this.uncertain = caught as Error;
            }
            throw caught;
        }
    }
}
