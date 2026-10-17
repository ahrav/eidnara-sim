import {
    BOUND_DIRECTIONS,
    type Family,
    needsPairedRuns,
    type Preregistration,
} from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { betaQuantile, binomialCdf, normalQuantile, normalSf } from "./dist";
import {
    bootstrap,
    cusum,
    holm,
    mcnemarExact,
    negativeBinomial,
    newcombe,
    signTest,
} from "./tests";

export interface ItemPair {
    item: string;
    cluster: string;
    control: number;
    treatment: number;
    order: number;
}

export interface RunPair {
    run: string;
    control: number;
    treatment: number;
}

export interface Observation {
    metric: string;
    unit: "item" | "run";
    cluster_key: "ledger_fact_id" | "run";
    items?: ItemPair[];
    runs?: RunPair[];
}

export interface TierInput {
    observations: Observation[];
    excluded: { id: string; arm: string; reason: string }[];
    asymmetric: string[];
    /** The compared arms: `host` against the pre-registration's default arm. */
    arms: { control: string; treatment: string };
    cusum_sd?: Partial<Record<"harm" | "futility", number>>;
    /** The observations are the completed pairs at this journal sequence. */
    journal_seq_at_eval: number;
}

export class StatsRefusal extends Error {}

export interface MetricResult {
    metric: string;
    n: number;
    difference: number;
    interval: [number, number] | null;
    p: number | null;
    p_adjusted?: number;
    method: string;
    detectable: number | null;
    resolution_ratio: number | null;
    resolution_note?: string;
    rate_ratio_upper?: number | "unbounded";
    verdict: string;
    passed: boolean | null;
    asymmetric_pairs: number;
}

export interface FamilyResult {
    family: string;
    claim: "gate" | "descriptive";
    direction: string;
    alpha: number;
    mde: Family["mde"];
    margin: Family["margin"];
    metrics: MetricResult[];
    passed: boolean | null;
}

export interface CusumStop {
    kind: "harm" | "futility";
    metric: string;
    signal_index: number;
    window: string[];
}

export interface CusumRule {
    kind: "harm" | "futility";
    metric: string;
    sd_source: string;
    sd: number | null;
}

export interface TierVerdict {
    prereg_sha256: string;
    journal_seq_at_eval: number;
    arms: TierInput["arms"];
    families: FamilyResult[];
    memory_made_it_worse: { metric: string; interval: [number, number] | null }[];
    pass: {
        passed: boolean;
        components: string[];
        per_component_alpha: Record<string, number>;
        rule: string;
    };
    stops: CusumStop[];
    cusum_rules: CusumRule[];
    cusum_unavailable: string[];
    excluded_per_arm: Record<string, number>;
    excluded: TierInput["excluded"];
    asymmetric_stratum: string[];
}

type Stats = Omit<MetricResult, "metric" | "verdict" | "passed" | "asymmetric_pairs"> & {
    shift: number;
};

const num = (s: string) => Number(s);
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
const scaled = (x: number | null, f: Family) => {
    const unit = num(f.mde.value) === 0 ? f.margin.value : f.mde.value;
    return x === null || num(unit) === 0 ? null : x / num(unit);
};
const oneSided = (f: Family) => f.direction === "noninferiority" || f.direction === "at-most";
/**
 * The planning z for the detectable size: a Holm family with a one-sided claim is planned at its
 * first step, alpha over the metric count, one-sided; every other family at alpha over two.
 */
const zSum = (f: Family) => {
    const tail =
        f.multiplicity === "holm" && oneSided(f)
            ? num(f.alpha) / f.metrics.length
            : num(f.alpha) / 2;
    return normalQuantile(1 - tail) + normalQuantile(num(f.power));
};
const higherIsBetter = (metric: string) => /\.pass$|pass_rate$|fidelity_score$/.test(metric);
const empty = (method: string): Stats => ({
    n: 0,
    difference: 0,
    interval: null,
    p: null,
    method,
    detectable: null,
    resolution_ratio: null,
    shift: 0,
});
const finiteInterval = (interval: [number, number], p: Preregistration) => {
    if (!interval.every(Number.isFinite)) {
        throw new StatsRefusal(
            `the bootstrap interval is not finite at ${p.bootstrap.replicates} replicates`,
        );
    }
};

