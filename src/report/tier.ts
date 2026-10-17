import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GradeLog } from "../grade/probes";
import { armBase } from "../hosts/arms";
import { loadRun } from "../oracle/logs";
import { oracleReport } from "../oracle/oracles";
import { recoveries } from "../oracle/recovery";
import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import { evaluateTier, falsificationSet } from "../stats/gate";
import { clopperPearson } from "../stats/tests";
import { type Continuity, continuity, recallDrift, runConditions } from "./conditions";
import { costPanel } from "./cost";
import { falsificationPairs } from "./falsify";
import { intrusiveness } from "./intrusive";
import { type GradedRun, tierInput, userTexts } from "./observe";
import type { TierReport } from "./render";
import { soak, soakByMonth } from "./soak";
import { propertyWitness } from "./witness";

export function loadGraded(dir: string, prereg: Preregistration): GradedRun {
    const grades = join(dir, "grades.jsonl");
    return {
        run: loadRun(dir, prereg),
        scenario: JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario,
        grades: existsSync(grades) ? new GradeLog(grades).latest() : [],
    };
}

const sd = (xs: number[]) => {
    if (xs.length < 2) return undefined;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return v > 0 ? Math.sqrt(v) : undefined;
};

export function tierReport(
    prereg: Preregistration,
    runs: GradedRun[],
    claimBoundary: string,
    catalog = "",
    reference?: { source: string; continuity: Continuity[] },
): TierReport {
    const arms = [...new Set(runs.flatMap((g) => g.run.arms.map((a) => a.arm)))];
    const control = arms.find((a) => a.includes("~"));
    const pair: [string, string] = control
        ? [armBase(control), control]
        : ["host", prereg.arms.default];
    const input = tierInput(prereg, runs);
    if (control) {
        const aa = tierInput(prereg, runs, control, armBase(control));
        const diffs = (family: string) => {
            const metrics = prereg.families.find((f) => f.id === family)?.metrics ?? [];
            const best = new Map<string, number>();
            for (const o of aa.observations.filter((x) => metrics.includes(x.metric))) {
                for (const x of o.items ?? []) {
                    const d = x.treatment - x.control;
                    best.set(x.item, Math.max(best.get(x.item) ?? Number.NEGATIVE_INFINITY, d));
                }
            }
            return [...best.values()];
        };
        input.cusum_sd = { harm: sd(diffs("harm")), futility: sd(diffs("probe-P1")) };
    }
    const falsify: Record<string, { control: number; treatment: number }[]> = {};
    for (const g of runs) {
        for (const [k, v] of Object.entries(falsificationPairs(g, ...pair)))
            falsify[k] = [...(falsify[k] ?? []), ...v];
    }
    const perArm = runs.flatMap((g) => g.run.arms.map((arm) => ({ g, arm })));
    const observed = Object.fromEntries(
        input.observations.map((o) => {
            const items = o.items ?? [];
            const rate = items.length
                ? [items.reduce((s, x) => s + x.treatment, 0) / items.length]
                : [];
            return [o.metric, o.runs ? o.runs.map((x) => x.treatment) : rate];
        }),
    );
    return {
        tier: prereg.tier,
        treatment: prereg.arms.default,
        falsification_pair: pair,
        observed,
        runs: runs.map((g) => g.run.dir),
        arms,
        grades: runs.flatMap((g) => g.grades),
        verdict: evaluateTier(prereg, input),
        oracles: oracleReport(runs.map((g) => g.run))[prereg.tier] ?? {},
        recoveries: runs.flatMap((g) => recoveries(g.run).map((r) => ({ ...r, run: g.run.dir }))),
        soak: perArm
            .filter(({ arm }) => armBase(arm.arm) !== "host")
            .flatMap(({ g, arm }) =>
                (["rss", "heap", "store_bytes"] as const).map((r) => soak(g.run, arm, r)),
            ),
        intrusiveness: perArm.map(({ g, arm }) => intrusiveness(g.run, arm, userTexts(g))),
        cost: perArm.map(({ g, arm }) => costPanel(g.run, arm, g.grades)),
        falsification: falsificationSet(prereg, falsify),
        aa: runs.flatMap((g) => {
            const path = join(g.run.dir, "aa.json");
            return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
        }),
        prereg,
        claim_boundary: claimBoundary,
        witness: propertyWitness(catalog, runs),
        conditions: runs.map(runConditions),
        continuity: continuity(runs),
        drift: reference ? recallDrift(continuity(runs), reference.continuity) : null,
        drift_source: reference?.source ?? null,
        soak_by_month: perArm
            .filter(({ arm }) => prereg.tier === "XL" && armBase(arm.arm) !== "host")
            .flatMap(({ g, arm }) =>
                soakByMonth(g.run, arm, "rss").map((s) => ({ run: g.run.dir, ...s })),
            ),
        counterfactual: counterfactual(runs),
    };
}

