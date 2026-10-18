import type { Preregistration } from "../prereg/schema";
import { normalQuantile } from "../stats/dist";
import type { TierInput } from "../stats/gate";

export interface TypeSize {
    metric: string;
    pairs: number;
    discordance: number;
    items_per_fact: number;
    icc: number;
    design_effect: number;
    effect: number;
    n: number | null;
}

export interface Resizing {
    source_tier: string;
    planning: number;
    per_type: TypeSize[];
    paired_items_per_probe_type: number;
}

/** One-way ANOVA intraclass correlation of item differences within ledger facts, in [0, 1]. */
export function icc(groups: number[][]): number {
    const sizes = groups.map((g) => g.length);
    const total = sizes.reduce((s, n) => s + n, 0);
    const k = groups.length;
    if (k < 2 || total <= k) return 0;
    const all = groups.flat();
    const grand = all.reduce((s, x) => s + x, 0) / total;
    const means = groups.map((g) => g.reduce((s, x) => s + x, 0) / g.length);
    const ssb = groups.reduce((s, g, i) => s + g.length * ((means[i] as number) - grand) ** 2, 0);
    const ssw = groups.reduce(
        (s, g, i) => s + g.reduce((t, x) => t + (x - (means[i] as number)) ** 2, 0),
        0,
    );
    const [msb, msw] = [ssb / (k - 1), ssw / (total - k)];
    const n0 = (total - sizes.reduce((s, n) => s + n * n, 0) / total) / (k - 1);
    const denom = msb + (n0 - 1) * msw;
    return denom <= 0 ? 0 : Math.min(1, Math.max(0, (msb - msw) / denom));
}

/** L's paired items per probe type from M's observed discordance, by the pre-registered rule. */
export function resizeFromM(l: Preregistration, m: TierInput): Resizing {
    const planning =
        l.resizing?.planning_paired_items_per_probe_type ??
        l.stopping_rule.paired_items_per_probe_type;
    const per_type = l.families
        .filter((f) => f.analysis_unit === "item" && f.direction !== "descriptive")
        .flatMap((f) =>
            f.metrics.map((metric): TypeSize => {
                const items = m.observations.find((o) => o.metric === metric)?.items ?? [];
                const harm = f.direction === "noninferiority";
                const effect = Number(harm ? f.margin.value : f.mde.value) / 100;
                const za = normalQuantile(1 - Number(f.alpha) / (harm ? f.metrics.length : 2));
                const zb = normalQuantile(Number(f.power));
                const d =
                    items.length === 0
                        ? 0
                        : items.filter((x) => x.control !== x.treatment).length / items.length;
                const facts = [...new Set(items.map((x) => x.cluster))];
                const groups = facts.map((c) =>
                    items.filter((x) => x.cluster === c).map((x) => x.treatment - x.control),
                );
                const per = facts.length === 0 ? 0 : items.length / facts.length;
                const rho = icc(groups);
                const de = 1 + Math.max(0, per - 1) * rho;
                const variance = harm ? d : d - effect ** 2;
                const n =
                    d === 0 || effect === 0 || variance <= 0
                        ? null
                        : Math.ceil(
                              de * ((za * Math.sqrt(d) + zb * Math.sqrt(variance)) / effect) ** 2,
                          );
                return {
                    metric,
                    pairs: items.length,
                    discordance: d,
                    items_per_fact: per,
                    icc: rho,
                    design_effect: de,
                    effect,
                    n,
                };
            }),
        );
    const sized = per_type.map((t) => t.n).filter((n): n is number => n !== null);
    return {
        source_tier: l.resizing?.source_tier ?? "M",
        planning,
        per_type,
        paired_items_per_probe_type: sized.length === 0 ? planning : Math.max(...sized),
    };
}