function binary(f: Family, items: ItemPair[], p: Preregistration): Stats {
    const n = items.length;
    const method =
        "exact McNemar; interval is the wider of Newcombe method 10 and the ledger-fact cluster bootstrap";
    if (n === 0) return empty(method);
    const count = (t: number, c: number) =>
        items.filter((x) => x.treatment === t && x.control === c).length;
    const [a, b, c, d] = [count(1, 1), count(1, 0), count(0, 1), count(0, 0)];
    const [nl, nh] = newcombe(a, b, c, d, num(f.alpha));
    const clusters = [...new Set(items.map((x) => x.cluster))].map((k) =>
        items.filter((x) => x.cluster === k).map((x) => x.treatment - x.control),
    );
    if (clusters.length < 2) {
        return {
            ...empty(method),
            n,
            difference: (100 * (b - c)) / n,
            resolution_note: `${n} items share one ledger-fact cluster, so the cluster bootstrap has no replication and the items are one observation`,
        };
    }
    const boot = bootstrap(clusters, (cs) => mean(cs.flat()), {
        ...p.bootstrap,
        alpha: num(f.alpha),
    });
    const interval: [number, number] = [100 * Math.min(nl, boot.lo), 100 * Math.max(nh, boot.hi)];
    finiteInterval(interval, p);
    const exact = mcnemarExact(b, c).p;
    const detectable = 100 * zSum(f) * Math.sqrt(Math.max(b + c, 1) / n / n);
    const sig = exact <= num(f.alpha) && (interval[0] > 0 || interval[1] < 0);
    return {
        n,
        difference: (100 * (b - c)) / n,
        interval,
        p: exact,
        method,
        detectable,
        resolution_ratio: scaled(detectable, f),
        shift: sig ? Math.sign(b - c) : 0,
    };
}

function glm(f: Family, runs: RunPair[]): Stats | null {
    const live = runs.filter((r) => r.control + r.treatment > 0);
    const totals = [0, 1].map((arm) =>
        live.reduce((s, r) => s + (arm === 0 ? r.control : r.treatment), 0),
    );
    if (live.length < 2 || totals.some((total) => total === 0)) return null;
    const x = live.flatMap((_, i) =>
        [0, 1].map((arm) => [1, arm, ...live.slice(1).map((__, j) => Number(j + 1 === i))]),
    );
    const fit = negativeBinomial(
        x,
        live.flatMap((r) => [r.control, r.treatment]),
    );
    const [b, se] = [fit.coefficients[1] as number, fit.se[1] as number];
    if (!fit.converged || !Number.isFinite(b) || !Number.isFinite(se)) return null;
    const z = normalQuantile(1 - num(f.alpha) / 2);
    const interval: [number, number] = [Math.exp(b - z * se), Math.exp(b + z * se)];
    const detectable = Math.exp(zSum(f) * se);
    return {
        n: runs.length,
        difference: Math.exp(b),
        interval,
        p: 2 * normalSf(Math.abs(b / se)),
        method: "negative-binomial GLM with run as unit, runs with no events in either arm left out; the difference is the rate ratio",
        detectable,
        resolution_ratio: scaled(detectable, f),
        shift: interval[0] > 1 ? 1 : interval[1] < 1 ? -1 : 0,
    };
}

