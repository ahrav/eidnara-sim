import { appendFileSync } from "node:fs";

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

    constructor(private readonly path: string | null) {}

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        const wall_ms = Math.max(this.lastWall, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms };
        const problems = recordProblems(record);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
        this.seq++;
        this.lastWall = wall_ms;
        this.records.push(record);
        return record;
    }
}
