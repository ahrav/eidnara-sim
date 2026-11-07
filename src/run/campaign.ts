import {
    closeSync,
    constants,
    fstatSync,
    ftruncateSync,
    openSync,
    readFileSync,
    readSync,
    statfsSync,
} from "node:fs";
import { join } from "node:path";
import { interruptions } from "./interruptions";
import { type Entry, readJournal } from "./journal";

/** List prices in USD per million tokens, by token class. */
export interface Prices {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
}

/** The prices c7's cost analysis charged every call record (`c7/final/analysis_cost.py`). */
export const C7_PRICES: Prices = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };

export interface CampaignSpec {
    schema: "sim-campaign/v1";
    out: string;
    /** `group` names the runs that launch together; a run without one is its own group. */
    runs: { name: string; args: string[]; group?: string }[];
    args: string[];
    max_resumes: number;
    poll_ms: number;
    stale_ms: number;
    inode_paths: string[];
    run_command: string[];
    finalize_commands: string[][];
    finalize_timeout_ms: number;
    relaunch_backoff_ms: number;
    /**
     * The eidnara-sim commit every resume runs under (`--sim-upgrade`, `docs/run-command.md`),
     * or null; the supervisor's own checkout must be at it.
     */
    sim_upgrade: string | null;
    /** The most runs that may hold a launch slot at once, or null for no limit. */
    max_concurrent: number | null;
    prices: Prices;
    /** The total spend past which the supervisor raises an alert, or null for none. */
    spend_cap_usd: number | null;
}

export const DEFAULT_RUN = ["bun", "scripts/run-tier.ts"];
export const DEFAULT_FINALIZE = [
    ["bun", "scripts/grade-run.ts", "{dir}"],
    ["bun", "scripts/evidence-run.ts", "{dir}"],
    ["bun", "scripts/pairing-check.ts", "{dir}"],
];
export const INODE_ALERT = 0.8;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
/** Names of the supervisor's own files and directories under `out`, besides its `lease.*` files. */
export const RESERVED = new Set(["logs", "evidence", "campaign.log", "campaign-status.json"]);