function counts(f: Family, runs: RunPair[]): Stats {
    const n = runs.length;
    if (n === 0) return empty(f.interval_method);
    if (f.interval_method === "negative-binomial-glm" || n > 8) {
        const fitted = glm(f, runs);
        if (fitted) return fitted;
    }
    const diffs = runs.map((r) => r.treatment - r.control);
    const [up, down] = [diffs.filter((v) => v > 0).length, diffs.filter((v) => v < 0).length];
    const oneSided = f.direction === "at-most";
    const test = (k: number, m: number) => (oneSided ? binomialCdf(m - k, m, 0.5) : signTest(k, m));
    const p = test(up, up + down);
    const from = oneSided ? 0 : Math.ceil(n / 2);
    const least = Array.from({ length: n + 1 - from }, (_, k) => k + from).find(
        (k) => test(k, n) <= num(f.alpha),
    );
    const t = runs.reduce((s, r) => s + r.treatment, 0);
    const c = runs.reduce((s, r) => s + r.control, 0);
    if (!Number.isSafeInteger(t) || !Number.isSafeInteger(c)) {
        throw new StatsRefusal(
            `${f.id}: the event totals ${t} and ${c} exceed exact integer range`,
        );
    }
    const share = c === 0 ? 1 : betaQuantile(1 - num(f.alpha) / 2, t + 1, c);
    const ratioUpper = share >= 1 ? "unbounded" : share / (1 - share);
    return {
        n,
        difference: mean(diffs),
        interval: null,
        p,
        method: oneSided
            ? "one-sided paired sign test with run as unit"
            : "paired sign test with run as unit",
        detectable: least === undefined ? null : (100 * least) / n,
        resolution_ratio: null,
        resolution_note: `the sign test's detectable size is a share of runs, which the ${f.mde.scale}-scale MDE does not measure`,
        rate_ratio_upper: t + c === 0 ? undefined : ratioUpper,
        shift: p <= num(f.alpha) ? Math.sign(up - down) : 0,
    };
}

function graded(f: Family, runs: RunPair[], p: Preregistration): Stats {
    const n = runs.length;
    const bca = f.interval_method === "paired-bca-bootstrap" || n < 10;
    const method = bca ? "paired BCa bootstrap over runs" : "paired percentile bootstrap over runs";
    const unit = f.mde.scale === "pp" ? 100 : 1;
    const diffs = runs.map((r) => unit * (r.treatment - r.control));
    if (n < 2) return { ...empty(method), n, difference: n ? (diffs[0] as number) : 0 };
    const m = mean(diffs);
    const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
    const b = bootstrap(diffs, mean, { ...p.bootstrap, alpha: num(f.alpha), bca });
    finiteInterval([b.lo, b.hi], p);
    const detectable = (zSum(f) * sd) / Math.sqrt(n);
    if (!Number.isFinite(detectable)) {
        throw new StatsRefusal(`${f.id}: the detectable size overflows at ${n} runs`);
    }
    return {
        n,
        difference: m,
        interval: [b.lo, b.hi],
        p: null,
        method,
        detectable,
        resolution_ratio: scaled(detectable, f),
        shift: b.lo > 0 ? 1 : b.hi < 0 ? -1 : 0,
    };
}

function bound(f: Family, metric: string, s: Stats, obs: Observation): [string, boolean] {
    const margin = num(f.margin.value);
    if (s.n === 0) return ["inconclusive", false];
    const bad =
        obs.unit === "item"
            ? mean((obs.items ?? []).map((x) => x.treatment)) < margin
                ? (obs.items ?? []).filter((x) => x.treatment === 0).map((x) => x.item)
                : []
            : (obs.runs ?? [])
                  .filter((r) =>
                      f.direction === "zero-tolerance" ? r.treatment !== 0 : r.treatment > margin,
                  )
                  .map((r) => r.run);
    return bad.length === 0
        ? ["within-bound", true]
        : [`failed-gate(${metric}, ${bad.join(" ")})`, false];
}

