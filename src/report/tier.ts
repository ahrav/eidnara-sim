import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GradeLog } from "../grade/probes";
import { armBase } from "../hosts/arms";
import { loadRun } from "../oracle/logs";
import { oracleReport } from "../oracle/oracles";
import { recoveries } from "../oracle/recovery";
import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import { betaQuantile } from "../stats/dist";
import { evaluateTier, falsificationSet } from "../stats/gate";
import { continuity, runConditions } from "./conditions";
import { costPanel } from "./cost";
import { falsificationPairs } from "./falsify";
import { intrusiveness } from "./intrusive";
import { type GradedRun, tierInput, userTexts } from "./observe";
import type { TierReport } from "./render";
import { soak } from "./soak";
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
        counterfactual: counterfactual(runs),
    };
}

export interface Counterfactual {
    items: number;
    memory_passes: number;
    flips: number;
    attribution_rate: number | null;
    interval: [number, number] | null;
    deletions: { probe: string; deleted: number; remaining: number }[];
}

/**
 * The counterfactual arm's attribution rate: of the sampled P1, P3, and P5 items the memory arm
 * passed, the share that fail once the counterfactual arm deletes the fact's memory, with a
 * Clopper-Pearson interval.
 */
export function counterfactual(
    runs: GradedRun[],
    memory = "eidnara",
    cf = "eidnara-cf",
): Counterfactual | null {
    if (!runs.some((g) => g.run.arms.some((a) => a.arm === cf))) return null;
    const pairs = runs.flatMap((g) => {
        const verdict = (arm: string, item: string) =>
            g.grades.find((r) => r.arm === arm && r.item === item)?.verdict;
        return (g.scenario.cf_deletions ?? []).map((d) => ({
            m: verdict(memory, d.probe),
            c: verdict(cf, d.probe),
        }));
    });
    const graded = pairs.filter((p) => p.m && p.c && p.m !== "excluded" && p.c !== "excluded");
    const passes = graded.filter((p) => p.m === "pass");
    const flips = passes.filter((p) => p.c === "fail").length;
    const n = passes.length;
    const interval: [number, number] | null =
        n === 0
            ? null
            : [
                  flips === 0 ? 0 : betaQuantile(0.025, flips, n - flips + 1),
                  flips === n ? 1 : betaQuantile(0.975, flips + 1, n - flips),
              ];
    const deletions = runs.flatMap((g) =>
        (g.run.arms.find((a) => a.arm === cf)?.journal ?? [])
            .filter((e) => e.kind === "CounterfactualDeletion")
            .map((e) => ({
                probe: String(e.probe),
                deleted: ((e.deleted as number[] | undefined) ?? []).length,
                remaining: Number(e.remaining ?? 0),
            })),
    );
    return {
        items: graded.length,
        memory_passes: n,
        flips,
        attribution_rate: n ? flips / n : null,
        interval,
        deletions,
    };
}