export function parseCampaign(raw: unknown): CampaignSpec {
    const o = raw as Partial<CampaignSpec> | null;
    const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
    const problems: string[] = [];
    if (o?.schema !== "sim-campaign/v1") problems.push("schema is not sim-campaign/v1");
    if (typeof o?.out !== "string" || !o.out.startsWith("/")) {
        problems.push("out is no absolute path");
    }
    if (!Array.isArray(o?.runs) || o.runs.length === 0) problems.push("runs is empty");
    const names = new Set<string>();
    for (const r of o?.runs ?? []) {
        if (
            typeof r?.name !== "string" ||
            !NAME.test(r.name) ||
            r.name.length > 200 ||
            RESERVED.has(r.name) ||
            r.name.startsWith("lease.") ||
            names.has(r.name)
        ) {
            problems.push(`run name ${JSON.stringify(r?.name)} is not a unique plain name`);
        } else names.add(r.name);
        if (!strings(r?.args)) problems.push(`run ${r?.name} args are not strings`);
        if (r?.group !== undefined && !(typeof r.group === "string" && NAME.test(r.group))) {
            problems.push(`run ${r?.name} group is not a plain name`);
        }
        for (const flag of ["--out", "--sim-upgrade"]) {
            if ((r?.args ?? []).includes(flag))
                problems.push(`run ${r?.name} names its own ${flag}`);
        }
    }
    if (o?.args !== undefined && !strings(o.args)) problems.push("args are not strings");
    for (const flag of ["--out", "--sim-upgrade"]) {
        if ((o?.args ?? []).includes(flag)) problems.push(`shared args name ${flag}`);
    }
    const command = (v: unknown) => strings(v) && (v as string[]).length > 0;
    if (o?.run_command !== undefined && !command(o.run_command)) {
        problems.push("run_command is not a non-empty list of strings");
    }
    if (
        o?.finalize_commands !== undefined &&
        !(Array.isArray(o.finalize_commands) && o.finalize_commands.every(command))
    ) {
        problems.push("finalize_commands is not a list of non-empty string lists");
    }
    if (o?.inode_paths !== undefined && !strings(o.inode_paths)) {
        problems.push("inode_paths are not strings");
    }
    for (const k of [
        "max_resumes",
        "poll_ms",
        "stale_ms",
        "finalize_timeout_ms",
        "relaunch_backoff_ms",
    ] as const) {
        const v = o?.[k];
        if (v !== undefined && !(Number.isSafeInteger(v) && (v as number) >= 0)) {
            problems.push(`${k} is not a non-negative integer`);
        }
    }
    if (o?.finalize_timeout_ms !== undefined && !((o.finalize_timeout_ms as number) > 0)) {
        problems.push("finalize_timeout_ms is not positive");
    }
    const max = o?.max_concurrent;
    if (max != null && !(Number.isSafeInteger(max) && max > 0)) {
        problems.push("max_concurrent is not a positive integer");
    } else if (max != null) {
        const sizes = new Map<string, number>();
        for (const r of o?.runs ?? []) {
            const g = r?.group ?? r?.name;
            sizes.set(g, (sizes.get(g) ?? 0) + 1);
        }
        for (const [g, n] of sizes) {
            if (n > max) problems.push(`group ${g} has ${n} runs, more than max_concurrent ${max}`);
        }
    }
    const prices = o?.prices as Record<string, unknown> | undefined;
    if (
        prices !== undefined &&
        !(
            typeof prices === "object" &&
            prices !== null &&
            Object.keys(prices).sort().join() === "cache_read,cache_write,input,output" &&
            Object.values(prices).every(
                (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
            )
        )
    ) {
        problems.push("prices needs non-negative input, output, cache_read, and cache_write");
    }
    const cap = o?.spend_cap_usd;
    if (cap != null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) {
        problems.push("spend_cap_usd is not a positive number");
    }
    const upgrade = o?.sim_upgrade;
    if (upgrade != null && !(typeof upgrade === "string" && /^[0-9a-f]{40}$/.test(upgrade))) {
        problems.push("sim_upgrade is not a full commit hash");
    }
    if (problems.length > 0) throw new Error(`campaign: ${problems.join("; ")}`);
    const spec = o as CampaignSpec;
    return {
        schema: spec.schema,
        out: spec.out,
        runs: spec.runs,
        args: spec.args ?? [],
        max_resumes: spec.max_resumes ?? 6,
        poll_ms: spec.poll_ms ?? 60_000,
        stale_ms: spec.stale_ms ?? 45 * 60_000,
        inode_paths: spec.inode_paths ?? ["/tmp"],
        run_command: spec.run_command ?? DEFAULT_RUN,
        finalize_commands: spec.finalize_commands ?? DEFAULT_FINALIZE,
        finalize_timeout_ms: spec.finalize_timeout_ms ?? 6 * 3600_000,
        relaunch_backoff_ms: spec.relaunch_backoff_ms ?? 60_000,
        sim_upgrade: spec.sim_upgrade ?? null,
        max_concurrent: spec.max_concurrent ?? null,
        prices: spec.prices ?? C7_PRICES,
        spend_cap_usd: spec.spend_cap_usd ?? null,
    };
}

/** What the supervisor knows of a run when it decides which runs may start. */
export interface Slot {
    name: string;
    group: string;
    /** The run launched before or left a run directory behind. */
    begun: boolean;
    /** The run holds a slot: it began and has neither ended nor been given up. */
    holding: boolean;
}

/**
 * The runs that may launch this poll. A group with a run that began keeps every run; the other
 * groups start whole, in campaign order, while the runs holding a slot plus the group fit in
 * `max_concurrent`, and the first group that does not fit holds back every later one.
 */
export function admitted(max: number | null, slots: readonly Slot[]): Set<string> {
    if (max === null) return new Set(slots.map((s) => s.name));
    const groups = new Map<string, Slot[]>();
    for (const s of slots) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
    const out = new Set<string>();
    let held = slots.filter((s) => s.holding).length;
    let blocked = false;
    for (const members of groups.values()) {
        if (members.some((m) => m.begun)) {
            for (const m of members) out.add(m.name);
            continue;
        }
        if (blocked || held + members.length > max) {
            blocked = true;
            continue;
        }
        held += members.length;
        for (const m of members) out.add(m.name);
    }
    return out;
}

/** A run's spend so far, read from its `calls.jsonl` up to `offset`. */
export interface Spend {
    offset: number;
    ino: number | null;
    usd: number;
    calls: number;
    by_component: Record<string, number>;
}

export const noSpend = (): Spend => ({ offset: 0, ino: null, usd: 0, calls: 0, by_component: {} });

const tokens = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The USD cost of one call record at `prices`. */
export function callUsd(c: Record<string, unknown>, prices: Prices): number {
    return (
        (tokens(c.input_tokens) * prices.input +
            tokens(c.output_tokens) * prices.output +
            tokens(c.cache_read_tokens) * prices.cache_read +
            tokens(c.cache_write_tokens) * prices.cache_write) /
        1e6
    );
}

/**
 * Adds the call records appended to `path` since `prev` to its spend. Only complete lines count,
 * so a record still being written is read on a later poll. A file that shrank or was replaced is
 * read again from its start; an absent file has spent nothing.
 */
export function readSpend(path: string, prev: Spend, prices: Prices): Spend {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return prev;
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) return prev;
        const spend =
            st.ino !== prev.ino || st.size < prev.offset
                ? { ...noSpend(), ino: st.ino }
                : { ...prev, by_component: { ...prev.by_component } };
        const chunk = Buffer.alloc(1 << 20);
        let carry = Buffer.alloc(0);
        let at = spend.offset;
        while (at < st.size) {
            const n = readSync(fd, chunk, 0, Math.min(chunk.length, st.size - at), at);
            if (n <= 0) break;
            at += n;
            let data = Buffer.concat([carry, chunk.subarray(0, n)]);
            let nl = data.indexOf(0x0a);
            while (nl >= 0) {
                const line = data.subarray(0, nl).toString("utf8");
                spend.offset += nl + 1;
                data = data.subarray(nl + 1);
                nl = data.indexOf(0x0a);
                let c: Record<string, unknown>;
                try {
                    c = JSON.parse(line);
                } catch {
                    continue;
                }
                const usd = callUsd(c, prices);
                const component = typeof c.component === "string" ? c.component : "unknown";
                spend.usd += usd;
                spend.calls++;
                spend.by_component[component] = (spend.by_component[component] ?? 0) + usd;
            }
            carry = Buffer.from(data);
        }
        return spend;
    } finally {
        closeSync(fd);
    }
}

