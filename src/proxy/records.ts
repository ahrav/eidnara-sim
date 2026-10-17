import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { requireAppendable } from "../run/journal";

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
export class RecordWriter {
    private seq = 0;
    private lastWall = 0;
    readonly records: CallRecord[] = [];

    /** Byte offset in the log where the next record lands; `write` reports each record's placement through `placed`. */
    protected offset = 0;

    /** The record file exists from construction, so a run with no calls still has a `calls.jsonl`. */
    constructor(private readonly path: string | null) {
        if (path) requireAppendable(path);
        if (path && !existsSync(path)) appendFileSync(path, "");
        if (!path || !existsSync(path)) return;
        const text = readFileSync(path, "utf8");
        const complete = text.slice(0, text.lastIndexOf("\n") + 1);
        if (complete.length < text.length) truncateSync(path, Buffer.byteLength(complete));
        this.offset = Buffer.byteLength(complete);
        const lines = complete.split("\n").filter((l) => l !== "");
        for (const line of lines.reverse()) {
            try {
                const last = JSON.parse(line) as CallRecord;
                this.seq = last.seq + 1;
                this.lastWall = last.wall_ms;
                return;
            } catch {}
        }
    }

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        const wall_ms = Math.max(this.lastWall, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms } as CallRecord;
        const problems = recordProblems(record as unknown as Record<string, unknown>);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        this.seq++;
        this.lastWall = wall_ms;
        this.records.push(record);
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
