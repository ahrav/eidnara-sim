import { constants, fstatSync, ftruncateSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

/** Creates the journal exclusively without following a symlink in any path component, so an existing path or a linked parent is refused. */
function openJournal(path: string): number {
    const parent = resolve(dirname(path));
    let real: string;
    try {
        real = realpathSync(parent);
    } catch (caught) {
        throw new Error(`journal refused: ${path} (${(caught as Error).message})`);
    }
    if (real !== parent) throw new Error(`journal refused: ${parent} resolves through a link`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
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
    private readonly fd: number | null;
    readonly records: CallRecord[] = [];

    constructor(path: string | null) {
        this.fd = path === null ? null : openJournal(path);
    }

    write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
        if (this.uncertain) {
            throw new Error(
                `journal refused: an earlier append left it uncertain (${this.uncertain.message})`,
            );
        }
        const wall_ms = Math.max(this.lastWall, partial.started_wall_ms, Date.now());
        const record = { ...partial, seq: this.seq, wall_ms };
        const problems = recordProblems(record);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        if (this.fd !== null) this.append(this.fd, `${JSON.stringify(record)}\n`);
        this.seq++;
        this.lastWall = wall_ms;
        this.records.push(record);
        return record;
    }

    /** On append failure, RecordWriter attempts to truncate the file to its successfully appended byte count; if truncation fails, subsequent write calls throw. */
    private append(fd: number, line: string): void {
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
