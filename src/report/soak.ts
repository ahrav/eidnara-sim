import type { ArmLogs, RunLogs } from "../oracle/logs";
import { rssFit } from "../oracle/oracles";

export type Resource = "rss" | "heap" | "store_bytes";

export interface SoakVerdict {
    arm: string;
    resource: Resource;
    verdict: "leak" | "no leak" | "insufficient samples";
    samples: number;
    sessions: number;
    baseline: number | null;
    slope_per_session: number | null;
    r2: number | null;
    slope_over_bound: boolean;
    bound: { holds: boolean; worst: { value: number; limit: number; sessions: number } | null };
    returned_to_baseline: boolean | null;
    windows: { warmup: number; steady: number; cooldown: number };
    /** The longest wall-time gap between samples, against `leak_bound.sample_interval_ms`. */
    max_gap_ms: number | null;
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function soak(run: RunLogs, arm: ArmLogs, resource: Resource): SoakVerdict {
    const { c_bytes_per_session: c, r2_threshold } = run.prereg.leak_bound;
    const ends = arm.journal
        .filter((e) => e.kind === "Event" && run.kinds.get(String(e.event)) === "session_end")
        .map((e) => e.scenario_ms);
    const all = arm.resources.filter((s) => typeof s[resource] === "number");
    const first = all.findIndex((s) => (s[resource] as number) > 0);
    const samples = first < 0 ? [] : all.slice(first);
    const points = samples.map((s) => ({
        x: ends.filter((ms) => ms <= s.scenario_ms).length,
        y: s[resource] as number,
    }));
    const walls = samples.map((s) => s.wall_ms).filter((w): w is number => typeof w === "number");
    const gaps = walls.slice(1).map((w, i) => w - (walls[i] as number));
    const tenth = Math.max(1, Math.floor(points.length / 10));
    const warmup = points.slice(0, tenth);
    const cooldown = points.slice(-tenth);
    const steady = points.slice(tenth, points.length - tenth);
    const base = {
        arm: arm.arm,
        resource,
        samples: points.length,
        sessions: ends.length,
        windows: { warmup: warmup.length, steady: steady.length, cooldown: cooldown.length },
        max_gap_ms: gaps.length ? Math.max(...gaps) : null,
    };
    const baseline = points[0]?.y ?? null;
    const fit = steady.length >= 3 ? rssFit(steady) : null;
    if (baseline === null || fit === null) {
        return {
            ...base,
            verdict: "insufficient samples",
            baseline,
            slope_per_session: null,
            r2: null,
            slope_over_bound: false,
            bound: { holds: true, worst: null },
            returned_to_baseline: null,
        };
    }
    const slopeOver = fit.r2 >= Number(r2_threshold) && fit.slope > c;
    const worst = points
        .map((p) => ({ value: p.y, limit: 2 * baseline + p.x * c, sessions: p.x }))
        .reduce((w, p) => (p.value - p.limit > w.value - w.limit ? p : w));
    const holds = worst.value < worst.limit;
    const returned =
        resource !== "store_bytes"
            ? median(cooldown.map((p) => p.y)) <= median(warmup.map((p) => p.y)) + c
            : null;
    return {
        ...base,
        verdict: slopeOver || !holds || returned === false ? "leak" : "no leak",
        baseline,
        slope_per_session: fit.slope,
        r2: fit.r2,
        slope_over_bound: slopeOver,
        bound: { holds, worst },
        returned_to_baseline: returned,
    };
}

const MONTH_MS = 30 * 24 * 3_600_000;

/** One soak verdict per 30 days of scenario time, each over that month's samples alone. */
export function soakByMonth(
    run: RunLogs,
    arm: ArmLogs,
    resource: Resource,
): (SoakVerdict & { month: number })[] {
    const last = Math.max(0, ...arm.resources.map((s) => s.scenario_ms));
    return Array.from({ length: Math.floor(last / MONTH_MS) + 1 }, (_, month) => {
        const inMonth = (ms: number) => ms >= month * MONTH_MS && ms < (month + 1) * MONTH_MS;
        const slice: ArmLogs = {
            ...arm,
            resources: arm.resources.filter((s) => inMonth(s.scenario_ms)),
            journal: arm.journal.filter((e) => inMonth(e.scenario_ms)),
        };
        return { month: month + 1, ...soak(run, slice, resource) };
    });
}
