import {
    closeSync,
    constants,
    fstatSync,
    ftruncateSync,
    openSync,
    readFileSync,
    statfsSync,
} from "node:fs";
import { join } from "node:path";
import { interruptions } from "./interruptions";
import { type Entry, readJournal } from "./journal";

export interface CampaignSpec {
    schema: "sim-campaign/v1";
    out: string;
    runs: { name: string; args: string[] }[];
    args: string[];
    max_resumes: number;
    poll_ms: number;
    stale_ms: number;
    inode_paths: string[];
    run_command: string[];
    finalize_commands: string[][];
    finalize_timeout_ms: number;
    relaunch_backoff_ms: number;
}

export const DEFAULT_RUN = ["bun", "scripts/run-tier.ts"];
export const DEFAULT_FINALIZE = [
    ["bun", "scripts/grade-run.ts", "{dir}"],
    ["bun", "scripts/evidence-run.ts", "{dir}"],
    ["bun", "scripts/pairing-check.ts", "{dir}"],
];
export const INODE_ALERT = 0.8;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
/** Names of the supervisor's own files and directories under `out`. */
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
            RESERVED.has(r.name) ||
            names.has(r.name)
        ) {
            problems.push(`run name ${JSON.stringify(r?.name)} is not a unique plain name`);
        } else names.add(r.name);
        if (!strings(r?.args)) problems.push(`run ${r?.name} args are not strings`);
        if ((r?.args ?? []).includes("--out")) problems.push(`run ${r?.name} names its own --out`);
    }
    if (o?.args !== undefined && !strings(o.args)) problems.push("args are not strings");
    if ((o?.args ?? []).includes("--out")) problems.push("shared args name --out");
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
    };
}

export const runDir = (spec: CampaignSpec, name: string) => join(spec.out, name);

export function launchArgv(spec: CampaignSpec, run: CampaignSpec["runs"][number]): string[] {
    return [...spec.run_command, ...spec.args, ...run.args, "--out", runDir(spec, run.name)];
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
    const failed = new Set(
        entries
            .filter(
                (e) =>
                    (e.kind === "EndTurn" && e.outcome !== "ok") ||
                    (e.kind === "Event" && e.outcome === "failed(interrupted)"),
            )
            .map((e) => `${e.arm}/${e.event}`),
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
): string[] {
    const out: string[] = [];
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

/** Alerts compared without their numbers, so a growing count raises one alert, not one per poll. */
export const alertKey = (alert: string) => alert.replace(/\d+(?:\.\d+)?/g, "#");

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
