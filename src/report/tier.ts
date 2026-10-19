import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GradeLog, type GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import { loadRun } from "../oracle/logs";
import { oracleReport, runOracles } from "../oracle/oracles";
import { recoveries } from "../oracle/recovery";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { excludedFromFaultMetrics, type WitnessReport } from "../proxy/inject";
import { readJsonl } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import { evaluateTier, falsificationSet, type TierInput } from "../stats/gate";
import { clopperPearson } from "../stats/tests";
import { readPairing } from "../usersim/usersim";
import { type Continuity, continuity, recallDrift, runConditions } from "./conditions";
import { costPanel, judgeCost } from "./cost";
import { falsificationPairs } from "./falsify";
import { intrusiveness } from "./intrusive";
import {
    controlArmsOf,
    type GradedRun,
    judgmentKey,
    ordered,
    type RunIdentity,
    tierInput,
} from "./observe";
import type { TierReport } from "./render";
import { soak, soakByMonth } from "./soak";
import { propertyWitness } from "./witness";

export function loadGraded(dir: string, prereg: Preregistration): GradedRun {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        host: string;
        prereg_sha256: string;
        scenario_hash: string;
        fault_override: Scenario["faults"] | null;
        preflight?: {
            distortions?: string[];
            hosts?: { host: string; version: string }[];
            toolchain?: unknown[];
        };
        tapes?: string[];
        order: string[];
    } & Omit<
        RunIdentity,
        | "distortions"
        | "host_versions"
        | "scenario_provenance"
        | "fault_override"
        | "tapes"
        | "toolchain"
    >;
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
    const lines = readJsonl<WitnessReport[]>(faults);
    const reports = lines.length ? lines : null;
    for (const w of (reports ?? []).flat()) {
        const key = `${w.arm}/${w.fault}`;
        if (witnesses.get(key)?.status !== "fired") witnesses.set(key, w);
    }
    const counterpart = (r: GradeRecord, arm: string) =>
        [...judged.values()].some(
            (o) => o.item === r.item && o.arm === arm && judgmentKey(o) === judgmentKey(r),
        );
    const pairingPath = join(dir, "pairing.jsonl");
    const pairing = existsSync(pairingPath) ? readPairing(pairingPath, manifest.order) : null;
    const sm = scenario.manifest as {
        generator_version?: string;
        random_schema_version?: number;
        corpus_manifest_sha256?: string;
        embedding_model?: string;
    };
    const hostP7 = (r: GradeRecord) => r.probe_type === "P7" && armBase(r.arm) === "host";
    const hostRows = new Map<string, GradeRecord>();
    for (const r of [...judged.values()].filter(
        (r) => hostP7(r) && counterpart(r, prereg.arms.default),
    )) {
        if ((hostRows.get(r.item)?.version ?? 0) < r.version) hostRows.set(r.item, r);
    }
    const grades = [...log.latest().filter((r) => !hostP7(r)), ...hostRows.values()];
    const run = loadRun(dir, prereg);
    return {
        run,
        scenario: { ...scenario, faults: manifest.fault_override ?? scenario.faults },
        grades,
        judged: [...judged.values()],
        host: manifest.host,
        identity: {
            eidnara_commit,
            models,
            context_limit,
            events,
            distortions: manifest.preflight?.distortions ?? [],
            host_versions: (manifest.preflight?.hosts ?? []).map((h) => `${h.host}@${h.version}`),
            scenario_provenance: `${sm.generator_version}/${sm.random_schema_version}/${sm.corpus_manifest_sha256}/${sm.embedding_model}`,
            fault_override:
                manifest.fault_override == null
                    ? null
                    : sha256Hex(canonicalJson(manifest.fault_override)),
            tapes: (manifest.tapes ?? []).map((t) =>
                existsSync(t) ? sha256Hex(readFileSync(t, "utf8")) : `missing:${t}`,
            ),
            toolchain: (manifest.preflight?.toolchain ?? []).map((t) => canonicalJson(t)),
        },
        witnesses: reports === null ? null : [...witnesses.values()],
        pairing,
        captured: existsSync(join(dir, "calls.jsonl")),
        tape: existsSync(join(dir, "tape.jsonl")),
        tooled: new Set(
            run.arms.filter((a) => existsSync(join(dir, a.arm, "tools.jsonl"))).map((a) => a.arm),
        ),
    };
}