function judge(f: Family, metric: string, s: Stats, obs: Observation): [string, boolean | null] {
    if (f.direction === "threshold" || f.direction === "zero-tolerance") {
        return bound(f, metric, s, obs);
    }
    if (s.n === 0) return ["inconclusive", f.claim === "gate" ? false : null];
    if (f.interval_method === "none") return ["descriptive", null];
    if (needsPairedRuns(f) && s.n < f.min_paired_runs) {
        return [`insufficient-runs(${s.n})`, false];
    }
    const adjusted = s.p_adjusted ?? s.p;
    const shift = adjusted !== null && adjusted > num(f.alpha) ? 0 : s.shift;
    const scale = f.outcome === "binary" ? "pp" : s.interval === null ? "pp-of-runs" : f.mde.scale;
    const none =
        s.detectable === null || !Number.isFinite(s.detectable)
            ? "inconclusive"
            : `no-difference-above-${Math.round(s.detectable * 100) / 100}${scale}-detectable-at-${s.n}`;
    const text = shift === 0 ? none : shift > 0 === higherIsBetter(metric) ? "better" : "worse";
    if (f.claim !== "gate") return [text, null];
    const margin = num(f.margin.value);
    const hi = s.interval?.[1];
    if (f.direction === "superiority-two-sided") return [text, text === "better"];
    if (f.direction === "noninferiority") return [text, hi !== undefined && hi < margin];
    if (hi !== undefined) return [text, hi <= margin];
    const upper = s.rate_ratio_upper;
    const within =
        f.margin.scale !== "ratio" ||
        upper === undefined ||
        (upper !== "unbounded" && upper <= margin);
    return [text, text !== "worse" && within];
}

function statsOf(f: Family, o: Observation, p: Preregistration): Stats {
    if (f.direction === "threshold" || f.direction === "zero-tolerance") {
        return {
            ...empty("bound on each run's treatment value"),
            n: (o.items ?? o.runs ?? []).length,
        };
    }
    if (f.interval_method === "none") {
        const diffs = [...(o.items ?? []), ...(o.runs ?? [])].map((x) => x.treatment - x.control);
        const unit = f.outcome === "binary" ? 100 : 1;
        const difference = diffs.length ? unit * mean(diffs) : 0;
        if (!Number.isFinite(difference)) {
            throw new StatsRefusal(`${o.metric}: the paired mean difference overflows`);
        }
        return {
            ...empty("paired mean difference; the pre-registration names no interval method"),
            n: diffs.length,
            difference,
        };
    }
    if (o.unit === "item") return binary(f, o.items ?? [], p);
    return f.outcome === "count" ? counts(f, o.runs ?? []) : graded(f, o.runs ?? [], p);
}

/** eval-core's `bootstrap_replicates` range starts at 40; below it a BCa interval degenerates. */
const MIN_BOOTSTRAP_REPLICATES = 40;

