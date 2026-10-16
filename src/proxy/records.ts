import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";

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
    return problems;
}

/**
 * `readRecords` truncates an unterminated final line to recover from an interrupted write and
 * requires each complete, nonempty line to contain a valid record whose `seq` equals its zero-based
 * position among nonempty lines.
 */
export function readRecords(path: string): CallRecord[] {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    if (complete.length < text.length) truncateSync(path, Buffer.byteLength(complete));
    const lines = complete.split("\n").filter((l) => l !== "");
    return lines.map((line, i) => {
        const corrupt = (why: string) => new Error(`${path} line ${i + 1} is corrupt: ${why}`);
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw corrupt("not JSON");
        }
        if (typeof value !== "object" || value === null) throw corrupt("not an object");
        const problems = recordProblems(value as Record<string, unknown>);
        if (problems.length > 0) throw corrupt(problems.join(", "));
        const record = value as CallRecord;
        if (record.seq !== i) throw corrupt(`seq ${record.seq} at position ${i}`);
        return record;
    });
}

/** `wall_ms` is the write-time Unix timestamp in milliseconds, clamped to the preceding record's value. */
export class RecordWriter {
    private seq = 0;
    private lastWall = 0;
    readonly records: CallRecord[] = [];

    constructor(private readonly path: string | null) {
        const last = path ? readRecords(path).at(-1) : undefined;
        if (last === undefined) return;
        this.seq = last.seq + 1;
        this.lastWall = last.wall_ms;
    }

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        const wall_ms = Math.max(this.lastWall, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms } as CallRecord;
        const problems = recordProblems(record);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        this.seq++;
        this.lastWall = wall_ms;
        this.records.push(record);
        if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
        return record;
    }
}
