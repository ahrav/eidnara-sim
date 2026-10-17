import type { GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import type { ItemPair, Observation, RunPair, TierInput } from "../stats/gate";
import { pairByItem } from "../stats/gate";
import { costPanel } from "./cost";
import { intrusiveness, percentile, turnLatencies } from "./intrusive";
import { soak } from "./soak";

export interface GradedRun {
    run: RunLogs;
    scenario: Scenario;
    grades: GradeRecord[];
    host: string;
}

const ALIASES: Record<string, string> = {
    "P8.cross_session_pass_rate": "P8.pass",
    "P9.cross_session_pass_rate": "P9.pass",
};

/** The prefix that keeps one seed's items apart across the tier's hosts: `<host>/<seed>`. */
const runKey = (g: GradedRun) => `${g.host}/${g.scenario.manifest.seed}`;
const runId = (g: GradedRun) => `${g.run.tier}-${g.host}-${g.scenario.manifest.seed}`;

interface Pairing {
    other: ArmLogs;
    dropped: ReadonlySet<string>;
}
type RunValue = (g: GradedRun, arm: ArmLogs, pairing: Pairing) => number | null;

const panels = new WeakMap<ArmLogs, ReturnType<typeof intrusiveness>>();
const panelOf = (g: GradedRun, arm: ArmLogs) => {
    const cached = panels.get(arm) ?? intrusiveness(g.run, arm);
    panels.set(arm, cached);
    return cached;
};

function values(
    g: GradedRun,
    arm: string,
    metric: string,
    { other, dropped }: Pairing,
): Map<string, number> {
    const of = (a: string) =>
        new Map(
            g.grades
                .filter((r) => r.arm === a && r.verdict !== "excluded")
                .flatMap((r) => {
                    const v = r.metrics[metric];
                    return typeof v === "number" && !dropped.has(`${runKey(g)}/${r.item}`)
                        ? [[r.item, v] as const]
                        : [];
                }),
        );
    const theirs = of(other.arm);
    return new Map([...of(arm)].filter(([item]) => theirs.has(item)));
}
const total = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const latency =
    (q: number): RunValue =>
    (_, arm) =>
        percentile(turnLatencies(arm), q);
const slope =
    (resource: "rss" | "heap" | "store_bytes"): RunValue =>
    ({ run }, arm) =>
        soak(run, arm, resource).slope_per_session;
const graded =
    (metric: string, reduce: (xs: number[]) => number): RunValue =>
    (g, arm, pairing) => {
        const v = [...values(g, arm.arm, metric, pairing).values()];
        return v.length === 0 ? null : reduce(v);
    };

/**
 * `delta` metrics observe treatment minus control; `hostless` ones measure the daemon, so a
 * `host` control that runs none counts as zero.
 */
const RUN_VALUES: Record<string, { value: RunValue; delta: boolean; hostless?: true }> = {
    failed_turns: {
        value: (_, arm) =>
            arm.journal.filter(
                (e) =>
                    (e.kind === "EndTurn" && e.outcome !== "ok") ||
                    (e.kind === "Event" && e.outcome === "failed(interrupted)"),
            ).length,
        delta: false,
    },
    hangs: {
        value: ({ run }, arm) =>
            runOracles({ ...run, arms: [arm] }).filter((a) => a.oracle === "F4").length,
        delta: false,
    },
    turn_latency_p50_delta_ms: { value: latency(0.5), delta: true },
    turn_latency_p95_delta_ms: { value: latency(0.95), delta: true },
    daemon_rss_growth_bytes_per_session: { value: slope("rss"), delta: true, hostless: true },
    daemon_heap_growth_bytes_per_session: { value: slope("heap"), delta: true, hostless: true },
    store_growth_bytes_per_session: { value: slope("store_bytes"), delta: true, hostless: true },
    internal_string_hits: {
        value: (g, arm) => panelOf(g, arm).internal_string_hits.length,
        delta: false,
    },
    user_corrections_referencing_injected_text: {
        value: (g, arm) => panelOf(g, arm).corrections_referencing_injected_text?.length ?? null,
        delta: false,
    },
    reverted_memory_edits: {
        value: (g, arm) => panelOf(g, arm).reverted_edits.length,
        delta: true,
    },
    usd_per_component: {
        value: ({ run, grades }, arm) => costPanel(run, arm, grades).usd,
        delta: false,
    },
    usd_per_useful_retrieval: {
        value: ({ run, grades }, arm) => costPanel(run, arm, grades).usd_per_pass,
        delta: false,
    },
    "P13.fold_fidelity_score": {
        value: graded("P13.fold_fidelity_score", (v) => (100 * total(v)) / v.length),
        delta: false,
    },
    "P14.post_compaction_correction_count": {
        value: graded("P14.post_compaction_correction_count", total),
        delta: false,
    },
};

function itemPairs(
    runs: GradedRun[],
    metric: string,
    control: string,
    treatment: string,
): ItemPair[] {
    const source = ALIASES[metric] ?? metric;
    return runs.flatMap((g) => {
        const seed = String(g.scenario.manifest.seed);
        const key = runKey(g);
        const of = (arm: string) =>
            new Map(
                g.grades
                    .filter((r) => r.arm === arm && r.verdict !== "excluded" && source in r.metrics)
                    .map((r) => [r.item, Number(r.metrics[source] === true)] as const),
            );
        const fact = new Map(g.scenario.probes.map((p) => [p.id, p.fact ?? p.id]));
        const issue = new Map(
            g.scenario.probes.map((p) => [p.id, Number((p.event ?? p.id).replace(/\D/g, ""))]),
        );
        return pairByItem(
            of(control),
            of(treatment),
            (item) => `${seed}/${fact.get(item) ?? item}`,
            (item) => issue.get(item) ?? 0,
        ).map((x) => ({ ...x, item: `${key}/${x.item}` }));
    });
}

function runPairs(
    runs: GradedRun[],
    metric: string,
    control: string,
    treatment: string,
    dropped: ReadonlySet<string>,
): RunPair[] {
    const def = RUN_VALUES[metric];
    if (!def) return [];
    return runs.flatMap((g) => {
        const [c, t] = [control, treatment].map((a) => g.run.arms.find((x) => x.arm === a));
        if (!c || !t) return [];
        const [raw, tv] = [
            def.value(g, c, { other: t, dropped }),
            def.value(g, t, { other: c, dropped }),
        ];
        const cv = raw === null && def.hostless && armBase(c.arm) === "host" ? 0 : raw;
        if (tv === null || cv === null) return [];
        const run = runId(g);
        return [
            def.delta
                ? { run, control: 0, treatment: tv - cv }
                : { run, control: cv, treatment: tv },
        ];
    });
}

/**
 * The faults that landed in an arm: those the scheduler observed, and those the proxy
 * recorded on the arm's calls as `fault_ref`.
 */
function asymmetric(runs: GradedRun[], control: string, treatment: string): string[] {
    return runs.flatMap((g) => {
        const fired = (name: string) => {
            const arm = g.run.arms.find((a) => a.arm === name);
            const observed = (arm?.journal ?? [])
                .filter(
                    (e) =>
                        e.kind === "FaultObserved" &&
                        (e.evidence as { skipped?: unknown } | undefined)?.skipped === undefined,
                )
                .map((e) => String(e.fault));
            const injected = (arm?.calls ?? []).flatMap((c) =>
                c.fault_ref === null ? [] : [c.fault_ref],
            );
            return new Set([...observed, ...injected]);
        };
        const [c, t] = [fired(control), fired(treatment)];
        const lonely = g.scenario.faults.filter((f) => c.has(f.id) !== t.has(f.id));
        const sessions = new Set(lonely.map((f) => f.trigger.session));
        return g.scenario.probes
            .filter((p) => sessions.has(p.session))
            .map((p) => `${runKey(g)}/${p.id}`);
    });
}

function incomplete(
    p: Preregistration,
    runs: GradedRun[],
    observations: Observation[],
    control: string,
    treatment: string,
    dropped: ReadonlySet<string>,
): string[] {
    const present = new Set(runs.map(runKey));
    const missing = p.hosts.flatMap((host) =>
        p.seeds.flatMap((seed) =>
            present.has(`${host}/${seed}`) ? [] : [`missing run ${host}/${seed}`],
        ),
    );
    const unfinished = runs.flatMap((g) => {
        const open = [control, treatment].filter(
            (a) => !g.run.arms.find((x) => x.arm === a)?.journal.some((e) => e.kind === "EndArm"),
        );
        return open.length ? [`run ${runKey(g)}: ${open.join(", ")} without EndArm`] : [];
    });
    const n = p.stopping_rule.paired_items_per_probe_type;
    const short = p.families.flatMap((f) => {
        if (!/^probe-P\d+$/.test(f.id)) return [];
        const metric = f.metrics[0] as string;
        const pairs =
            f.analysis_unit === "item"
                ? (observations.find((o) => o.metric === metric)?.items ?? []).filter(
                      (x) => !dropped.has(x.item),
                  ).length
                : runs.reduce((s, g) => {
                      const [c, t] = [control, treatment].map((a) =>
                          g.run.arms.find((x) => x.arm === a),
                      );
                      return !c || !t
                          ? s
                          : s + values(g, t.arm, metric, { other: c, dropped }).size;
                  }, 0);
        return pairs < n ? [`${f.id}: ${pairs} of ${n} paired items`] : [];
    });
    return [...missing, ...unfinished, ...short];
}

function ordered(p: Preregistration, runs: GradedRun[]): GradedRun[] {
    const at = (xs: readonly unknown[], x: unknown) => {
        const i = xs.indexOf(x);
        return i < 0 ? xs.length : i;
    };
    const rank = (g: GradedRun) =>
        at(p.hosts, g.host) * (p.seeds.length + 1) + at(p.seeds, g.scenario.manifest.seed);
    return [...runs].sort((a, b) => rank(a) - rank(b));
}

export function tierInput(
    p: Preregistration,
    given: GradedRun[],
    treatment: string = p.arms.default,
    control = "host",
): TierInput {
    const runs = ordered(p, given);
    const seen = new Set<string>();
    for (const g of runs) {
        const key = runKey(g);
        if (seen.has(key)) throw new Error(`two runs for ${key}: ${g.run.dir} repeats one`);
        seen.add(key);
    }
    const asym = asymmetric(runs, control, treatment);
    const dropped = new Set(asym);
    const observations: Observation[] = p.families.flatMap((f) =>
        f.metrics.map(
            (metric): Observation =>
                f.analysis_unit === "item"
                    ? {
                          metric,
                          unit: "item",
                          cluster_key: f.cluster_key,
                          items: itemPairs(runs, metric, control, treatment),
                      }
                    : {
                          metric,
                          unit: "run",
                          cluster_key: f.cluster_key,
                          runs: runPairs(runs, metric, control, treatment, dropped),
                      },
        ),
    );
    const excluded = runs.flatMap((g) =>
        g.grades
            .filter((r) => r.verdict === "excluded" && [control, treatment].includes(r.arm))
            .map((r) => ({
                id: `${runKey(g)}/${r.item}`,
                arm: r.arm,
                reason: r.reason ?? "excluded",
            })),
    );
    return {
        observations,
        excluded,
        asymmetric: asym,
        incomplete: incomplete(p, runs, observations, control, treatment, dropped),
        journal_seq_at_eval: Object.fromEntries(
            runs.map((g) => [
                runId(g),
                Math.max(0, ...g.run.arms.flatMap((a) => a.journal.map((e) => e.seq))),
            ]),
        ),
    };
}
