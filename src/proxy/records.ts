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
import { isRequestRef, type RequestRef } from "./requests";

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

/** The components the harness itself records: its own callers and the requests the proxy refused. */
export const HARNESS_COMPONENTS: ReadonlySet<string> = new Set(["user-sim", "judge", "rejected"]);

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
    /** Prompt tokens the provider read from its cache; `input_tokens` leaves them and the writes out. */
    cache_read_tokens: number;
    /** Prompt tokens the call wrote to the provider's cache, at either lifetime. */
    cache_write_tokens: number;
    /** Of `cache_write_tokens`, the tokens written with the 1-hour lifetime; absent when none. */
    cache_write_1h_tokens?: number;
    started_wall_ms: number;
    wall_ms: number;
    scenario_ms: number;
    first_byte_ms: number | null;
    proxy_retries: number;
    fault_ref: string | null;
    error: string | null;
    /** Request fields the proxy removed before forwarding, keyed by field path. */
    stripped?: Record<string, unknown>;
    /**
     * The response text the proxy relayed for agent, user-sim, and judge calls, first
     * `RESPONSE_TEXT_LIMIT` characters, empty when the response carried no text; absent on other
     * components, on a call that failed before any assistant text, and on records from before the
     * capture.
     */
    response_text?: string;
    /** Set when the relayed text ran past that cap, so `response_text` is a prefix. */
    response_text_truncated?: true;
    /** The request's arrival ordinal within its proxy process, so restores can order same-ms calls. */
    arrival?: number;
    /** SHA-256 of the whole relayed text, present with `response_text`. */
    response_sha256?: string;
    /** The last 6,000 characters of the relayed text, present when `response_text` cut it. */
    response_tail?: string;
    /** The forwarded body's digest, length, and stored part ids (`requests.jsonl`). */
    request?: RequestRef;
    /**
     * The turn a background call belongs to when it differs from `turn`: the session's preceding
     * turn, for a call received between turns, or after the next turn began and before that
     * turn's first answer.
     */
    origin_turn?: string;
    /** On a run with prompt caching on: the time since the calls whose cached prefix this one can read (`CacheGaps`). */
    cache_gap?: CacheGap;
}

/**
 * The provider's cache lifetime for the cache points a host places by default: Bedrock keeps a
 * prefix for 5 minutes after its last read, and Pi's default retention (`short`) and OpenCode's
 * default breakpoint name no longer one.
 */
const CACHE_TTL_MS = 300_000;

/** Scenario and wall time from one call's answer to a later call's answer. */
export interface Gap {
    scenario_ms: number;
    wall_ms: number;
}

/**
 * How long before a call the provider last served a call that shares its cached prefix. `session`
 * is measured from the previous served call of the same arm, session, and component, whose
 * request the conversation extends; `arm` from the previous served call of the same arm and
 * component in any session, which shares the system prompt and tool definitions. Components
 * share no prefix, since each has a system prompt of its own. Each is null for
 * the first such call. The provider's cache lives `ttl_ms` of wall time after its last read. A
 * run's wall clock skips the idle time between turns that scenario time keeps, so a
 * `scenario_ms` gap above `ttl_ms` with a `wall_ms` gap inside it marks a call whose cache read
 * a user at the scenario's pace would have paid as a cache write.
 */
export interface CacheGap {
    /** The cache lifetime the gaps are read against. */
    ttl_ms: number;
    session: Gap | null;
    arm: Gap | null;
}

type Timed = Pick<
    CallRecord,
    "arm" | "session" | "component" | "scenario_ms" | "started_wall_ms" | "first_byte_ms"
>;
type Served = Timed &
    Pick<CallRecord, "status" | "input_tokens" | "cache_read_tokens" | "cache_write_tokens">;

/**
 * When the provider began to answer a call, on both clocks: its receipt plus the time to its
 * first answer byte, which holds the proxy's upstream retries and their backoff. The provider
 * reads the cache for the attempt it answers, and a prefix it writes can be read once that
 * answer has started. Scenario time runs at wall speed while a call is in flight, so the same
 * delay applies to both. A call with no answer keeps its receipt.
 */
const answeredAt = (call: Timed): Gap => {
    const wait = Math.round(call.first_byte_ms ?? 0);
    return { scenario_ms: call.scenario_ms + wait, wall_ms: call.started_wall_ms + wait };
};

/**
 * The answer times (`answeredAt`) of the last served call per arm, session, and component, fed
 * every call record in write order. A call counts as served when the provider answered it with
 * prompt usage, since only such a call reads or writes the provider's cache; a call the proxy
 * faulted or the provider refused leaves the times as they were.
 */
export class CacheGaps {
    private readonly last = new Map<string, Gap>();