function check(p: Preregistration, input: TierInput): void {
    if (p.bootstrap.replicates < MIN_BOOTSTRAP_REPLICATES) {
        throw new StatsRefusal(
            `bootstrap.replicates ${p.bootstrap.replicates} is below the floor of ${MIN_BOOTSTRAP_REPLICATES}`,
        );
    }
    const seq = input.journal_seq_at_eval;
    if (!Number.isSafeInteger(seq) || seq < 0) {
        throw new StatsRefusal(
            `journal_seq_at_eval must be a non-negative safe integer, got ${seq}`,
        );
    }
    const arms = input.arms;
    if (arms?.control !== "host" || arms.treatment !== p.arms.default) {
        throw new StatsRefusal(
            `arms: the registered comparison is host against ${p.arms.default}, got ${JSON.stringify(arms)}`,
        );
    }
    for (const [kind, sd] of Object.entries(input.cusum_sd ?? {})) {
        if (sd !== undefined && !(Number.isFinite(sd) && sd > 0)) {
            throw new StatsRefusal(
                `cusum_sd.${kind}: a standard deviation is finite and positive, got ${sd}`,
            );
        }
    }
    const byMetric = new Map<string, Family>();
    for (const f of p.families) {
        if (f.analysis_unit === "item" && f.outcome !== "binary") {
            throw new StatsRefusal(`${f.id}: an item-level family has a binary outcome`);
        }
        const bound = BOUND_DIRECTIONS.includes(f.direction);
        if (bound && f.outcome === "binary" && !isShare(num(f.margin.value))) {
            throw new StatsRefusal(`${f.id}: a binary threshold lies in [0, 1]`);
        }
        if (bound && f.interval_method !== "none") {
            throw new StatsRefusal(`${f.id}: a bound family has no interval method`);
        }
        if (!bound && f.interval_method === "none" && f.claim === "gate") {
            throw new StatsRefusal(`${f.id}: a gate with a paired claim names an interval method`);
        }
        const methods = METHODS[`${f.analysis_unit} ${f.outcome}`] ?? [];
        if (f.interval_method !== "none" && !methods.includes(f.interval_method)) {
            throw new StatsRefusal(
                `${f.id}: ${f.interval_method} is not a method for ${f.analysis_unit} ${f.outcome}`,
            );
        }
        for (const m of f.metrics) {
            if (byMetric.has(m)) throw new StatsRefusal(`${m} is registered in two families`);
            byMetric.set(m, f);
        }
    }
    const seen = new Set<string>();
    const runIds = new Map<string, Set<string>>();
    for (const e of input.excluded) {
        if (e.arm !== arms.control && e.arm !== arms.treatment) {
            throw new StatsRefusal(`excluded ${e.id}: arm ${e.arm} is neither compared arm`);
        }
        if (!isName(e.id) || !isName(e.reason)) {
            throw new StatsRefusal(`excluded ${e.id}: an exclusion names its item and its reason`);
        }
    }
    if (!input.asymmetric.every(isName)) {
        throw new StatsRefusal("an asymmetric id is a non-blank string");
    }
    const exclusions = input.excluded.map((e) => `${e.arm}\n${e.id}`);
    const excludedIds = new Set(input.excluded.map((e) => e.id));
    if (
        new Set(exclusions).size !== exclusions.length ||
        new Set(input.asymmetric).size !== input.asymmetric.length ||
        input.asymmetric.some((id) => excludedIds.has(id))
    ) {
        throw new StatsRefusal(
            "an exclusion is listed once per arm, an asymmetric id once, and the two lists are disjoint",
        );
    }
    const orderOf = new Map<string, number>();
    const clusterOf = new Map<string, string>();
    const itemAt = new Map<number, string>();
    for (const o of input.observations) {
        if (seen.has(o.metric)) throw new StatsRefusal(`metric ${o.metric} is observed twice`);
        seen.add(o.metric);
        const f = byMetric.get(o.metric);
        if (!f) throw new StatsRefusal(`metric ${o.metric} has no pre-registration entry`);
        if (o.unit !== f.analysis_unit) {
            throw new StatsRefusal(
                `${o.metric}: unit ${o.unit}, pre-registered ${f.analysis_unit}`,
            );
        }
        if (o.cluster_key !== f.cluster_key) {
            throw new StatsRefusal(
                `${o.metric}: cluster ${o.cluster_key}, pre-registered ${f.cluster_key}`,
            );
        }
        const [own, other] = o.unit === "item" ? [o.items, o.runs] : [o.runs, o.items];
        if (!Array.isArray(own) || other !== undefined) {
            throw new StatsRefusal(
                `${o.metric}: a ${o.unit} observation carries exactly an array of ${o.unit}s`,
            );
        }
        if (!own.every((x) => typeof x === "object" && x !== null)) {
            throw new StatsRefusal(`${o.metric}: every ${o.unit} is a pair record`);
        }
        const names = [
            ...(o.items ?? []).flatMap((x) => [x.item, x.cluster]),
            ...(o.runs ?? []).map((r) => r.run),
        ];
        if (!names.every(isName)) {
            throw new StatsRefusal(
                `${o.metric}: item, cluster, and run identifiers are non-blank strings`,
            );
        }
        if (!own.every((x) => Number.isFinite(x.control) && Number.isFinite(x.treatment))) {
            throw new StatsRefusal(`${o.metric}: every control and treatment value is finite`);
        }
        if (f.outcome === "binary" && !own.every((x) => isBit(x.control) && isBit(x.treatment))) {
            throw new StatsRefusal(`${o.metric}: a binary outcome is 0 or 1 in both arms`);
        }
        if (f.outcome === "count" && !own.every((x) => x.control >= 0 && x.treatment >= 0)) {
            throw new StatsRefusal(`${o.metric}: a count is at least 0 in both arms`);
        }
        if (
            f.outcome === "count" &&
            f.margin.scale !== "none" &&
            !own.every((x) => Number.isSafeInteger(x.control) && Number.isSafeInteger(x.treatment))
        ) {
            throw new StatsRefusal(`${o.metric}: an event count is a safe integer in both arms`);
        }
        if (
            f.outcome === "graded" &&
            f.mde.scale === "pp" &&
            !own.every((x) => isShare(x.control) && isShare(x.treatment))
        ) {
            throw new StatsRefusal(`${o.metric}: a pp-scale graded value is a share in [0, 1]`);
        }
        if (!(o.items ?? []).every((x) => isIndex(x.order))) {
            throw new StatsRefusal(`${o.metric}: an item's issue order is a non-negative integer`);
        }
        for (const x of o.items ?? []) {
            const prior = orderOf.get(x.item);
            const holder = itemAt.get(x.order);
            if (
                (prior !== undefined && prior !== x.order) ||
                (holder !== undefined && holder !== x.item)
            ) {
                throw new StatsRefusal(
                    `${o.metric}: issue order ${x.order} belongs to one item, and ${x.item} has one order`,
                );
            }
            orderOf.set(x.item, x.order);
            itemAt.set(x.order, x.item);
            const cluster = clusterOf.get(x.item);
            if (cluster !== undefined && cluster !== x.cluster) {
                throw new StatsRefusal(`${o.metric}: ${x.item} has one ledger-fact cluster`);
            }
            clusterOf.set(x.item, x.cluster);
        }
        const ids =
            o.unit === "item"
                ? (o.items ?? []).map((x) => x.item)
                : (o.runs ?? []).map((r) => r.run);
        if (new Set(ids).size !== ids.length) {
            throw new StatsRefusal(`${o.metric}: each ${o.unit} identity appears once`);
        }
        if (o.unit === "run") {
            const set = new Set(ids);
            const prior = runIds.get(f.id);
            if (
                prior !== undefined &&
                (prior.size !== set.size || ![...set].every((id) => prior.has(id)))
            ) {
                throw new StatsRefusal(
                    `${f.id}: every metric of a run-level family comes from the same runs`,
                );
            }
            runIds.set(f.id, set);
        }
    }
    const turns = input.observations.find((o) => o.metric === "failed_turns")?.runs;
    if (turns) {
        for (const [arm, side] of [
            [arms.control, "control"],
            [arms.treatment, "treatment"],
        ] as const) {
            const failed = input.excluded.filter(
                (e) => e.arm === arm && e.reason.startsWith("failed("),
            ).length;
            const observed = turns.reduce((s, r) => s + r[side], 0);
            if (failed > observed) {
                throw new StatsRefusal(
                    `${arm}: ${failed} failed exclusions exceed ${observed} failed turns; the missingness policy counts failed items in dependability`,
                );
            }
        }
    }
}