const sd = (xs: number[]) => {
    if (xs.length < 2) return undefined;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
    return v > 0 ? Math.sqrt(v) : undefined;
};

export type CusumScale = NonNullable<TierInput["cusum_sd"]>;

const controlArms = (runs: GradedRun[]) => [...new Set(runs.flatMap(controlArmsOf))];

/** The scale each CUSUM rule's `sd_source` names, lent by a tier only when its campaign is complete. */
export function cusumScale(
    prereg: Preregistration,
    scales: ReadonlyMap<string, { scale: CusumScale | undefined; complete: boolean }>,
): CusumScale {
    const scale: CusumScale = {};
    for (const rule of prereg.stopping_rule.cusum) {
        const named = /^the (\w+) tier's/.exec(rule.sd_source)?.[1] ?? prereg.tier;
        const source = scales.get(named);
        if (source?.complete) scale[rule.kind] = source.scale?.[rule.kind];
    }
    return scale;
}

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
    given: GradedRun[],
    claimBoundary: string,
    o: {
        /** The property catalog the witness panel reads. */
        catalog?: string;
        /** An earlier tier's continuity panel that the recall-drift panel compares against. */
        reference?: { source: string; continuity: Continuity[] };
        /** The CUSUM scale; the runs' own A/A scale when absent. */
        scale?: CusumScale;
    } = {},
): TierReport {
    const runs = ordered(prereg, given);
    const arms = [...new Set(runs.flatMap((g) => g.run.arms.map((a) => a.arm)))];
    const input = tierInput(prereg, runs);
    input.cusum_sd = o.scale ?? aaScale(prereg, given);
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
        oracles:
            oracleReport(runs.map((g) => ({ tier: g.run.tier, activations: runOracles(g.run) })))[
                prereg.tier
            ] ?? {},
        recoveries: runs
            .filter((g) => !excludedFromFaultMetrics(g.witnesses ?? []))
            .flatMap((g) => recoveries(g.run).map((r) => ({ ...r, run: g.run.dir }))),
        distortions: runs.map((g) => ({ run: g.run.dir, distortions: g.identity.distortions })),
        missed_faults: runs.flatMap((g) => {
            const faults = [
                ...new Set(
                    (g.witnesses ?? [])
                        .filter((w) => w.status === "untriggered")
                        .map((w) => w.fault),
                ),
            ];
            return faults.length ? [{ run: g.run.dir, faults }] : [];
        }),
        soak: perArm
            .filter(({ arm }) => armBase(arm.arm) !== "host")
            .flatMap(({ g, arm }) =>
                (["rss", "heap", "store_bytes"] as const).flatMap((r) => {
                    const verdict = soak(g.run, arm, r);
                    return verdict ? [{ ...verdict, run: g.run.dir }] : [];
                }),
            ),
        intrusiveness: perArm.map(({ g, arm }) => ({
            ...intrusiveness(g.run, arm),
            run: g.run.dir,
        })),
        cost: perArm.flatMap(({ g, arm }) => {
            const panel = costPanel(g.run, arm, g.grades);
            return panel ? [{ ...panel, run: g.run.dir }] : [];
        }),
        judge: runs.map((g) => ({ run: g.run.dir, cost: judgeCost(g.run) })),
        falsification: falsificationSet(prereg, falsify),
        aa: runs.flatMap((g) => {
            const path = join(g.run.dir, "aa.json");
            const grades = join(g.run.dir, "grades.jsonl");
            if (!existsSync(path)) return [];
            const stale = existsSync(grades) && statSync(grades).mtimeMs > statSync(path).mtimeMs;
            const reports = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
            return reports.map((r) => ({ run: g.run.dir, stale, ...r }));
        }),
        prereg,
        claim_boundary: claimBoundary,
        witness: propertyWitness(o.catalog ?? "", runs),
        conditions: runs.map(runConditions),
        continuity: continuity(runs),
        drift: o.reference ? recallDrift(continuity(runs), o.reference.continuity) : null,
        drift_source: o.reference?.source ?? null,
        soak_by_month: perArm
            .filter(({ arm }) => prereg.tier === "XL" && armBase(arm.arm) !== "host")
            .flatMap(({ g, arm }) => soakByMonth(g.run, arm, "rss")),
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
