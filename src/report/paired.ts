import type { GradeRecord } from "../grade/probes";
import { Rng } from "../rng";

export interface PairedMetric {
    metric: string;
    n: number;
    clusters: number;
    mean: number;
    lo: number;
    hi: number;
    covers_zero: boolean;
}

export interface ItemDiff {
    item: string;
    d: number;
}

/**
 * Per-item differences `b - a` for every metric both arms graded, verdicts as `<type>.pass`. P7
 * grades come from pairwise judgments against the host arm, so they have no A/A pairing.
 */
export function pairedDiffs(grades: GradeRecord[], a: string, b: string): Map<string, ItemDiff[]> {
    const graded = (arm: string) =>
        new Map(
            grades
                .filter((g) => g.arm === arm && g.verdict !== "excluded" && g.probe_type !== "P7")
                .map((g) => [g.item, g]),
        );
    const [left, right] = [graded(a), graded(b)];
    const diffs = new Map<string, ItemDiff[]>();
    const add = (metric: string, item: string, d: number) =>
        diffs.set(metric, [...(diffs.get(metric) ?? []), { item, d }]);
    const value = (v: unknown) => (typeof v === "boolean" ? Number(v) : v);
    for (const [item, x] of left) {
        const y = right.get(item);
        if (!y) continue;
        const pass = `${x.probe_type}.pass`;
        add(pass, item, Number(y.verdict === "pass") - Number(x.verdict === "pass"));
        for (const [k, v] of Object.entries(x.metrics).filter(([k]) => k !== pass)) {
            const [p, q] = [value(v), value(y.metrics[k])];
            if (typeof p === "number" && typeof q === "number") add(k, item, q - p);
        }
    }
    return diffs;
}

/**
 * A percentile bootstrap of the mean difference that resamples clusters, so items of one ledger
 * fact move together; seeded from the pre-registration.
 */
export function bootstrapMean(
    metric: string,
    diffs: ItemDiff[],
    clusterOf: (item: string) => string,
    replicates: number,
    seed: number,
): PairedMetric {
    const groups = new Map<string, number[]>();
    for (const { item, d } of diffs) {
        const c = clusterOf(item);
        groups.set(c, [...(groups.get(c) ?? []), d]);
    }
    const clusters = [...groups.values()];
    const mean = diffs.reduce((s, x) => s + x.d, 0) / diffs.length;
    const rng = new Rng(seed);
    const means = Array.from({ length: replicates }, () => {
        let [sum, count] = [0, 0];
        for (let i = 0; i < clusters.length; i++) {
            const c = clusters[Math.floor(rng.next() * clusters.length)] ?? [];
            sum += c.reduce((s, d) => s + d, 0);
            count += c.length;
        }
        return sum / count;
    }).sort((x, y) => x - y);
    const at = (q: number) => means[Math.min(replicates - 1, Math.floor(q * replicates))] ?? mean;
    const [lo, hi] = [at(0.025), at(0.975)];
    const n = diffs.length;
    return { metric, n, clusters: clusters.length, mean, lo, hi, covers_zero: lo <= 0 && hi >= 0 };
}

/** The share of items both arms graded whose verdicts differ. */
export function disagreementRate(grades: GradeRecord[], a: string, b: string): number | null {
    const verdicts = [...pairedDiffs(grades, a, b)]
        .filter(([k]) => k.endsWith(".pass"))
        .flatMap(([, d]) => d);
    return verdicts.length === 0
        ? null
        : verdicts.filter((x) => x.d !== 0).length / verdicts.length;
}