export interface Counterfactual {
    attempted: number;
    verified: number;
    items: number;
    memory_passes: number;
    flips: number;
    attribution_rate: number | null;
    interval: [number, number] | null;
    placebo: { memory_passes: number; flips: number; rate: number | null };
    deletions: {
        run: string;
        probe: string;
        deleted: number;
        remaining: number;
        skipped?: string;
    }[];
}

const CF_TYPES = ["P1", "P3", "P5"];

/**
 * The counterfactual arm's attribution rate: of the sampled P1, P3, and P5 items whose deletion
 * the arm verified (notes deleted, none matching left) and the memory arm passed, the share that
 * fail with the fact's memory deleted, with a Clopper-Pearson interval. The placebo rate is the
 * same flip share over the unsampled P1, P3, and P5 items, where nothing was deleted. Deletions
 * accumulate over a run, so a later item's flip may follow an earlier deletion too.
 */
export function counterfactual(
    runs: GradedRun[],
    memory = "eidnara",
    cf = "eidnara-cf",
): Counterfactual | null {
    const both = runs.filter((g) => [memory, cf].every((a) => g.run.arms.some((x) => x.arm === a)));
    if (both.length === 0) return null;
    const deletions = both.flatMap((g) =>
        (g.run.arms.find((a) => a.arm === cf)?.journal ?? [])
            .filter((e) => e.kind === "CounterfactualDeletion")
            .map((e) => ({
                run: g.run.dir,
                probe: String(e.probe),
                deleted: ((e.deleted as number[] | undefined) ?? []).length,
                remaining: Number(e.remaining ?? 0),
                ...(e.skipped ? { skipped: String(e.skipped) } : {}),
            })),
    );
    const verified = new Set(
        deletions
            .filter((d) => !d.skipped && d.deleted > 0 && d.remaining === 0)
            .map((d) => `${d.run}/${d.probe}`),
    );
    const flipsOver = (items: (g: GradedRun) => string[]) => {
        const pairs = both.flatMap((g) => {
            const verdict = (arm: string, item: string) =>
                g.grades.find((r) => r.arm === arm && r.item === item)?.verdict;
            return items(g).map((item) => ({ m: verdict(memory, item), c: verdict(cf, item) }));
        });
        const graded = pairs.filter((p) => p.m && p.c && p.m !== "excluded" && p.c !== "excluded");
        const passes = graded.filter((p) => p.m === "pass");
        return {
            items: graded.length,
            n: passes.length,
            flips: passes.filter((p) => p.c === "fail").length,
        };
    };
    const sampled = (g: GradedRun) => new Set((g.scenario.cf_deletions ?? []).map((d) => d.probe));
    const target = flipsOver((g) =>
        [...sampled(g)].filter((p) => verified.has(`${g.run.dir}/${p}`)),
    );
    const placebo = flipsOver((g) =>
        g.scenario.probes
            .filter((p) => CF_TYPES.includes(p.type) && !sampled(g).has(p.id))
            .map((p) => p.id),
    );
    return {
        attempted: deletions.length,
        verified: verified.size,
        items: target.items,
        memory_passes: target.n,
        flips: target.flips,
        attribution_rate: target.n ? target.flips / target.n : null,
        interval: target.n ? clopperPearson(target.flips, target.n) : null,
        placebo: {
            memory_passes: placebo.n,
            flips: placebo.flips,
            rate: placebo.n ? placebo.flips / placebo.n : null,
        },
        deletions,
    };
}