const isBit = (v: number) => v === 0 || v === 1;
const isName = (v: unknown) => typeof v === "string" && v.trim() !== "";
/** The interval methods the gate implements per unit and outcome; `none` is allowed everywhere. */
const METHODS: Record<string, readonly string[]> = {
    "item binary": ["exact-mcnemar-newcombe-cluster-bootstrap"],
    "run graded": ["paired-bca-bootstrap", "paired-percentile-bootstrap"],
    "run count": ["paired-sign-test", "negative-binomial-glm"],
    "run slope": ["slope-paired-bootstrap"],
};
const isShare = (v: number) => v >= 0 && v <= 1;
const isIndex = (v: number) => Number.isInteger(v) && v >= 0;

function stops(
    p: Preregistration,
    input: TierInput,
    kept: Observation[],
): [CusumStop[], string[], CusumRule[]] {
    const out: CusumStop[] = [];
    const unavailable: string[] = [];
    const rules: CusumRule[] = [];
    for (const rule of p.stopping_rule.cusum) {
        const sd = input.cusum_sd?.[rule.kind];
        rules.push({
            kind: rule.kind,
            metric: rule.metric,
            sd_source: rule.sd_source,
            sd: sd ?? null,
        });
        if (!sd) {
            unavailable.push(`${rule.kind}: no A/A standard deviation`);
            continue;
        }
        const family = p.families.find((f) => f.id === rule.metric);
        const sign = rule.kind === "harm" ? 1 : -1;
        const byItem = new Map<string, { item: string; order: number; value: number }>();
        for (const x of kept
            .filter((o) => family?.metrics.includes(o.metric))
            .flatMap((o) => o.items ?? [])) {
            const value = sign * (x.treatment - x.control);
            const prior = byItem.get(x.item);
            if (!prior || value > prior.value)
                byItem.set(x.item, { item: x.item, order: x.order, value });
        }
        const items = [...byItem.values()].sort((x, y) => x.order - y.order);
        if (items.length === 0) {
            unavailable.push(`${rule.kind}: no items for ${rule.metric}`);
            continue;
        }
        const c = cusum(
            items.map((x) => x.value / sd),
            0,
            num(rule.k),
            num(rule.h),
        );
        if (c.signal_upper === null) continue;
        const signal = c.signal_upper;
        const start = c.upper.slice(0, signal).lastIndexOf(0) + 1;
        out.push({
            kind: rule.kind,
            metric: rule.metric,
            signal_index: signal,
            window: items.slice(start, signal + 1).map((x) => x.item),
        });
    }
    return [out, unavailable, rules];
}

