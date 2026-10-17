import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GradeLog, type GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import { loadRun } from "../oracle/logs";
import { oracleReport } from "../oracle/oracles";
import { recoveries } from "../oracle/recovery";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { excludedFromFaultMetrics, type WitnessReport } from "../proxy/inject";
import { readJournal } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import { evaluateTier, falsificationSet, type TierInput } from "../stats/gate";
import { continuity, runConditions } from "./conditions";
import { costPanel, judgeCost } from "./cost";
import { falsificationPairs } from "./falsify";
import { intrusiveness } from "./intrusive";
import { type GradedRun, type RunIdentity, tierInput } from "./observe";
import type { TierReport } from "./render";
import { soak } from "./soak";
import { propertyWitness } from "./witness";

export function loadGraded(dir: string, prereg: Preregistration): GradedRun {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        host: string;
        prereg_sha256: string;
        scenario_hash: string;
        fault_override: Scenario["faults"] | null;
        preflight?: { distortions?: string[] };
    } & Omit<RunIdentity, "distortions">;
    const current = preregistrationHash(prereg);
    if (manifest.prereg_sha256 !== current) {
        throw new Error(
            `${dir}: ran under pre-registration ${manifest.prereg_sha256}; the report uses ${current}`,
        );
    }
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const { scenario_hash: _, ...body } = scenario;
    const actual = sha256Hex(canonicalJson(body));
    if (actual !== manifest.scenario_hash) {
        throw new Error(
            `${dir}: scenario.json hashes to ${actual}; the manifest ran scenario ${manifest.scenario_hash}`,
        );
    }
    const log = new GradeLog(join(dir, "grades.jsonl"));
    const all = log.all();
    const judged = new Map<string, GradeRecord>();
    for (const g of all.filter((r) => r.probe_type === "P7")) {
        const key = `${g.item}/${g.arm}/${g.inputs.join("\n")}`;
        if ((judged.get(key)?.version ?? 0) < g.version) judged.set(key, g);
    }
    const { eidnara_commit, models, context_limit, events } = manifest;
    const witnesses = new Map<string, WitnessReport>();
    const faults = join(dir, "faults.jsonl");
    const reports = existsSync(faults) ? (readJournal(faults) as unknown as WitnessReport[][]) : [];
    for (const w of reports.flat()) {
        if (witnesses.get(w.fault)?.status !== "fired") witnesses.set(w.fault, w);
    }
    return {
        run: loadRun(dir, prereg),
        scenario: { ...scenario, faults: manifest.fault_override ?? scenario.faults },
        grades: log.latest(),
        judged: [...judged.values()],
        host: manifest.host,
        identity: {
            eidnara_commit,
            models,
            context_limit,
            events,
            distortions: manifest.preflight?.distortions ?? [],
        },
        witnesses: [...witnesses.values()],
    };
}

const sd = (xs: number[]) => {
    if (xs.length < 2) return undefined;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return v > 0 ? Math.sqrt(v) : undefined;
};

export type CusumScale = NonNullable<TierInput["cusum_sd"]>;

const controlArms = (runs: GradedRun[]) => [
    ...new Set(runs.flatMap((g) => g.run.arms.map((a) => a.arm)).filter((a) => a.includes("~"))),
];

export function aaScale(prereg: Preregistration, runs: GradedRun[]): CusumScale | undefined {
    const controls = controlArms(runs).sort();
    if (controls.length === 0) return undefined;
    const diffs = (family: string) => {
        const metrics = prereg.families.find((f) => f.id === family)?.metrics ?? [];
        const best = new Map<string, number>();
        for (const control of controls) {
            const aa = tierInput(prereg, runs, control, armBase(control));
            const asym = new Set(aa.asymmetric);
            for (const o of aa.observations.filter((x) => metrics.includes(x.metric))) {
                for (const x of (o.items ?? []).filter((x) => !asym.has(x.item))) {
                    const key = `${control}/${x.item}`;
                    const d = x.treatment - x.control;
                    best.set(key, Math.max(best.get(key) ?? Number.NEGATIVE_INFINITY, d));
                }
            }
        }
        return [...best.values()];
    };
    return { harm: sd(diffs("harm")), futility: sd(diffs("probe-P1")) };
}

function falsificationPairsOf(prereg: Preregistration, g: GradedRun): [string, string][] {
    const controls = controlArms([g]).sort();
    return controls.length ? controls.map((c) => [armBase(c), c]) : [["host", prereg.arms.default]];
}

export function tierReport(
    prereg: Preregistration,
    runs: GradedRun[],
    claimBoundary: string,
    scale: CusumScale | undefined = aaScale(prereg, runs),
    catalog = "",
): TierReport {
    const arms = [...new Set(runs.flatMap((g) => g.run.arms.map((a) => a.arm)))];
    const input = tierInput(prereg, runs);
    input.cusum_sd = scale;
    const falsify: Record<string, { control: number; treatment: number }[]> = {};
    const pairs = new Map<string, [string, string]>();
    for (const g of runs) {
        for (const pair of falsificationPairsOf(prereg, g)) {
            pairs.set(pair.join("/"), pair);
            for (const [k, v] of Object.entries(falsificationPairs(g, ...pair)))
                falsify[k] = [...(falsify[k] ?? []), ...v];
        }
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
        falsification_pairs: [...pairs.values()],
        observed,
        runs: runs.map((g) => g.run.dir),
        arms,
        grades: runs.flatMap((g) => g.grades),
        verdict: evaluateTier(prereg, input),
        oracles: oracleReport(runs.map((g) => g.run))[prereg.tier] ?? {},
        recoveries: runs
            .filter((g) => !excludedFromFaultMetrics(g.witnesses))
            .flatMap((g) => recoveries(g.run).map((r) => ({ ...r, run: g.run.dir }))),
        distortions: runs.map((g) => ({ run: g.run.dir, distortions: g.identity.distortions })),
        missed_faults: runs.flatMap((g) => {
            const faults = g.witnesses
                .filter((w) => w.status === "untriggered")
                .map((w) => w.fault);
            return faults.length ? [{ run: g.run.dir, faults }] : [];
        }),
        soak: perArm
            .filter(({ arm }) => armBase(arm.arm) !== "host")
            .flatMap(({ g, arm }) =>
                (["rss", "heap", "store_bytes"] as const).map((r) => ({
                    ...soak(g.run, arm, r),
                    run: g.run.dir,
                })),
            ),
        intrusiveness: perArm.map(({ g, arm }) => ({
            ...intrusiveness(g.run, arm),
            run: g.run.dir,
        })),
        cost: perArm.map(({ g, arm }) => ({ ...costPanel(g.run, arm, g.grades), run: g.run.dir })),
        judge: runs.map((g) => ({ run: g.run.dir, cost: judgeCost(g.run) })),
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
    };
}
