import { existsSync, readFileSync, statfsSync } from "node:fs";
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
}

export const DEFAULT_RUN = ["bun", "scripts/run-tier.ts"];
export const DEFAULT_FINALIZE = [
    ["bun", "scripts/grade-run.ts", "{dir}"],
    ["bun", "scripts/evidence-run.ts", "{dir}", "--out", "{evidence}"],
    ["bun", "scripts/pairing-check.ts", "{dir}"],
];
export const INODE_ALERT = 0.8;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

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
        if (typeof r?.name !== "string" || !NAME.test(r.name) || names.has(r.name)) {
            problems.push(`run name ${JSON.stringify(r?.name)} is not a unique plain name`);
        } else names.add(r.name);
        if (!strings(r?.args)) problems.push(`run ${r?.name} args are not strings`);
        if ((r?.args ?? []).includes("--out")) problems.push(`run ${r?.name} names its own --out`);
    }
    if (o?.args !== undefined && !strings(o.args)) problems.push("args are not strings");
    if ((o?.args ?? []).includes("--out")) problems.push("shared args name --out");
    for (const k of ["max_resumes", "poll_ms", "stale_ms"] as const) {
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
    lifecycle_entries: number;
    last_entry_wall_ms: number | null;
    eta_ms: number | null;
}

const RATE_WINDOW_MS = 6 * 3600_000;

export function runProgress(dir: string, now = Date.now()): RunProgress {
    const path = join(dir, "journal.jsonl");
    const entries: Entry[] =
        existsSync(path) && readFileSync(path).length > 0 ? readJournal(path) : [];
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
        lifecycle_entries: entries.filter((e) => e.kind !== "Preflight").length,
        last_entry_wall_ms: entries.at(-1)?.wall_ms ?? null,
        eta_ms: left === 0 ? 0 : left !== null && rate ? Math.round(left / rate) : null,
    };
}

export interface RunRecord {
    name: string;
    state: "pending" | "running" | "finalized" | "gave-up";
    launches: number;
    stalled: number;
    progress_at_launch: number | null;
    last_error: string | null;
    finalize: { command: string; exit: number | null }[];
    gave_up_reason: string | null;
}

export type Action = "wait" | "launch" | "finalize" | "give-up" | "none";

export function decide(
    record: RunRecord,
    progress: RunProgress,
    running: boolean,
    maxResumes: number,
): Action {
    if (record.state === "finalized" || record.state === "gave-up") return "none";
    if (running) return "wait";
    if (progress.ended) return "finalize";
    if (record.stalled >= 2) return "give-up";
    if (record.launches > maxResumes) return "give-up";
    return "launch";
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
        const last = progress.last_entry_wall_ms;
        if (record.state === "running" && last !== null && now - last > spec.stale_ms) {
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
