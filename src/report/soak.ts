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
    /** `value < 2 * baseline + sessions * c`, with the pre-registered `c_bytes_per_session`. */
    bound: {
        c: number;
        holds: boolean;
        worst: { value: number; limit: number; sessions: number } | null;
    };
    returned_to_baseline: boolean | null;
    windows: { warmup: number; steady: number; cooldown: number };
    /**
     * The longest wall-time gap between sampler rows, those taken with the daemon down included,
     * against `leak_bound.sample_interval_ms`.
     */
    max_gap_ms: number | null;
    /**
     * Daemon processes the samples span: each `pid` run is its own memory trajectory, and the
     * verdict is the most decisive generation's (`leak`, then `no leak`, then `insufficient
     * samples`), `generation` naming it from 1. `store_bytes` is one trajectory. An arm with no
     * sample of the resource has `generations: 0` and the insufficient-samples verdict.
     */
    generations: number;
    generation: number;
}

type Evaluated = Omit<
    SoakVerdict,
    "arm" | "resource" | "sessions" | "max_gap_ms" | "generations" | "generation"
>;

const RANK: Record<SoakVerdict["verdict"], number> = {
    leak: 2,
    "no leak": 1,
    "insufficient samples": 0,
};

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Consecutive samples from one daemon process, told apart by `pid` and the process's start time.
 * A sample with no process (`pid: null`) is a boundary of its own, and a replacement that reuses
 * the pid after a resume differs in `start`, its process start time, so each starts a new run. A
 * row with a `pid` and a `null` start carries no identity and is left out before the split, so it
 * opens no generation; the strict loader in `src/oracle/logs.ts` refuses such rows.
 */
function byPid(samples: ArmLogs["resources"]): ArmLogs["resources"][] {
    const process = (s: ArmLogs["resources"][number]) => `${s.pid}/${s.start}`;
    const runs: ArmLogs["resources"][] = [];
    for (const s of samples) {
        const last = runs[runs.length - 1];
        if (last?.[0] && process(last[0]) === process(s)) last.push(s);
        else runs.push([s]);
    }
    return runs;
}

/**
 * `null` when a sample lacks the resource's field altogether (a `resources.jsonl` begun before
 * the sampler recorded it), so the verdict never rests on the suffix that has it; and, for a
 * memory resource, when a sample with a process lacks `start`, since two processes sharing
 * a pid could then be told apart only by a `pid: null` row between them.
 */
export function soak(run: RunLogs, arm: ArmLogs, resource: Resource): SoakVerdict | null {
    if (arm.resources.some((s) => !(resource in s))) return null;
    const unidentified = (s: ArmLogs["resources"][number]) =>
        typeof s.pid === "number" && !("start" in s);
    if (resource !== "store_bytes" && arm.resources.some(unidentified)) return null;
    const ends = arm.journal
        .filter((e) => e.kind === "Event" && run.kinds.get(String(e.event)) === "session_end")
        .map((e) => e.wall_ms);
    const sampled = (s: ArmLogs["resources"][number]) =>
        typeof s[resource] === "number" && typeof s.wall_ms === "number";
    const walls = arm.resources
        .map((s) => s.wall_ms)
        .filter((w): w is number => typeof w === "number");
    const gaps = walls.slice(1).map((w, i) => w - (walls[i] as number));
    const identified = arm.resources.filter(
        (s) => !(typeof s.pid === "number" && s.start === null),
    );
    const generations = (resource === "store_bytes" ? [arm.resources] : byPid(identified))
        .map((g) => g.filter(sampled))
        .filter((g) => g.length > 0);
    const verdicts = (generations.length === 0 ? [[]] : generations).map((g) =>
        evaluate(run, resource, ends, g),
    );
    const chosen = verdicts.reduce<number>((best, v, i) => {
        const b = verdicts[best] as Evaluated;
        const better =
            RANK[v.verdict] > RANK[b.verdict] ||
            (RANK[v.verdict] === RANK[b.verdict] && v.samples > b.samples);
        return better ? i : best;
    }, 0);
    return {
        arm: arm.arm,
        resource,
        sessions: ends.length,
        max_gap_ms: gaps.length ? Math.max(...gaps) : null,
        generations: generations.length,
        generation: chosen + 1,
        ...(verdicts[chosen] as Evaluated),
    };
}