export const runDir = (spec: CampaignSpec, name: string) => join(spec.out, name);

/**
 * A run's command line. A resume adds `--sim-upgrade <sim_upgrade>` when the campaign names one;
 * a record's `argv` is the command without it, so naming one keeps every record.
 */
export function launchArgv(
    spec: CampaignSpec,
    run: CampaignSpec["runs"][number],
    resume = false,
): string[] {
    const upgrade = resume && spec.sim_upgrade !== null ? ["--sim-upgrade", spec.sim_upgrade] : [];
    return [
        ...spec.run_command,
        ...spec.args,
        ...run.args,
        "--out",
        runDir(spec, run.name),
        ...upgrade,
    ];
}

export function finalizeArgv(spec: CampaignSpec, name: string): string[][] {
    const fill = (a: string) =>
        a
            .replaceAll("{dir}", runDir(spec, name))
            .replaceAll("{evidence}", join(spec.out, "evidence"));
    return spec.finalize_commands.map((command) => command.map(fill));
}

export interface RunProgress {
    started: boolean;
    ended: boolean;
    events_done: number;
    events_total: number | null;
    failed_turns: number;
    interrupted_turns: number;
    daemon_exits: number;
    journal_resumes: number;
    pending_fatal: string[];
    measured_events: number;
    last_entry_wall_ms: number | null;
    eta_ms: number | null;
}