export function evaluateTier(p: Preregistration, input: TierInput): TierVerdict {
    check(p, input);
    const dropped = new Set(input.excluded.map((e) => e.id));
    const asym = new Set(input.asymmetric);
    const keep = (id: string) => !dropped.has(id) && !asym.has(id);
    const kept = input.observations.map((o) => ({
        ...o,
        items: o.items?.filter((x) => keep(x.item)),
        runs: o.runs?.filter((r) => keep(r.run)),
    }));
    const families = p.families.map((f): FamilyResult => {
        const mine = f.metrics.map(
            (metric): Observation =>
                kept.find((o) => o.metric === metric) ?? {
                    metric,
                    unit: f.analysis_unit,
                    cluster_key: f.cluster_key,
                    items: [],
                    runs: [],
                },
        );
        const stats = mine.map((o) => statsOf(f, o, p));
        if (f.multiplicity === "holm") {
            const adjusted = holm(stats.map((s) => s.p ?? 1));
            stats.forEach((s, i) => {
                s.p_adjusted = adjusted[i] as number;
            });
        }
        const metrics = mine.map((o, i): MetricResult => {
            const full = stats[i] as Stats;
            const { shift: _, ...s } = full;
            const [verdict, passed] = judge(f, o.metric, full, o);
            const raw = input.observations.find((x) => x.metric === o.metric);
            const ids = [
                ...(raw?.items ?? []).map((x) => x.item),
                ...(raw?.runs ?? []).map((r) => r.run),
            ];
            const asymmetric_pairs = ids.filter((id) => asym.has(id)).length;
            return { metric: o.metric, ...s, verdict, passed, asymmetric_pairs };
        });
        const passed = f.claim !== "gate" ? null : metrics.every((m) => m.passed === true);
        const { id: family, claim, direction } = f;
        const [mde, margin] = [{ ...f.mde }, { ...f.margin }];
        return { family, claim, direction, alpha: num(f.alpha), mde, margin, metrics, passed };
    });
    const [halts, unavailable, rules] = stops(p, input, kept);
    const gates = families.filter((f) => f.claim === "gate");
    const excluded: Record<string, number> = { [input.arms.control]: 0, [input.arms.treatment]: 0 };
    for (const e of input.excluded) excluded[e.arm] = (excluded[e.arm] ?? 0) + 1;
    const worse = families
        .find((f) => f.family === "harm")
        ?.metrics.filter((m) => m.verdict === "worse")
        .map((m) => ({ metric: m.metric, interval: m.interval }));
    const verdict: TierVerdict = {
        prereg_sha256: preregistrationHash(p),
        journal_seq_at_eval: input.journal_seq_at_eval,
        arms: { ...input.arms },
        families,
        memory_made_it_worse: worse ?? [],
        pass: {
            passed:
                halts.length === 0 &&
                unavailable.length === 0 &&
                gates.length > 0 &&
                gates.every((f) => f.passed === true),
            components: gates.map((f) => f.family),
            per_component_alpha: Object.fromEntries(gates.map((f) => [f.family, f.alpha])),
            rule: "intersection-union: the tier passes when every gate component passes at its own alpha and every CUSUM rule was evaluated and none stopped it; a noninferiority or at-most component with an interval decides on its upper end, a one-sided test at half its alpha; the at-most sign test decides its one-sided p at its alpha",
        },
        stops: halts,
        cusum_rules: rules,
        cusum_unavailable: unavailable,
        excluded_per_arm: excluded,
        excluded: input.excluded.map((e) => ({ ...e })),
        asymmetric_stratum: [...input.asymmetric],
    };
    if (JSON.stringify(verdict).toLowerCase().includes("parity")) {
        throw new StatsRefusal("a verdict may not use the word parity");
    }
    return verdict;
}

