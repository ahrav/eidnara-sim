import { appendFileSync, closeSync, existsSync, openSync, readSync } from "node:fs";
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

export function recordProblems(value: Record<string, unknown>): string[] {
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
    return problems;
}

/** `wall_ms` is the write-time Unix timestamp in milliseconds, clamped to the preceding record's value. */
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

export class RecordWriter {
    private seq = 0;
    private lastWall = 0;
    readonly records: CallRecord[] = [];

    /** Byte offset in the log where the next record lands; `write` reports each record's placement through `placed`. */
    protected offset = 0;

    /**
     * `retain` keeps every record in `records` for callers that read them back in memory; a
     * run-long writer passes false, since its records live on disk and in the call index. The
     * record file exists from construction, so a run with no calls still has a `calls.jsonl`.
     */
    constructor(
        private readonly path: string | null,
        private readonly retain = true,
    ) {
        if (!path) return;
        this.offset = keepCompleteLines(path);
        if (!existsSync(path)) appendFileSync(path, "");
        if (this.offset === 0) return;
        const last = lastLine(path, this.offset);
        if (last === null) return;
        const record = JSON.parse(last) as CallRecord;
        this.seq = record.seq + 1;
        this.lastWall = record.wall_ms;
    }

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        const wall_ms = Math.max(this.lastWall, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms } as CallRecord;
        const problems = recordProblems(record as unknown as Record<string, unknown>);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        this.seq++;
        this.lastWall = wall_ms;
        if (this.retain) this.records.push(record);
        if (this.path) {
            const line = `${JSON.stringify(record)}\n`;
            appendFileSync(this.path, line);
            const length = Buffer.byteLength(line);
            this.placed(record, this.offset, length);
            this.offset += length;
        }
        return record;
    }

    /** Called after each record is appended, with its byte position in the log. */
    protected placed(_record: CallRecord, _offset: number, _length: number): void {}
}