const RATE_WINDOW_MS = 6 * 3600_000;

export function runProgress(dir: string, now = Date.now()): RunProgress {
    const path = join(dir, "journal.jsonl");
    const entries: Entry[] = readJournal(path);
    let total: number | null = null;
    try {
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        if (Number.isInteger(manifest.events) && Array.isArray(manifest.order)) {
            total = manifest.events * manifest.order.length;
        }
    } catch {
        total = null;
    }
    const events = entries.filter((e) => e.kind === "Event");
    // An interrupted `session_end` also carries `failed(interrupted)`; only a turn has a
    // `BeginTurn`.
    const key = (e: Entry) => `${e.arm}/${e.event}`;
    const turns = new Set(entries.filter((e) => e.kind === "BeginTurn").map(key));
    const failed = new Set(
        entries
            .filter(
                (e) =>
                    (e.kind === "EndTurn" && e.outcome !== "ok") ||
                    (e.kind === "Event" &&
                        e.outcome === "failed(interrupted)" &&
                        turns.has(key(e))),
            )
            .map(key),
    );
    const arms = Object.values(interruptions(entries));
    const recent = events.filter((e) => e.wall_ms >= now - RATE_WINDOW_MS);
    const first = recent[0];
    const rate = first && recent.length > 1 ? (recent.length - 1) / (now - first.wall_ms) : null;
    const left = total === null ? null : Math.max(0, total - events.length);
    return {
        started: entries.some((e) => e.kind === "StartRun"),
        ended: entries.at(-1)?.kind === "EndRun",
        events_done: events.length,
        events_total: total,
        failed_turns: failed.size,
        interrupted_turns: arms.reduce((n, a) => n + a.interrupted_turns, 0),
        daemon_exits: arms.reduce((n, a) => n + a.daemon_exits, 0),
        journal_resumes: entries.filter((e) => e.kind === "ResumeRun").length,
        pending_fatal: arms.flatMap((a) => a.unresolved),
        measured_events: events.filter((e) => e.outcome !== "failed(interrupted)").length,
        last_entry_wall_ms: entries.at(-1)?.wall_ms ?? null,
        eta_ms: left === 0 ? 0 : left !== null && rate ? Math.round(left / rate) : null,
    };
}

export interface RunRecord {
    name: string;
    /** The launch command line the record describes; a changed one starts a fresh record. */
    argv: string[];
    state: "pending" | "running" | "finalizing" | "finalized" | "gave-up";
    launches: number;
    stalled: number;
    progress_at_launch: number | null;
    launched_at: number | null;
    stopped_at: number | null;
    last_error: string | null;
    /** Consecutive polls whose step for this run threw. */
    step_failures: number;
    finalize: { command: string; exit: number | null }[];
    gave_up_reason: string | null;
}

export type Decision =
    | { action: "wait" | "launch" | "finalize" | "none" }
    | { action: "give-up"; reason: string };

/** Attempts in a row that measured no event before a run is given up. */
export const STALL_LIMIT = 3;
const BACKOFF_CAP_MS = 30 * 60_000;

/** The wait before relaunching a run whose last `stalled` attempts measured no event. */
export const relaunchDelay = (stalled: number, baseMs: number) =>
    stalled === 0 ? 0 : Math.min(BACKOFF_CAP_MS, baseMs * 4 ** (stalled - 1));