function evaluate(
    run: RunLogs,
    resource: Resource,
    ends: number[],
    generation: ArmLogs["resources"],
): Evaluated {
    const { c_bytes_per_session: c, r2_threshold } = run.prereg.leak_bound;
    const first = generation.findIndex((s) => (s[resource] as number) > 0);
    const samples = first < 0 ? [] : generation.slice(first);
    const completed = (s: (typeof samples)[number]) =>
        ends.filter((ms) => ms < (s.wall_ms as number)).length;
    const before = samples[0] === undefined ? 0 : completed(samples[0]);
    const points = samples.map((s) => ({ x: completed(s) - before, y: s[resource] as number }));
    const tenth = Math.max(1, Math.floor(points.length / 10));
    const warmup = points.slice(0, tenth);
    const cooldown = points.slice(-tenth);
    const steady = points.slice(tenth, points.length - tenth);
    const base = {
        samples: points.length,
        windows: { warmup: warmup.length, steady: steady.length, cooldown: cooldown.length },
    };
    const baseline = points[0]?.y ?? null;
    if (baseline === null) {
        return {
            ...base,
            verdict: "insufficient samples",
            baseline,
            slope_per_session: null,
            r2: null,
            slope_over_bound: false,
            bound: { c, holds: true, worst: null },
            returned_to_baseline: null,
        };
    }
    const fit = steady.length >= 3 ? rssFit(steady) : null;
    const slopeOver = fit !== null && fit.r2 >= Number(r2_threshold) && fit.slope > c;
    const worst = points
        .map((p) => ({ value: p.y, limit: 2 * baseline + p.x * c, sessions: p.x }))
        .reduce((w, p) => (p.value - p.limit > w.value - w.limit ? p : w));
    const holds = worst.value < worst.limit;
    const returned =
        resource !== "store_bytes"
            ? median(cooldown.map((p) => p.y)) <= median(warmup.map((p) => p.y)) + c
            : null;
    const leak = slopeOver || !holds || returned === false;
    return {
        ...base,
        verdict: leak ? "leak" : fit === null ? "insufficient samples" : "no leak",
        baseline,
        slope_per_session: fit?.slope ?? null,
        r2: fit?.r2 ?? null,
        slope_over_bound: slopeOver,
        bound: { c, holds, worst },
        returned_to_baseline: returned,
    };
}

const MONTH_MS = 30 * 24 * 3_600_000;

/**
 * One within-month soak verdict per 30 days of scenario time the arm's journal or samples
 * reach. Each verdict uses that month's samples and sessions; the last month may be partial,
 * and a month whose samples give `soak` no verdict has no row.
 */
export function soakByMonth(
    run: RunLogs,
    arm: ArmLogs,
    resource: Resource,
): (SoakVerdict & { month: number })[] {
    const last = Math.max(
        0,
        ...arm.resources.map((s) => s.scenario_ms),
        ...arm.journal.map((e) => e.scenario_ms),
    );
    return Array.from({ length: Math.floor(last / MONTH_MS) + 1 }, (_, month) => {
        const inMonth = (ms: number) => ms >= month * MONTH_MS && ms < (month + 1) * MONTH_MS;
        const slice: ArmLogs = {
            ...arm,
            resources: arm.resources.filter((s) => inMonth(s.scenario_ms)),
            journal: arm.journal.filter((e) => inMonth(e.scenario_ms)),
        };
        const verdict = soak(run, slice, resource);
        return verdict ? [{ month: month + 1, ...verdict }] : [];
    }).flat();
}
