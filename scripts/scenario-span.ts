/**
 * The report measures advances between consecutive events in scenario order. It measures spans
 * and session gaps both across the scenario and within each project.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;
const DAY = 24 * HOUR;
/** Each advance counts toward every threshold it reaches. */
export const ADVANCE_THRESHOLDS = [
    ["30s", 30 * SECOND],
    ["60s", 60 * SECOND],
    ["1h", HOUR],
    ["24h", DAY],
    ["7d", 7 * DAY],
] as const;
export type AdvanceCounts = Record<(typeof ADVANCE_THRESHOLDS)[number][0], number>;

export interface SpanScenario {
    manifest?: { seed?: unknown; tier?: unknown };
    events: {
        id?: unknown;
        kind?: unknown;
        scenario_ms?: unknown;
        session?: unknown;
        project?: unknown;
    }[];
}

export interface ProjectSpan {
    sessions: number;
    /** From the start of the project's first session to the end of its last session. */
    span_ms: number;
    span_days: number;
    /** The longest time from the end of one session of the project to the start of its next. */
    largest_gap_ms: number;
    gaps_at_least: AdvanceCounts;
}

export interface ScenarioSpan {
    seed: number | null;
    tier: string | null;
    events: number;
    user_turns: number;
    sessions: number;
    projects: Record<string, ProjectSpan>;
    span_ms: number;
    span_days: number;
    /** The largest advance between consecutive events, and the event it lands on. */
    largest_advance_ms: number;
    largest_advance_at: string | null;
    /** The scenario-wide session gap includes gaps across project boundaries. */
    largest_session_gap_ms: number;
    advances_at_least: AdvanceCounts;
}

const counts = (): AdvanceCounts =>
    Object.fromEntries(ADVANCE_THRESHOLDS.map(([name]) => [name, 0])) as AdvanceCounts;
const tally = (into: AdvanceCounts, ms: number) => {
    for (const [name, least] of ADVANCE_THRESHOLDS) if (ms >= least) into[name]++;
};
const days = (ms: number) => Number((ms / DAY).toFixed(3));

/**
 * An event whose `scenario_ms` precedes its predecessor's counts as a zero advance. A session
 * runs from its `session_start` time to its greatest `scenario_ms` and belongs to the project
 * its `session_start` names. An `apply_diff` event prepares a session before its
 * `session_start`, so it counts only toward event advances.
 */
export function scenarioSpan(scenario: SpanScenario): ScenarioSpan {
    const events = scenario.events;
    if (!Array.isArray(events) || events.length === 0) {
        throw new Error("the scenario holds no event");
    }
    const at = events.map((e, i) => {
        const ms = e.scenario_ms;
        if (typeof ms !== "number" || !Number.isFinite(ms)) {
            throw new Error(`event ${String(e.id ?? i)} holds no scenario time`);
        }
        return ms;
    });
    const sessions = new Map<string, { project: string; start: number; end: number }>();
    const advances = counts();
    let largest = 0;
    let largestAt: string | null = null;
    let largestSessionGap = 0;
    let lastEnd: number | null = null;
    for (const [i, e] of events.entries()) {
        const ms = at[i] as number;
        if (i > 0) {
            const step = Math.max(0, ms - (at[i - 1] as number));
            tally(advances, step);
            if (step > largest) {
                largest = step;
                largestAt = typeof e.id === "string" ? e.id : String(i);
            }
        }
        const id = typeof e.session === "string" ? e.session : null;
        if (id === null || e.kind === "apply_diff") continue;
        const open = sessions.get(id);
        if (e.kind === "session_start" && !open) {
            const project = e.project;
            if (typeof project !== "string") throw new Error(`session ${id} names no project`);
            sessions.set(id, { project, start: ms, end: ms });
            if (lastEnd !== null) largestSessionGap = Math.max(largestSessionGap, ms - lastEnd);
        } else if (open) {
            open.end = Math.max(open.end, ms);
        } else {
            throw new Error(`event ${String(e.id ?? i)} precedes the start of session ${id}`);
        }
        if (e.kind === "session_end") lastEnd = ms;
    }
    const projects: Record<string, ProjectSpan> = {};
    const byProject = new Map<string, { start: number; end: number }[]>();
    for (const s of sessions.values()) {
        byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
    }
    for (const [project, own] of [...byProject].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const ordered = [...own].sort((a, b) => a.start - b.start);
        const gaps = counts();
        let gap = 0;
        for (const [i, s] of ordered.entries()) {
            if (i === 0) continue;
            const idle = Math.max(0, s.start - (ordered[i - 1] as { end: number }).end);
            tally(gaps, idle);
            gap = Math.max(gap, idle);
        }
        const first = (ordered[0] as { start: number }).start;
        const last = Math.max(...ordered.map((s) => s.end));
        projects[project] = {
            sessions: ordered.length,
            span_ms: last - first,
            span_days: days(last - first),
            largest_gap_ms: gap,
            gaps_at_least: gaps,
        };
    }
    const span = Math.max(...at) - Math.min(...at);
    const seed = scenario.manifest?.seed;
    const tier = scenario.manifest?.tier;
    return {
        seed: typeof seed === "number" ? seed : null,
        tier: typeof tier === "string" ? tier : null,
        events: events.length,
        user_turns: events.filter((e) => e.kind === "user_turn").length,
        sessions: sessions.size,
        projects,
        span_ms: span,
        span_days: days(span),
        largest_advance_ms: largest,
        largest_advance_at: largestAt,
        largest_session_gap_ms: largestSessionGap,
        advances_at_least: advances,
    };
}

const hours = (ms: number) => `${(ms / HOUR).toFixed(1)} h`;

export const SPAN_HEADER =
    "scenario | seed | tier | events | user turns | sessions | projects (sessions) | span days | largest advance | largest gap between sessions | advances >= 30 s / 60 s / 1 h / 24 h / 7 d | per project: span days, largest gap, gaps >= 24 h / 7 d";

export function spanRow(name: string, s: ScenarioSpan): string {
    const a = s.advances_at_least;
    const projects = Object.entries(s.projects);
    return [
        name,
        s.seed ?? "",
        s.tier ?? "",
        s.events,
        s.user_turns,
        s.sessions,
        projects.map(([p, v]) => `${p} (${v.sessions})`).join(", "),
        s.span_days.toFixed(2),
        hours(s.largest_advance_ms),
        hours(s.largest_session_gap_ms),
        [a["30s"], a["60s"], a["1h"], a["24h"], a["7d"]].join(" / "),
        projects
            .map(
                ([p, v]) =>
                    `${p}: ${v.span_days.toFixed(2)} d, ${hours(v.largest_gap_ms)}, ${v.gaps_at_least["24h"]} / ${v.gaps_at_least["7d"]}`,
            )
            .join("; "),
    ].join(" | ");
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const json = args.includes("--json");
    const paths = args.filter((a) => a !== "--json");
    if (paths.length === 0 || paths.some((p) => p.startsWith("--"))) {
        console.error("usage: bun scripts/scenario-span.ts [--json] <scenario.json>...");
        process.exit(2);
    }
    const rows: string[] = [];
    for (const path of paths) {
        let span: ScenarioSpan;
        try {
            span = scenarioSpan(JSON.parse(readFileSync(resolve(path), "utf8")) as SpanScenario);
        } catch (caught) {
            console.error(`${path}: ${(caught as Error).message}`);
            process.exit(2);
        }
        rows.push(
            json ? JSON.stringify({ scenario: path, ...span }) : spanRow(basename(path), span),
        );
    }
    console.log([...(json ? [] : [SPAN_HEADER]), ...rows].join("\n"));
}