export function decide(
    record: RunRecord,
    progress: RunProgress,
    running: boolean,
    maxResumes: number,
    now = Date.now(),
    backoffMs = 60_000,
): Decision {
    if (record.state === "finalized" || record.state === "gave-up") return { action: "none" };
    if (record.state === "finalizing" || running) return { action: "wait" };
    if (progress.ended) return { action: "finalize" };
    const last = record.last_error ?? "no error line";
    if (record.stalled >= STALL_LIMIT) {
        const reason = `${record.stalled} attempts in a row measured no event; last error: ${last}`;
        return { action: "give-up", reason };
    }
    if (record.launches > maxResumes) {
        const reason = `stopped after ${record.launches - 1} resumes; last error: ${last}`;
        return { action: "give-up", reason };
    }
    if (
        record.stopped_at !== null &&
        now < record.stopped_at + relaunchDelay(record.stalled, backoffMs)
    ) {
        return { action: "wait" };
    }
    return { action: "launch" };
}

export function lastError(log: string): string | null {
    const lines = log.split("\n").filter((l) => l.startsWith("error: "));
    return lines.at(-1)?.slice(0, 400) ?? null;
}

export function inodeUse(path: string): number | null {
    try {
        const s = statfsSync(path);
        return s.files > 0 ? (s.files - s.ffree) / s.files : null;
    } catch {
        return null;
    }
}

export function alerts(
    spec: CampaignSpec,
    runs: { record: RunRecord; progress: RunProgress }[],
    now: number,
    inodes: (path: string) => number | null = inodeUse,
    spendUsd = 0,
): string[] {
    const out: string[] = [];
    if (spec.spend_cap_usd !== null && spendUsd > spec.spend_cap_usd) {
        out.push(`campaign spend $${Math.round(spendUsd)} passes the $${spec.spend_cap_usd} cap`);
    }
    for (const { record, progress } of runs) {
        if (record.state === "gave-up") {
            out.push(`run ${record.name} GAVE UP: ${record.gave_up_reason}`);
        }
        const last = Math.max(progress.last_entry_wall_ms ?? 0, record.launched_at ?? 0);
        if (record.state === "running" && last > 0 && now - last > spec.stale_ms) {
            const minutes = Math.round((now - last) / 60_000);
            out.push(`run ${record.name} journaled nothing for ${minutes} min`);
        }
        const failed = record.finalize.filter((f) => f.exit !== 0);
        if (record.state === "finalized" && failed.length > 0) {
            const which = failed.map((f) => `${f.command} exit ${f.exit}`).join(", ");
            out.push(`run ${record.name} finalize: ${which}`);
        }
    }
    for (const path of spec.inode_paths) {
        const used = inodes(path);
        if (used !== null && used > INODE_ALERT) {
            out.push(`${path} inode use ${(used * 100).toFixed(1)}% passes 80%`);
        }
    }
    return out;
}

/**
 * Alerts compared without the numbers that change between polls (a silence's minutes, an inode
 * percentage, the spend), so a growing count raises one alert, not one per poll.
 */
export const alertKey = (alert: string) =>
    alert
        .replace(/for \d+ min$/, "for # min")
        .replace(/inode use [\d.]+%/, "inode use #%")
        .replace(/^campaign spend \$\d+/, "campaign spend $#");

/** The last `error:` line within the last `tail` bytes of a log. */
export function lastErrorIn(path: string, tail = 64 * 1024): string | null {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return null;
    }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, tail);
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, size - length);
        return lastError(buf.toString("utf8"));
    } finally {
        closeSync(fd);
    }
}

/**
 * Opens a supervisor log without following a link; the path must be absent or a regular
 * single-link file. `truncate` empties it, otherwise writes append.
 */
export function openLog(path: string, truncate: boolean): number {
    const { O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = constants;
    const fd = openSync(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o644);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) {
        closeSync(fd);
        throw new Error(`${path} is not a plain file`);
    }
    if (truncate) ftruncateSync(fd, 0);
    return fd;
}