    /** `partial` with its gaps, for a call of a host under test; the harness's own calls stay as they are. */
    stamp<T extends Omit<CallRecord, "seq" | "wall_ms">>(partial: T): T {
        if (HARNESS_COMPONENTS.has(partial.component)) return partial;
        return { ...partial, cache_gap: this.of(partial) };
    }

    /** The gaps of `call`, read before `note` records it. */
    of(call: Timed): CacheGap {
        const at = answeredAt(call);
        const since = (key: string): Gap | null => {
            const prev = this.last.get(key);
            if (!prev) return null;
            // A call answered before the previous one's answer overlapped it; the gap is none.
            return {
                scenario_ms: Math.max(0, at.scenario_ms - prev.scenario_ms),
                wall_ms: Math.max(0, at.wall_ms - prev.wall_ms),
            };
        };
        const [arm, session] = CacheGaps.keys(call);
        return { ttl_ms: CACHE_TTL_MS, session: since(session), arm: since(arm) };
    }

    note(call: Served): void {
        const prompt = call.input_tokens + call.cache_read_tokens + call.cache_write_tokens;
        if (call.status !== 200 || prompt <= 0) return;
        const at = answeredAt(call);
        for (const key of CacheGaps.keys(call)) {
            const prev = this.last.get(key);
            this.last.set(key, {
                scenario_ms: Math.max(prev?.scenario_ms ?? 0, at.scenario_ms),
                wall_ms: Math.max(prev?.wall_ms ?? 0, at.wall_ms),
            });
        }
    }

    private static keys(call: Pick<Timed, "arm" | "session" | "component">): [string, string] {
        const arm = JSON.stringify([call.arm, call.component]);
        return [arm, JSON.stringify([call.arm, call.component, call.session])];
    }
}

/** Characters of relayed response text a record keeps; a text this long may have been cut. */
export const RESPONSE_TEXT_LIMIT = 262_144;

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
    for (const k of ["response_sha256", "response_tail", "origin_turn"] as const) {
        if (value[k] !== undefined && typeof value[k] !== "string") problems.push(`${k} invalid`);
    }
    if (value.request !== undefined && !isRequestRef(value.request))
        problems.push("request invalid");
    const hour = value.cache_write_1h_tokens;
    if (
        hour !== undefined &&
        !(
            Number.isFinite(hour) &&
            (hour as number) > 0 &&
            (hour as number) <= (value.cache_write_tokens as number)
        )
    ) {
        problems.push("cache_write_1h_tokens invalid");
    }
    if (value.cache_gap !== undefined && !isCacheGap(value.cache_gap)) {
        problems.push("cache_gap invalid");
    }
    return problems;
}

function isCacheGap(value: unknown): value is CacheGap {
    const gap = (v: unknown) =>
        v === null ||
        (typeof v === "object" &&
            ["scenario_ms", "wall_ms"].every((k) => {
                const n = (v as Record<string, unknown>)[k];
                return Number.isFinite(n) && (n as number) >= 0;
            }));
    const g = value as Partial<CacheGap> | null;
    return (
        typeof g === "object" &&
        g !== null &&
        Number.isFinite(g.ttl_ms) &&
        (g.ttl_ms as number) > 0 &&
        "session" in g &&
        "arm" in g &&
        gap(g.session) &&
        gap(g.arm)
    );
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
    private readonly cacheGaps: CacheGaps | null;

    /**
     * `resume` reopens an existing journal: a line a kill cut mid-append is dropped and the
     * sequence continues after the last complete record. `retain` keeps every record in
     * `records` for callers that read them back in memory; a run-long writer passes false,
     * since its records live on disk and in the run's per-session call views. With `cacheGaps`,
     * a caching-on run's tracker, each record of a host under test carries its `cache_gap` and
     * is noted once written; a resume first feeds the tracker the records the log holds. The
     * record file exists from construction, so a run with no calls still has a `calls.jsonl`.
     */
    constructor(
        path: string | null,
        options: { resume?: boolean; retain?: boolean; cacheGaps?: CacheGaps } = {},
    ) {
        this.cacheGaps = options.cacheGaps ?? null;
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
        const stamped = this.cacheGaps ? this.cacheGaps.stamp(partial) : partial;
        const record = { ...stamped, seq: this.seq, wall_ms };
        const problems = recordProblems(record);
        if (problems.length > 0) throw new Error(`call record refused: ${problems.join(", ")}`);
        if (this.fd !== null) this.append(this.fd, `${JSON.stringify(record)}\n`);
        this.seq++;
        this.lastWall = wall_ms;
        this.cacheGaps?.note(record);
        if (this.retain) this.records.push(record);
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