export function pairByItem(
    control: ReadonlyMap<string, number>,
    treatment: ReadonlyMap<string, number>,
    clusterOf: (item: string) => string,
    issueOrder: (item: string) => number,
): ItemPair[] {
    const both = [...control.keys()].filter((item) => treatment.has(item));
    return both
        .map((item) => {
            const order = issueOrder(item);
            if (!isIndex(order))
                throw new StatsRefusal(`${item}: issue order ${order} is not an index`);
            return {
                item,
                cluster: clusterOf(item),
                control: control.get(item) as number,
                treatment: treatment.get(item) as number,
                order,
            };
        })
        .sort((x, y) => x.order - y.order);
}

export const FALSIFICATION = [
    "in_session_repo_readable_fact_pass",
    "gateway_4xx_rate_without_faults",
    "pre_divergence_pushback_rate",
    "wall_ms_per_scripted_idle_gap",
] as const;
/** The first three checks are rates in [0, 1]; the idle-gap wall time is a non-negative duration. */
const inDomain = (check: string, v: number) =>
    check === "wall_ms_per_scripted_idle_gap" ? v >= 0 : isShare(v);

export interface ZeroEffect {
    check: string;
    n: number;
    difference: number;
    interval: [number, number] | null;
    zero_effect: boolean | null;
}

export function falsificationSet(
    p: Preregistration,
    pairs: Partial<Record<string, { control: number; treatment: number }[]>>,
): ZeroEffect[] {
    if (p.bootstrap.replicates < MIN_BOOTSTRAP_REPLICATES) {
        throw new StatsRefusal(
            `bootstrap.replicates ${p.bootstrap.replicates} is below the floor of ${MIN_BOOTSTRAP_REPLICATES}`,
        );
    }
    for (const name of Object.keys(pairs)) {
        if (!(FALSIFICATION as readonly string[]).includes(name)) {
            throw new StatsRefusal(`${name} is not in the falsification set`);
        }
        const values = (pairs[name] ?? []).flatMap((x) => [x.control, x.treatment]);
        if (!values.every(Number.isFinite)) {
            throw new StatsRefusal(`${name}: every control and treatment value is finite`);
        }
        if (!values.every((v) => inDomain(name, v))) {
            throw new StatsRefusal(`${name}: every value lies in the check's measurement domain`);
        }
    }
    return FALSIFICATION.map((check) => {
        const diffs = (pairs[check] ?? []).map((x) => x.treatment - x.control);
        if (diffs.length < 2) {
            const difference = diffs.length ? mean(diffs) : 0;
            return { check, n: diffs.length, difference, interval: null, zero_effect: null };
        }
        const b = bootstrap(diffs, mean, { ...p.bootstrap, bca: diffs.length < 10 });
        const interval: [number, number] = [b.lo, b.hi];
        finiteInterval(interval, p);
        const zero_effect = b.lo <= 0 && b.hi >= 0;
        return { check, n: diffs.length, difference: mean(diffs), interval, zero_effect };
    });
}
