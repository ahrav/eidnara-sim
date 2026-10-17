import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GradeLog } from "../grade/probes";
import { armBase } from "../hosts/arms";
import { loadRun } from "../oracle/logs";
import { oracleReport } from "../oracle/oracles";
import { recoveries } from "../oracle/recovery";
import type { Preregistration } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import type { Scenario } from "../scenario/compile";
import { evaluateTier, falsificationSet, type TierInput } from "../stats/gate";
import { costPanel } from "./cost";
import { falsificationPairs } from "./falsify";
import { intrusiveness } from "./intrusive";
import { type GradedRun, tierInput, userTexts } from "./observe";
import type { TierReport } from "./render";
import { soak } from "./soak";

export function loadGraded(dir: string, prereg: Preregistration): GradedRun {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        host: string;
        prereg_sha256: string;
    };
    const current = preregistrationHash(prereg);
    if (manifest.prereg_sha256 !== current) {
        throw new Error(
            `${dir}: ran under pre-registration ${manifest.prereg_sha256}; the report uses ${current}`,
        );
    }
    const grades = join(dir, "grades.jsonl");
    return {
        run: loadRun(dir, prereg),
        scenario: JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario,
        grades: existsSync(grades) ? new GradeLog(grades).latest() : [],
        host: manifest.host,
    };
}

const sd = (xs: number[]) => {
    if (xs.length < 2) return undefined;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return v > 0 ? Math.sqrt(v) : undefined;
};

export type CusumScale = NonNullable<TierInput["cusum_sd"]>;

const controlArm = (runs: GradedRun[]) =>
    runs.flatMap((g) => g.run.arms.map((a) => a.arm)).find((a) => a.includes("~"));

/**
 * The CUSUM rules' scale from the runs' A/A control (`<arm>~<tag>`): the standard deviation of
 * its paired item differences, over the per-item maximum across the harm metrics and over the
 * P1 items.
 */
export function aaScale(prereg: Preregistration, runs: GradedRun[]): CusumScale | undefined {
    const control = controlArm(runs);
    if (!control) return undefined;
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
    return { harm: sd(diffs("harm")), futility: sd(diffs("probe-P1")) };
}

export function tierReport(
    prereg: Preregistration,
    runs: GradedRun[],
    claimBoundary: string,
    scale: CusumScale | undefined = aaScale(prereg, runs),
): TierReport {
    const arms = [...new Set(runs.flatMap((g) => g.run.arms.map((a) => a.arm)))];
    const control = controlArm(runs);
    const pair: [string, string] = control
        ? [armBase(control), control]
        : ["host", prereg.arms.default];
    const input = tierInput(prereg, runs);
    input.cusum_sd = scale;
    const falsify: Record<string, { control: number; treatment: number }[]> = {};
    for (const g of runs) {
        for (const [k, v] of Object.entries(falsificationPairs(g, ...pair)))
            falsify[k] = [...(falsify[k] ?? []), ...v];
    }
    const perArm = runs.flatMap((g) => g.run.arms.map((arm) => ({ g, arm })));
    const dropped = new Set([...input.excluded.map((e) => e.id), ...input.asymmetric]);
    const observed = Object.fromEntries(
        input.observations.map((o) => {
            const items = (o.items ?? []).filter((x) => !dropped.has(x.item));
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
        intrusiveness: perArm.map(({ g, arm }) => ({
            ...intrusiveness(g.run, arm, userTexts(g)),
            run: g.run.dir,
        })),
        cost: perArm.map(({ g, arm }) => costPanel(g.run, arm, g.grades)),
        falsification: falsificationSet(prereg, falsify),
        aa: runs.flatMap((g) => {
            const path = join(g.run.dir, "aa.json");
            return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
        }),
        prereg,
        claim_boundary: claimBoundary,
    };
}
