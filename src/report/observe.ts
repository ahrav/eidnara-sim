import type { GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import type { Preregistration } from "../prereg/schema";
import type { WitnessReport } from "../proxy/inject";
import { referenceArm } from "../run/run";
import type { Scenario } from "../scenario/compile";
import type { ItemPair, Observation, RunPair, TierInput } from "../stats/gate";
import { pairByItem } from "../stats/gate";
import { type PairingRecord, pairingFailures } from "../usersim/usersim";
import { costPanel } from "./cost";
import { intrusiveness, notesOf, percentile, turnLatencies } from "./intrusive";
import { soak } from "./soak";

export interface GradedRun {
    run: RunLogs;
    scenario: Scenario;
    grades: GradeRecord[];
    /** `judged` supplies P7 pairs from the same judgment, identified by matching `item` and `inputs`. */
    judged: GradeRecord[];
    host: string;
    identity: RunIdentity;
    /** The proxy's fault witnesses from `faults.jsonl`; an `untriggered` one keeps the run out of the fault metrics (SIM-P32), and `null` records that the file is absent. */
    witnesses: WitnessReport[] | null;
    /** The user-sim's `pairing.jsonl` records; `null` records that the file is absent. */
    pairing: PairingRecord[] | null;
    /** Whether `calls.jsonl` is present, the capture the F7 scan reads. */
    captured: boolean;
    /** Whether `tape.jsonl` is present, which the corrections scan reads replies from. */
    tape: boolean;
    /** The arms with a `tools.jsonl`, the capture the revert scan reads. */
    tooled: Set<string>;
}

/** The manifest fields a tier's runs share for their evidence to pool. */
export interface RunIdentity {
    eidnara_commit: string;
    models: string[];
    context_limit: number;
    events: number;
    /** `manifest.preflight.distortions`: the clock limits the claim boundary says the report names. */
    distortions: string[];
    /** `manifest.preflight.hosts` as `<host>@<version>`. */
    host_versions: string[];
    /** `scenario.manifest`'s `generator_version/random_schema_version/corpus_manifest_sha256`. */
    scenario_provenance: string;
    /** The digest of `manifest.fault_override`, or `null` for the scenario's own schedule. */
    fault_override: string | null;
    /** `manifest.tapes`, each as the digest of its file or `missing:<path>`. */
    tapes: string[];
}

const ALIASES: Record<string, string> = {
    "P8.cross_session_pass_rate": "P8.pass",
    "P9.cross_session_pass_rate": "P9.pass",
};

/**
 * The two records of one P7 judgment share the snapshots read and the judge's verdicts in both
 * orders; a re-grade interrupted between its two appends leaves records with different keys.
 */
export const judgmentKey = (r: GradeRecord) =>
    [
        r.inputs.join("\n"),
        r.metrics.verdict_a_then_b,
        r.metrics.verdict_b_then_a,
        r.metrics.length_a,
        r.metrics.length_b,
        r.metrics.judge_prompt_digest,
    ].join("|");

const probeIds = (g: GradedRun) => new Set(g.scenario.probes.map((p) => p.id));
const probeTypes = (g: GradedRun) => new Map(g.scenario.probes.map((p) => [p.id, p.type]));

/** Whether `metric`, a `<type>.<name>` grade metric, belongs to a probe of `type`. */
const ofType = (metric: string, type: string | undefined) => metric.split(".")[0] === type;

/** The registered domain of a numeric grade metric. */
const inDomain = (metric: string, v: number) =>
    metric === "P13.fold_fidelity_score"
        ? v >= 0 && v <= 1
        : metric === "P14.post_compaction_correction_count"
          ? Number.isInteger(v) && v >= 0
          : Number.isFinite(v);

/** The arm's `~` controls that reached `EndArm`. */
export const controlArmsOf = (g: GradedRun) =>
    g.run.arms
        .filter((a) => a.arm.includes("~") && a.journal.some((e) => e.kind === "EndArm"))
        .map((a) => a.arm);

/** Whether every turn that ended `ok` has a call record, the capture the F7 scan reads. */
function callsCoverTurns(arm: ArmLogs): boolean {
    const called = new Set(
        arm.calls
            .filter((c) => c.component === "agent" && typeof c.response_text === "string")
            .map((c) => c.turn),
    );
    return arm.journal
        .filter((e) => e.kind === "EndTurn" && e.outcome === "ok")
        .every((e) => called.has(String(e.event)));
}

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
                .filter(
                    (r) =>
                        r.arm === a &&
                        r.verdict !== "excluded" &&
                        ofType(metric, probeTypes(g).get(r.item)),
                )
                .flatMap((r) => {
                    const v = r.metrics[metric];
                    return typeof v === "number" &&
                        inDomain(metric, v) &&
                        !dropped.has(`${runKey(g)}/${r.item}`)
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
    (_, arm) => {
        const latencies = turnLatencies(arm);
        return latencies === null ? null : percentile(latencies, q);
    };
const slope =
    (resource: "rss" | "heap" | "store_bytes"): RunValue =>
    ({ run }, arm) =>
        soak(run, arm, resource)?.slope_per_session ?? null;
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
            new Set(
                arm.journal
                    .filter(
                        (e) =>
                            (e.kind === "EndTurn" && e.outcome !== "ok") ||
                            (e.kind === "Event" && e.outcome === "failed(interrupted)"),
                    )
                    .map((e) => String(e.event)),
            ).size,
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
        value: (g, arm) =>
            g.captured && callsCoverTurns(arm)
                ? (panelOf(g, arm).internal_string_hits?.length ?? null)
                : null,
        delta: false,
    },
    user_corrections_referencing_injected_text: {
        value: (g, arm) =>
            (armBase(arm.arm) !== "host" && notesOf(g.run.dir, arm.arm) === undefined) ||
            (!g.tape &&
                (g.pairing ?? []).some((r) => r.kind === "turn" && r.arm === arm.arm && r.tape_key))
                ? null
                : (panelOf(g, arm).corrections_referencing_injected_text?.length ?? null),
        delta: false,
    },
    reverted_memory_edits: {
        value: (g, arm) => (g.tooled.has(arm.arm) ? panelOf(g, arm).reverted_edits.length : null),
        delta: true,
    },
    usd_per_component: {
        value: ({ run, grades }, arm) => costPanel(run, arm, grades)?.usd ?? null,
        delta: false,
    },
    usd_per_useful_retrieval: {
        value: ({ run, grades }, arm) => costPanel(run, arm, grades)?.usd_per_pass ?? null,
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
    const p7 = source.startsWith("P7.");
    return runs.flatMap((g) => {
        const seed = String(g.scenario.manifest.seed);
        const key = runKey(g);
        const types = probeTypes(g);
        const records = (arm: string) =>
            (p7 ? g.judged : g.grades).filter(
                (r) =>
                    r.arm === arm &&
                    ofType(source, types.get(r.item)) &&
                    r.verdict !== "excluded" &&
                    typeof r.metrics[source] === "boolean" &&
                    (!p7 || r.metrics.gate_eligible === true),
            );
        const value = (r: GradeRecord) => Number(r.metrics[source] === true);
        const theirs = records(treatment);
        const paired = (a: GradeRecord, b: GradeRecord) =>
            a.item === b.item && judgmentKey(a) === judgmentKey(b);
        const matched = p7
            ? theirs
                  .filter((t) => records(control).some((c) => paired(c, t)))
                  .sort((x, y) => x.version - y.version)
            : theirs;
        const mine = records(control).filter((c) => !p7 || matched.some((t) => paired(c, t)));
        const byItem = (rs: GradeRecord[]) => new Map(rs.map((r) => [r.item, value(r)] as const));
        const fact = new Map(g.scenario.probes.map((p) => [p.id, p.fact ?? p.id]));
        const issue = new Map(
            g.scenario.probes.map((p) => [p.id, Number((p.event ?? p.id).replace(/\D/g, ""))]),
        );
        return pairByItem(
            byItem(mine),
            byItem(matched),
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
        const open = [...new Set([...p.arms.run, control, treatment])].filter(
            (a) => !g.run.arms.find((x) => x.arm === a)?.journal.some((e) => e.kind === "EndArm"),
        );
        return open.length ? [`run ${runKey(g)}: ${open.join(", ")} without EndArm`] : [];
    });
    const unavailable = p.families
        .filter((f) => f.claim === "gate" && f.analysis_unit === "run")
        .flatMap((f) =>
            f.metrics.flatMap((metric) => {
                const seen = new Set(
                    (observations.find((o) => o.metric === metric)?.runs ?? []).map((r) => r.run),
                );
                return runs.flatMap((g) =>
                    seen.has(runId(g)) ? [] : [`${metric}: run ${runId(g)} unavailable`],
                );
            }),
        );
    const binary = new Set(
        p.families
            .filter((f) => f.analysis_unit === "item")
            .flatMap((f) => f.metrics.map((m) => ALIASES[m] ?? m)),
    );
    const numeric = new Set(
        p.families
            .filter((f) => f.analysis_unit === "run")
            .flatMap((f) => f.metrics.filter((m) => /^P\d+\./.test(m))),
    );
    const unknown = runs.flatMap((g) => {
        const known = probeIds(g);
        const items = [...new Set(g.grades.filter((r) => !known.has(r.item)).map((r) => r.item))];
        const types = probeTypes(g);
        const malformed = [...g.grades, ...g.judged].flatMap((r) =>
            Object.entries(r.metrics).flatMap(([k, v]) => {
                if (!(binary.has(k) || numeric.has(k))) return [];
                const type = types.get(r.item);
                if (type && !ofType(k, type))
                    return [
                        `run ${runKey(g)}: ${k} recorded for ${r.arm} ${r.item}, a ${type} probe`,
                    ];
                if (binary.has(k) && typeof v !== "boolean")
                    return [`run ${runKey(g)}: ${k} is not a boolean for ${r.arm} ${r.item}`];
                if (numeric.has(k) && (typeof v !== "number" || !inDomain(k, v)))
                    return [`run ${runKey(g)}: ${k} out of range for ${r.arm} ${r.item}`];
                return [];
            }),
        );
        return [
            ...(items.length
                ? [`run ${runKey(g)}: grades for unknown items ${items.join(", ")}`]
                : []),
            ...malformed,
        ];
    });
    const pairing = runs.flatMap((g) => {
        if (g.pairing === null) return [`run ${runKey(g)}: pairing records missing`];
        const order = g.run.arms.map((a) => a.arm);
        const scripted = g.scenario.events
            .filter((e) => (e as { kind?: string }).kind === "user_turn")
            .map((e) => String(e.id));
        const recorded = new Set(
            g.pairing.flatMap((r) => (r.kind === "turn" ? [`${r.arm}/${r.event}`] : [])),
        );
        const gaps = [control, treatment].flatMap((a) => {
            const missing = scripted.filter((id) => !recorded.has(`${a}/${id}`));
            return missing.length ? [`${a}: ${missing.join(" ")}`] : [];
        });
        const uncovered = gaps.length
            ? [`run ${runKey(g)}: pairing records missing for ${gaps.join("; ")}`]
            : [];
        const failures = pairingFailures(g.pairing, g.scenario, referenceArm(order));
        const out = Object.entries(failures).flatMap(([kind, list]) =>
            list.length
                ? [`run ${runKey(g)}: ${kind.replaceAll("_", " ")}: ${list.join(", ")}`]
                : [],
        );
        const outside = g.run.arms.flatMap((a) =>
            a.journal
                .filter((e) => e.kind === "UserSimRates" && ((e.outside as string[]) ?? []).length)
                .map(
                    (e) =>
                        `run ${runKey(g)}: ${a.arm} user-sim rates outside band: ${(e.outside as string[]).join(", ")}`,
                ),
        );
        return [...uncovered, ...out, ...outside];
    });
    const sequential = p.load_stress?.arms_concurrent
        ? runs.flatMap((g) => {
              const spans = g.run.arms.flatMap((a) => {
                  const start = a.journal.find((e) => e.kind === "StartArm")?.seq;
                  const end = a.journal.find((e) => e.kind === "EndArm")?.seq;
                  return start === undefined || end === undefined ? [] : [[start, end] as const];
              });
              const overlap = spans.some(([s1, e1], i) =>
                  spans.some(([s2, e2], j) => i !== j && s1 <= e2 && s2 <= e1),
              );
              return spans.length < 2 || overlap
                  ? []
                  : [
                        `run ${runKey(g)}: arms ran one at a time; load_stress requires concurrent arms`,
                    ];
          })
        : [];
    const overridden = runs.flatMap((g) =>
        g.identity.fault_override === null ? [] : [`run ${runKey(g)}: fault schedule overridden`],
    );
    const unwitnessed = runs.flatMap((g) =>
        g.witnesses === null && g.scenario.faults.some((f) => f.seam.layer === "proxy-sink")
            ? [`run ${runKey(g)}: fault witnesses missing`]
            : [],
    );
    const truncated = runs.flatMap((g) =>
        g.identity.events < g.scenario.events.length
            ? [`run ${runKey(g)}: ${g.identity.events} of ${g.scenario.events.length} events`]
            : [],
    );
    const controls = (p.aa_controls?.pairs ?? []).flatMap(([a]) => {
        const have = runs.reduce(
            (s, g) =>
                s +
                g.run.arms.filter(
                    (x) =>
                        x.arm.includes("~") &&
                        armBase(x.arm) === a &&
                        x.journal.some((e) => e.kind === "EndArm"),
                ).length,
            0,
        );
        const want = p.aa_controls?.repeats ?? 0;
        return have === want ? [] : [`A/A ${a}: ${have} of ${want} control runs`];
    });
    const coverage = runs.flatMap((g) => {
        const byType = new Map<string, string[]>();
        for (const pr of g.scenario.probes) {
            if (/^P([1-9]|1[0-2])$/.test(pr.type) && pr.type !== "P7")
                byType.set(pr.type, [...(byType.get(pr.type) ?? []), pr.id]);
        }
        return controlArmsOf(g).flatMap((c) => {
            const graded = (arm: string, type: string) =>
                new Set(
                    g.grades
                        .filter(
                            (r) =>
                                r.arm === arm &&
                                r.verdict !== "excluded" &&
                                typeof r.metrics[`${type}.pass`] === "boolean",
                        )
                        .map((r) => r.item),
                );
            return [...byType].flatMap(([type, ids]) => {
                const [mine, theirs] = [graded(c, type), graded(armBase(c), type)];
                const both = ids.filter((id) => mine.has(id) && theirs.has(id)).length;
                return both === ids.length
                    ? []
                    : [
                          `run ${runKey(g)}: control ${c} covers ${both} of ${ids.length} ${type} probes`,
                      ];
            });
        });
    });
    const shared: (keyof RunIdentity)[] = [
        "eidnara_commit",
        "models",
        "context_limit",
        "distortions",
        "host_versions",
        "scenario_provenance",
        "tapes",
    ];
    const settings = shared.flatMap((field) => {
        const values = [...new Set(runs.map((g) => JSON.stringify(g.identity[field])))];
        return values.length > 1
            ? [`runs differ in ${field}: ${values.map((v) => JSON.parse(v)).join(", ")}`]
            : [];
    });
    const n = p.stopping_rule.paired_items_per_probe_type;
    const short = p.families.flatMap((f) => {
        const probeType = /^probe-P\d+$/.test(f.id);
        if (!probeType && f.analysis_unit !== "item") return [];
        const metrics = probeType ? [f.metrics[0] as string] : f.metrics;
        return metrics.flatMap((metric) => {
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
            const label = probeType ? f.id : `${f.id}/${metric}`;
            return pairs < n ? [`${label}: ${pairs} of ${n} paired items`] : [];
        });
    });
    return [
        ...missing,
        ...unfinished,
        ...truncated,
        ...unwitnessed,
        ...overridden,
        ...unknown,
        ...pairing,
        ...sequential,
        ...settings,
        ...controls,
        ...coverage,
        ...unavailable,
        ...short,
    ];
}

export function ordered(p: Preregistration, runs: GradedRun[]): GradedRun[] {
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
        if (!p.hosts.includes(g.host) || !p.seeds.includes(g.scenario.manifest.seed)) {
            throw new Error(`${g.run.dir}: run ${key} is not pre-registered for ${p.tier}`);
        }
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
    const pairArms = [control, treatment];
    const excluded = runs.flatMap((g) => {
        const judgedPair = (r: GradeRecord) =>
            g.judged.some(
                (o) =>
                    o.item === r.item &&
                    o.arm !== r.arm &&
                    pairArms.includes(o.arm) &&
                    judgmentKey(o) === judgmentKey(r),
            );
        return [...g.grades.filter((r) => r.probe_type !== "P7"), ...g.judged.filter(judgedPair)]
            .filter((r) => r.verdict === "excluded" && pairArms.includes(r.arm))
            .map((r) => ({
                id: `${runKey(g)}/${r.item}`,
                arm: r.arm,
                reason: r.reason ?? "excluded",
            }));
    });
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
