import { describe, expect, test } from "bun:test";
import { loadPrereg } from "../scenario/inputs";
import {
    evaluateTier,
    falsificationSet,
    type ItemPair,
    type Observation,
    pairByItem,
    type RunPair,
    StatsRefusal,
} from "./gate";

const M = loadPrereg("M");
const S = loadPrereg("S");
let order = 0;
const items = (pairs: [number, number][], fact = (i: number) => `f-${i % 12}`): ItemPair[] =>
    pairs.map(([control, treatment], i) => ({
        item: `q-${order}`,
        cluster: fact(i),
        control,
        treatment,
        order: order++,
    }));
const binary = (
    metric: string,
    pairs: [number, number][],
    fact?: (i: number) => string,
): Observation => ({
    metric,
    unit: "item",
    cluster_key: "ledger_fact_id",
    items: items(pairs, fact),
});
const runs = (metric: string, values: [number, number][]): Observation => ({
    metric,
    unit: "run",
    cluster_key: "run",
    runs: values.map(([control, treatment], i): RunPair => ({ run: `r-${i}`, control, treatment })),
});
const evaluate = (observations: Observation[], extra = {}) =>
    evaluateTier(M, {
        observations,
        excluded: [],
        asymmetric: [],
        journal_seq_at_eval: 7,
        arms: { control: "host", treatment: "eidnara" },
        ...extra,
    });
const metric = (v: ReturnType<typeof evaluate>, family: string, name: string) =>
    v.families.find((f) => f.family === family)?.metrics.find((m) => m.metric === name);
const repeat = <T>(n: number, x: T) => Array.from({ length: n }, () => x);

describe("tier gates", () => {
    test("a planted cross-session effect of 0 versus 99 percent is better, with p and interval", () => {
        const pairs: [number, number][] = [...repeat(99, [0, 1] as [number, number]), [0, 0]];
        const m = metric(evaluate([binary("P1.pass", pairs)]), "probe-P1", "P1.pass");
        expect(m?.verdict).toBe("better");
        expect(m?.passed).toBe(true);
        expect(m?.p).toBeLessThan(1e-20);
        expect(m?.difference).toBe(99);
        expect((m?.interval?.[0] ?? 0) > 90 && (m?.interval?.[1] ?? 0) <= 100).toBe(true);
    });

    test("tens of probes with no effect name the detectable difference and its resolution ratio", () => {
        const pairs: [number, number][] = Array.from({ length: 30 }, (_, i) =>
            i % 5 === 0 ? [1, 0] : i % 5 === 1 ? [0, 1] : [i % 2, i % 2],
        );
        const m = metric(evaluate([binary("P1.pass", pairs)]), "probe-P1", "P1.pass");
        expect(m?.verdict).toMatch(/^no-difference-above-\d+(\.\d+)?pp-detectable-at-30$/);
        expect(m?.passed).toBe(false);
        expect(m?.detectable).toBeCloseTo(32.3499, 3);
        expect(m?.resolution_ratio).toBeCloseTo(2.48846, 4);
    });

    test("a metric without an entry, a wrong unit, or a wrong cluster is refused by name", () => {
        expect(() => evaluate([binary("P99.pass", [[0, 1]])])).toThrow(
            new StatsRefusal("metric P99.pass has no pre-registration entry"),
        );
        expect(() => evaluate([{ ...binary("P1.pass", [[0, 1]]), unit: "run" }])).toThrow(
            "P1.pass: unit run, pre-registered item",
        );
        expect(() => evaluate([{ ...binary("P1.pass", [[0, 1]]), cluster_key: "run" }])).toThrow(
            "P1.pass: cluster run, pre-registered ledger_fact_id",
        );
    });

    test("the harm family adjusts its five metrics by Holm, and the pass states each component's alpha", () => {
        const harms = ["P2.harm", "P3.harm", "P4.harm", "P10.harm", "P11.harm"];
        const shapes: [number, number][][] = [
            [...repeat(12, [0, 1] as [number, number]), ...repeat(28, [0, 0] as [number, number])],
            [...repeat(3, [0, 1] as [number, number]), ...repeat(37, [0, 0] as [number, number])],
            repeat(40, [0, 0] as [number, number]),
            [...repeat(2, [1, 0] as [number, number]), ...repeat(38, [0, 0] as [number, number])],
            repeat(40, [0, 0] as [number, number]),
        ];
        const v = evaluate(harms.map((h, i) => binary(h, shapes[i] ?? [])));
        const harm = v.families.find((f) => f.family === "harm");
        expect(harm?.metrics.map((m) => m.p)).toEqual([2 / 4096, 0.25, 1, 0.5, 1]);
        expect(harm?.metrics.map((m) => m.p_adjusted)).toEqual([10 / 4096, 1, 1, 1, 1]);
        expect(harm?.metrics.length).toBe(5);
        expect(metric(v, "harm", "P2.harm")?.verdict).toBe("worse");
        expect(metric(v, "harm", "P3.harm")?.verdict).toStartWith("no-difference-above-");
        expect(harm?.passed).toBe(false);
        expect(v.memory_made_it_worse.map((w) => w.metric)).toEqual(["P2.harm"]);
        expect(harm?.mde).toEqual({ value: "0", scale: "pp" });
        expect(harm?.margin).toEqual({ value: "10", scale: "pp" });
        expect(v.prereg_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(v.pass.per_component_alpha.harm).toBe(0.05);
        expect(v.pass.per_component_alpha["probe-P14"]).toBe(0.03);
        expect(v.pass.rule).toContain("at its own alpha");
        expect(v.pass.passed).toBe(false);
    });

    test("CUSUM stops the tier for harm or futility and the stop withholds any pass", () => {
        const harmful: [number, number][] = [
            ...repeat(10, [0, 0] as [number, number]),
            ...repeat(8, [0, 1] as [number, number]),
        ];
        const v = evaluate([binary("P2.harm", harmful)], {
            cusum_sd: { harm: 0.5, futility: 0.5 },
        });
        expect(v.stops.map((s) => s.kind)).toEqual(["harm"]);
        const ids = v.families.find((x) => x.family === "harm")?.metrics[0];
        expect(ids?.n).toBe(18);
        const harmItems = (v.stops[0]?.window ?? []).length;
        expect(harmItems).toBe(3);
        expect(v.stops[0]?.signal_index).toBe(12);
        expect(v.pass.passed).toBe(false);
        const planted: [number, number][] = repeat(40, [0, 1] as [number, number]);
        const good = evaluate(
            [binary("P1.pass", planted), binary("P2.harm", repeat(40, [1, 0] as [number, number]))],
            {
                cusum_sd: { harm: 0.5, futility: 0.5 },
            },
        );
        expect(good.stops).toEqual([]);
        const futile: [number, number][] = repeat(12, [1, 0] as [number, number]);
        const f = evaluate([binary("P1.pass", futile)], { cusum_sd: { harm: 0.5, futility: 0.5 } });
        expect(f.stops.map((s) => s.kind)).toEqual(["futility"]);
        expect(f.pass.passed).toBe(false);
        expect(evaluate([binary("P1.pass", futile)]).cusum_unavailable).toEqual([
            "harm: no A/A standard deviation",
            "futility: no A/A standard deviation",
        ]);
    });

    test("a gate family missing a metric fails it, Holm runs over all five, and a metric observed twice is refused", () => {
        const v = evaluate([binary("P2.harm", repeat(40, [0, 0] as [number, number]))]);
        const harm = v.families.find((f) => f.family === "harm");
        expect(harm?.metrics.map((m) => [m.metric, m.verdict])).toEqual([
            ["P2.harm", expect.stringMatching(/^no-difference-above-/)],
            ["P3.harm", "inconclusive"],
            ["P4.harm", "inconclusive"],
            ["P10.harm", "inconclusive"],
            ["P11.harm", "inconclusive"],
        ]);
        expect(harm?.passed).toBe(false);
        expect(harm?.metrics[0]?.detectable).toBeCloseTo(5.43845, 5);
        expect(harm?.metrics[0]?.resolution_ratio).toBeCloseTo(0.543845, 6);
        const twice = binary("P1.pass", [[0, 1]]);
        expect(() => evaluate([twice, twice])).toThrow("metric P1.pass is observed twice");
    });

    test("excluded and fault-asymmetric pairs leave the analysis and are counted", () => {
        const obs = binary("P1.pass", repeat(10, [0, 1] as [number, number]));
        const ids = obs.items?.map((x) => x.item) ?? [];
        const v = evaluate([obs], {
            excluded: [{ id: ids[0], arm: "eidnara", reason: "failed(interrupted)" }],
            asymmetric: [ids[1], ids[2]] as string[],
        });
        const m = metric(v, "probe-P1", "P1.pass");
        expect([m?.n, m?.asymmetric_pairs]).toEqual([7, 2]);
        expect(v.excluded_per_arm).toEqual({ host: 0, eidnara: 1 });
        expect(v.excluded.map((e) => e.id)).toEqual([ids[0]] as string[]);
        expect(v.asymmetric_stratum).toEqual([ids[1], ids[2]] as string[]);
    });

    test("run-level gates need six paired runs, counts use the registered sign test or GLM", () => {
        const few = metric(
            evaluate([runs("failed_turns", repeat(4, [0, 3] as [number, number]))]),
            "dependability",
            "failed_turns",
        );
        expect([few?.verdict, few?.passed]).toEqual(["insufficient-runs(4)", false]);
        const six = metric(
            evaluate([runs("failed_turns", repeat(6, [0, 3] as [number, number]))]),
            "dependability",
            "failed_turns",
        );
        expect([six?.verdict, six?.method]).toEqual([
            "worse",
            "one-sided paired sign test with run as unit",
        ]);
        expect(six?.p).toBeCloseTo(1 / 64, 12);
        const split: [number, number][] = [
            [0, 1],
            [1, 0],
            [0, 1],
            [1, 0],
            [0, 0],
            [2, 1],
        ];
        const mixed = metric(
            evaluate([runs("failed_turns", split)]),
            "dependability",
            "failed_turns",
        );
        expect(mixed?.verdict).toBe("no-difference-above-100pp-of-runs-detectable-at-6");
        const many: [number, number][] = Array.from({ length: 12 }, (_, i) => [
            2 + (i % 3),
            2 + ((i + 1) % 3),
        ]);
        const zeros = metric(
            evaluate([runs("hangs", repeat(10, [0, 0] as [number, number]))]),
            "dependability",
            "hangs",
        );
        expect([zeros?.method, zeros?.verdict, zeros?.passed]).toEqual([
            "one-sided paired sign test with run as unit",
            "no-difference-above-90pp-of-runs-detectable-at-10",
            true,
        ]);
        const worseFive = metric(
            evaluate([
                runs("failed_turns", [
                    [0, 2],
                    [0, 3],
                    [0, 1],
                    [0, 2],
                    [0, 2],
                    [1, 0],
                ]),
            ]),
            "dependability",
            "failed_turns",
        );
        expect([worseFive?.verdict.startsWith("no-difference"), worseFive?.passed]).toEqual([
            true,
            false,
        ]);
        expect(worseFive?.rate_ratio_upper).toBeGreaterThan(1.5);
        const glmPrereg = {
            ...M,
            families: M.families.map((f) =>
                f.id === "dependability"
                    ? { ...f, interval_method: "negative-binomial-glm" as const }
                    : f,
            ),
        };
        const glm = metric(
            evaluateTier(glmPrereg, {
                observations: [runs("hangs", many)],
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            }),
            "dependability",
            "hangs",
        );
        expect(glm?.method).toStartWith("negative-binomial GLM");
        expect(glm?.difference).toBeCloseTo(1, 4);
        expect(glm?.interval?.[0]).toBeCloseTo(0.5996, 3);
        expect(glm?.interval?.[1]).toBeCloseTo(1.6678, 3);
        expect(glm?.p).toBeCloseTo(1, 3);
        expect(glm?.detectable).toBeCloseTo(2.0337, 3);
        expect(glm?.resolution_ratio).toBeCloseTo(2.0337, 3);
        expect(glm?.verdict).toBe("no-difference-above-2.03ratio-detectable-at-12");
        expect(glm?.passed).toBe(false);
        const cleared = metric(
            evaluate([runs("hangs", repeat(9, [2, 0] as [number, number]))]),
            "dependability",
            "hangs",
        );
        expect([cleared?.method, cleared?.verdict, cleared?.passed]).toEqual([
            "one-sided paired sign test with run as unit",
            "no-difference-above-88.89pp-of-runs-detectable-at-9",
            true,
        ]);
        const oneHost = metric(
            evaluate([runs("failed_turns", [[1, 0], ...repeat(5, [0, 0] as [number, number])])]),
            "dependability",
            "failed_turns",
        );
        expect(oneHost?.rate_ratio_upper).toBeCloseTo(0.985 / 0.015, 3);
        expect(oneHost?.passed).toBe(false);
        const ties = metric(
            evaluate([runs("usd_per_component", repeat(7, [1, 1] as [number, number]))]),
            "cost",
            "usd_per_component",
        );
        expect([ties?.verdict, ties?.difference]).toEqual(["descriptive", 0]);
        const tripled = metric(
            evaluate([runs("hangs", repeat(9, [2, 6] as [number, number]))]),
            "dependability",
            "hangs",
        );
        expect([tripled?.method, tripled?.difference]).toEqual([
            "one-sided paired sign test with run as unit",
            4,
        ]);
        expect([tripled?.verdict, tripled?.passed]).toEqual(["worse", false]);
        const latency = metric(
            evaluate([
                runs("turn_latency_p95_delta_ms", repeat(6, [100, 140] as [number, number])),
            ]),
            "latency",
            "turn_latency_p95_delta_ms",
        );
        expect([latency?.verdict, latency?.passed]).toEqual(["worse", true]);
    });

    test("bounds pass or fail per run, and no output carries the word parity", () => {
        const s = (observations: Observation[]) =>
            evaluateTier(S, {
                observations,
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            });
        const ok = s([runs("internal_string_hits", repeat(2, [0, 0] as [number, number]))]);
        const intr = ok.families.find((f) => f.family === "intrusiveness")?.metrics[0];
        expect([intr?.verdict, intr?.passed]).toEqual(["within-bound", true]);
        const bad = s([
            runs("internal_string_hits", [
                [0, 0],
                [0, 2],
            ]),
        ]);
        expect(bad.families.find((f) => f.family === "intrusiveness")?.metrics[0]?.verdict).toBe(
            "failed-gate(internal_string_hits, r-1)",
        );
        const p8 = s([
            binary("P8.cross_session_pass_rate", [
                ...repeat(9, [0, 1] as [number, number]),
                [0, 0],
            ]),
        ]);
        expect(p8.families.find((f) => f.family === "probe-P8")?.passed).toBe(true);
        for (const v of [ok, bad, p8])
            expect(JSON.stringify(v).toLowerCase()).not.toContain("parity");
    });

    test("the falsification set reports a zero effect only where the paired interval covers zero", () => {
        const noise = [0.1, -0.2, 0, 0.15, -0.1, 0.05, -0.05, 0.2, -0.15, 0];
        const out = falsificationSet(S, {
            pre_divergence_pushback_rate: noise.map((d) => ({
                control: 0.45,
                treatment: 0.45 + d,
            })),
            gateway_4xx_rate_without_faults: noise.map((d) => ({ control: 0, treatment: 0.5 + d })),
        });
        const by = Object.fromEntries(out.map((z) => [z.check, z.zero_effect]));
        expect(by).toEqual({
            in_session_repo_readable_fact_pass: null,
            gateway_4xx_rate_without_faults: false,
            pre_divergence_pushback_rate: true,
            wall_ms_per_scripted_idle_gap: null,
        });
        expect(() => falsificationSet(S, { tokens: [] })).toThrow(
            "tokens is not in the falsification set",
        );
    });

    test("pairs join by item id across arms in issue order, whatever order each arm graded them in", () => {
        const host = new Map([
            ["q-10", 0],
            ["q-2", 1],
            ["q-3", 0],
        ]);
        const mem = new Map([
            ["q-3", 1],
            ["q-2", 1],
            ["q-10", 1],
            ["q-4", 1],
        ]);
        const issued = ["q-2", "q-3", "q-10"];
        const pairs = pairByItem(
            host,
            mem,
            (q) => `f-${q}`,
            (q) => issued.indexOf(q),
        );
        expect(pairs.map((x) => [x.item, x.control, x.treatment, x.order])).toEqual([
            ["q-2", 1, 1, 0],
            ["q-3", 0, 1, 1],
            ["q-10", 0, 1, 2],
        ]);
    });

    test("items of one ledger fact resample together, so shared facts widen the binary interval", () => {
        const pairs: [number, number][] = Array.from({ length: 24 }, (_, i) =>
            i % 3 === 0 ? [0, 1] : [0, 0],
        );
        const own = binary("P1.pass", pairs);
        const shared = {
            ...own,
            items: own.items?.map((x, i) => ({
                ...x,
                item: `${x.item}s`,
                cluster: i % 3 === 0 ? "f-a" : `f-${i}`,
            })),
        };
        const width = (o: Observation) => {
            const m = metric(evaluate([o]), "probe-P1", "P1.pass");
            return (m?.interval?.[1] ?? 0) - (m?.interval?.[0] ?? 0);
        };
        expect(width(shared)).toBeGreaterThan(width(own));
    });
});

describe("tier gate review findings", () => {
    const seq = { journal_seq_at_eval: 7, arms: { control: "host", treatment: "eidnara" } };
    const bounds = (overrides: Partial<Record<string, Observation>> = {}) => {
        const zero: [number, number] = [0, 0];
        const base: Record<string, Observation> = {
            P1: binary("P1.pass", repeat(10, [1, 1] as [number, number])),
            harm: binary("P2.harm", repeat(10, [0, 0] as [number, number])),
            P8: binary("P8.cross_session_pass_rate", repeat(10, [1, 1] as [number, number])),
            P9: binary("P9.cross_session_pass_rate", repeat(10, [1, 1] as [number, number])),
            failed_turns: runs("failed_turns", repeat(2, zero)),
            hangs: runs("hangs", repeat(2, zero)),
            latency: runs("turn_latency_p95_delta_ms", repeat(2, [100, 120] as [number, number])),
            rss: runs(
                "daemon_rss_growth_bytes_per_session",
                repeat(2, [1000, 2000] as [number, number]),
            ),
            heap: runs(
                "daemon_heap_growth_bytes_per_session",
                repeat(2, [1000, 2000] as [number, number]),
            ),
            store: runs(
                "store_growth_bytes_per_session",
                repeat(2, [1000, 2000] as [number, number]),
            ),
            hits: runs("internal_string_hits", repeat(2, zero)),
            corrections: runs("user_corrections_referencing_injected_text", repeat(2, zero)),
            reverted: runs("reverted_memory_edits", repeat(2, zero)),
        };
        return Object.values({ ...base, ...overrides }).filter((o): o is Observation => !!o);
    };

    test("a graded pp-scale metric reports proportions in percentage points", () => {
        const scores: [number, number][] = [
            [0.6667, 0.8667],
            [0.3333, 0.5333],
            [1, 1],
            [0.6667, 0.8667],
            [0.3333, 0.5333],
            [0.6667, 0.8667],
        ];
        const m = metric(
            evaluate([runs("P13.fold_fidelity_score", scores)], seq),
            "probe-P13",
            "P13.fold_fidelity_score",
        );
        expect(m?.difference).toBeCloseTo(16.6667, 4);
        expect(m?.interval?.[0]).toBeGreaterThan(1);
        expect(m?.detectable).toBeCloseTo(9.3386, 4);
        expect(m?.resolution_ratio).toBeCloseTo(9.3386, 4);
    });

    test("an observation carrying the wrong collection for its unit, or a non-finite value, is refused", () => {
        const s = (observations: Observation[]) =>
            evaluateTier(S, { observations, excluded: [], asymmetric: [], ...seq });
        const miswired: Observation = {
            metric: "P8.cross_session_pass_rate",
            unit: "item",
            cluster_key: "ledger_fact_id",
            runs: [{ run: "r-0", control: 0, treatment: 0 }],
        };
        expect(() => s([miswired])).toThrow(StatsRefusal);
        const both: Observation = { ...binary("P8.cross_session_pass_rate", [[1, 1]]), runs: [] };
        expect(() => s([both])).toThrow(StatsRefusal);
        const nan = runs("internal_string_hits", [[0, Number.NaN]]);
        expect(() => s([nan])).toThrow(StatsRefusal);
        const inf = binary("P8.cross_session_pass_rate", [[1, Number.POSITIVE_INFINITY]]);
        expect(() => s([inf])).toThrow(StatsRefusal);
    });

    test("a family's registered run floor above six governs insufficient-runs", () => {
        const eight = {
            ...M,
            families: M.families.map((f) =>
                f.id === "dependability" ? { ...f, min_paired_runs: 8 } : f,
            ),
        };
        const v = evaluateTier(eight, {
            observations: [runs("failed_turns", repeat(6, [0, 3] as [number, number]))],
            excluded: [],
            asymmetric: [],
            ...seq,
        });
        const m = metric(v, "dependability", "failed_turns");
        expect([m?.verdict, m?.passed]).toEqual(["insufficient-runs(6)", false]);
    });

    test("a tier passes only when every CUSUM rule was evaluated", () => {
        const s = (extra: object) =>
            evaluateTier(S, {
                observations: bounds(),
                excluded: [],
                asymmetric: [],
                ...seq,
                ...extra,
            });
        const withSd = s({ cusum_sd: { harm: 0.5, futility: 0.5 } });
        expect([withSd.pass.passed, withSd.cusum_unavailable, withSd.stops]).toEqual([
            true,
            [],
            [],
        ]);
        const noSd = s({});
        expect(noSd.families.filter((f) => f.claim === "gate").every((f) => f.passed)).toBe(true);
        expect(noSd.cusum_unavailable.length).toBe(2);
        expect(noSd.pass.passed).toBe(false);
        expect(noSd.pass.rule).toContain("evaluated");
    });

    test("the journal sequence is required and must be a non-negative integer", () => {
        const input = {
            observations: [],
            excluded: [],
            asymmetric: [],
            arms: { control: "host", treatment: "eidnara" },
        };
        expect(() =>
            evaluateTier(M, { ...input, journal_seq_at_eval: undefined as unknown as number }),
        ).toThrow(StatsRefusal);
        expect(() => evaluateTier(M, { ...input, journal_seq_at_eval: -1 })).toThrow(StatsRefusal);
        expect(() => evaluateTier(M, { ...input, journal_seq_at_eval: 1.5 })).toThrow(StatsRefusal);
        expect(evaluateTier(M, { ...input, journal_seq_at_eval: 0 }).journal_seq_at_eval).toBe(0);
    });

    test("zero treatment events keep the Clopper-Pearson ratio bound; no events in either arm leave no bound", () => {
        const oneHost = metric(
            evaluate(
                [runs("failed_turns", [[1, 0], ...repeat(5, [0, 0] as [number, number])])],
                seq,
            ),
            "dependability",
            "failed_turns",
        );
        expect(oneHost?.rate_ratio_upper).toBeCloseTo(0.985 / 0.015, 3);
        expect(oneHost?.passed).toBe(false);
        const fiveHost = metric(
            evaluate(
                [runs("failed_turns", [...repeat(5, [1, 0] as [number, number]), [0, 0]])],
                seq,
            ),
            "dependability",
            "failed_turns",
        );
        expect(fiveHost?.rate_ratio_upper).toBeLessThan(1.5);
        expect(fiveHost?.passed).toBe(true);
        const none = metric(
            evaluate([runs("hangs", repeat(6, [0, 0] as [number, number]))], seq),
            "dependability",
            "hangs",
        );
        expect([none?.rate_ratio_upper, none?.passed]).toEqual([undefined, true]);
    });
});

describe("tier gate review findings, second round", () => {
    const seq = { journal_seq_at_eval: 7 };
    const arms = { control: "host", treatment: "eidnara" };
    const s = (observations: Observation[], extra: object = {}) =>
        evaluateTier(S, { observations, excluded: [], asymmetric: [], ...seq, arms, ...extra });

    test("a CUSUM standard deviation that is not finite and positive is refused", () => {
        const ok = s([], { cusum_sd: { harm: 0.5, futility: 0.5 } });
        expect(ok.cusum_unavailable).toEqual([
            "harm: no items for harm",
            "futility: no items for probe-P1",
        ]);
        for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
            expect(() => s([], { cusum_sd: { harm: bad, futility: 0.5 } })).toThrow(StatsRefusal);
        }
    });

    test("a repeated run or item identity within an observation is refused", () => {
        const same: Observation = {
            metric: "failed_turns",
            unit: "run",
            cluster_key: "run",
            runs: repeat(6, { run: "same", control: 5, treatment: 0 }),
        };
        expect(() => evaluate([same], { arms })).toThrow(StatsRefusal);
        const twin = binary("P1.pass", [
            [0, 1],
            [0, 1],
        ]);
        twin.items = twin.items?.map((x) => ({ ...x, item: "dup" }));
        expect(() => evaluate([twin], { arms })).toThrow(StatsRefusal);
    });

    test("a binary family's values are 0 or 1", () => {
        expect(() =>
            evaluate([binary("P1.pass", repeat(5, [2, 2] as [number, number]))], { arms }),
        ).toThrow(StatsRefusal);
        expect(() => evaluate([binary("P1.pass", [[0, 0.5]])], { arms })).toThrow(StatsRefusal);
    });

    test("a non-finite falsification pair is refused", () => {
        expect(() =>
            falsificationSet(S, {
                pre_divergence_pushback_rate: [
                    { control: 0.4, treatment: Number.NaN },
                    { control: 0.4, treatment: 0.5 },
                ],
            }),
        ).toThrow(StatsRefusal);
    });

    test("a failed item threshold names the failing items", () => {
        const obs = binary("P8.cross_session_pass_rate", [
            ...repeat(8, [1, 1] as [number, number]),
            [1, 0],
            [1, 0],
        ]);
        const failing = (obs.items ?? []).filter((x) => x.treatment === 0).map((x) => x.item);
        const m = s([obs]).families.find((f) => f.family === "probe-P8")?.metrics[0];
        expect(m?.verdict).toBe(`failed-gate(P8.cross_session_pass_rate, ${failing.join(" ")})`);
    });

    test("the compared arms are required, match the registered comparison, and sit in the verdict", () => {
        const input = { observations: [], excluded: [], asymmetric: [], ...seq };
        expect(() =>
            evaluateTier(M, { ...input, arms: undefined as unknown as typeof arms }),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluateTier(M, { ...input, arms: { control: "eidnara", treatment: "host" } }),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluateTier(M, { ...input, arms: { control: "host", treatment: "eidnara-kl" } }),
        ).toThrow(StatsRefusal);
        expect(evaluateTier(M, { ...input, arms }).arms).toEqual(arms);
    });

    test("a run-level family's metrics come from one set of runs", () => {
        const a = runs("failed_turns", repeat(6, [5, 0] as [number, number]));
        const b: Observation = {
            ...runs("hangs", repeat(6, [5, 0] as [number, number])),
            runs: repeat(6, [5, 0] as [number, number]).map(([control, treatment], i) => ({
                run: `b-${i}`,
                control,
                treatment,
            })),
        };
        expect(() => evaluate([a, b], { arms })).toThrow(StatsRefusal);
        const harm = ["P2.harm", "P3.harm"].map((h) =>
            binary(h, repeat(10, [0, 0] as [number, number])),
        );
        expect(() => evaluate(harm, { arms })).not.toThrow();
    });

    test("binary items from a single ledger fact are inconclusive", () => {
        const one = binary("P1.pass", repeat(40, [0, 1] as [number, number]), () => "f-only");
        const m = metric(evaluate([one], { arms }), "probe-P1", "P1.pass");
        expect([m?.n, m?.verdict, m?.passed, m?.interval]).toEqual([
            40,
            "inconclusive",
            false,
            null,
        ]);
        expect(m?.resolution_note).toContain("cluster");
        const two = binary("P1.pass", repeat(40, [0, 1] as [number, number]), (i) =>
            i % 2 ? "f-a" : "f-b",
        );
        expect(metric(evaluate([two], { arms }), "probe-P1", "P1.pass")?.verdict).toBe("better");
    });
});

describe("tier gate review findings, Kilo round", () => {
    const seq = { journal_seq_at_eval: 7, arms: { control: "host", treatment: "eidnara" } };
    const L = loadPrereg("L");

    test("an at-most family with a zero MDE scales its resolution against the margin", () => {
        const slopes = runs(
            "daemon_rss_growth_bytes_per_session",
            Array.from({ length: 6 }, (_, i): [number, number] => [
                1e6 + i * 1e5,
                1.5e6 + i * 1.2e5,
            ]),
        );
        const v = evaluateTier(L, { observations: [slopes], excluded: [], asymmetric: [], ...seq });
        const m = metric(v, "resources", "daemon_rss_growth_bytes_per_session");
        expect(m?.detectable).toBeGreaterThan(0);
        expect(m?.resolution_ratio).toBeCloseTo((m?.detectable ?? 0) / 8388608, 12);
    });

    test("a count family refuses a negative value", () => {
        expect(() =>
            evaluate([runs("failed_turns", [[1, -1], ...repeat(5, [0, 0] as [number, number])])]),
        ).toThrow(StatsRefusal);
    });

    test("an item's issue order is a non-negative integer, in the input and from pairByItem", () => {
        const obs = binary("P1.pass", [[0, 1]]);
        obs.items = obs.items?.map((x) => ({ ...x, order: Number.NaN }));
        expect(() => evaluate([obs])).toThrow(StatsRefusal);
        const arm = new Map([["q-1", 1]]);
        expect(() =>
            pairByItem(
                arm,
                arm,
                () => "f",
                () => -1,
            ),
        ).toThrow(StatsRefusal);
    });

    test("a CUSUM rule with no items is unavailable, so the tier gets no pass", () => {
        const s = (observations: Observation[]) =>
            evaluateTier(S, {
                observations,
                excluded: [],
                asymmetric: [],
                ...seq,
                cusum_sd: { harm: 0.5, futility: 0.5 },
            });
        const v = s([runs("internal_string_hits", repeat(2, [0, 0] as [number, number]))]);
        expect(v.cusum_unavailable).toEqual([
            "harm: no items for harm",
            "futility: no items for probe-P1",
        ]);
        expect(v.pass.passed).toBe(false);
    });

    test("an id repeated in excluded, or in both excluded and asymmetric, is refused", () => {
        const obs = binary("P1.pass", repeat(4, [0, 1] as [number, number]));
        const [a, b] = obs.items?.map((x) => x.item) ?? [];
        const drop = (id: string) => ({ id, arm: "eidnara", reason: "failed(interrupted)" });
        expect(() => evaluate([obs], { excluded: [drop(a ?? ""), drop(a ?? "")] })).toThrow(
            StatsRefusal,
        );
        expect(() => evaluate([obs], { excluded: [drop(b ?? "")], asymmetric: [b] })).toThrow(
            StatsRefusal,
        );
        expect(() => evaluate([obs], { asymmetric: [a, a] })).toThrow(StatsRefusal);
    });

    test("the harm CUSUM takes the per-item maximum over the harm metrics in issue order", () => {
        const start = order;
        const quiet: [number, number][] = repeat(10, [0, 0] as [number, number]);
        const p2 = binary("P2.harm", [...quiet, ...repeat(8, [0, 0] as [number, number])]);
        const ids = p2.items?.map((x) => x.item) ?? [];
        const withHarm = (o: Observation, hit: (i: number) => boolean): Observation => ({
            ...o,
            items: [...(o.items ?? [])]
                .map((x, i) => ({ ...x, treatment: hit(i) ? 1 : 0 }))
                .reverse(),
        });
        const even = withHarm(p2, (i) => i >= 10 && (i % 2 === 0 || i === 11));
        const odd = withHarm({ ...p2, metric: "P3.harm" }, (i) => i >= 10 && i % 2 === 1);
        const v = evaluate([even, odd], { cusum_sd: { harm: 0.5, futility: 0.5 } });
        expect(ids[0]).toBe(`q-${start}`);
        expect(v.stops.map((s) => [s.kind, s.metric, s.signal_index])).toEqual([
            ["harm", "harm", 12],
        ]);
        expect(v.stops[0]?.window).toEqual(ids.slice(10, 13));
    });
});

describe("tier gate review findings, third Codex round", () => {
    test("distinct items carry distinct issue orders and one item carries one order", () => {
        const a = binary("P2.harm", [[0, 0]]);
        const b = binary("P3.harm", [[0, 0]]);
        b.items = b.items?.map((x) => ({ ...x, order: a.items?.[0]?.order ?? 0 }));
        expect(() => evaluate([a, b])).toThrow(StatsRefusal);
        const twice = binary("P2.harm", [
            [0, 0],
            [0, 0],
        ]);
        const first = twice.items?.[0]?.order ?? 0;
        twice.items = twice.items?.map((x) => ({ ...x, order: first }));
        expect(() => evaluate([twice])).toThrow(StatsRefusal);
    });

    test("a bootstrap plan below eval-core's replicate floor is refused", () => {
        const thin = { ...M, bootstrap: { ...M.bootstrap, replicates: 39 } };
        const scores = runs(
            "P13.fold_fidelity_score",
            Array.from({ length: 6 }, (_, i): [number, number] => [0, 0.1 * (i + 1)]),
        );
        expect(() =>
            evaluateTier(thin, {
                observations: [scores],
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            }),
        ).toThrow("bootstrap.replicates 39 is below the floor of 40");
    });

    test("the verdict records each CUSUM rule's registered source and the deviation it used", () => {
        const v = evaluate([binary("P1.pass", repeat(3, [1, 1] as [number, number]))], {
            cusum_sd: { futility: 0.25 },
        });
        expect(v.cusum_rules).toEqual([
            { kind: "harm", metric: "harm", sd_source: "this tier's A/A pairs", sd: null },
            { kind: "futility", metric: "probe-P1", sd_source: "this tier's A/A pairs", sd: 0.25 },
        ]);
    });

    test("an unbounded rate ratio survives serialization", () => {
        const m = metric(
            evaluate([runs("failed_turns", repeat(6, [0, 1] as [number, number]))]),
            "dependability",
            "failed_turns",
        );
        expect([m?.rate_ratio_upper, m?.passed]).toEqual(["unbounded", false]);
        expect(JSON.parse(JSON.stringify(m)).rate_ratio_upper).toBe("unbounded");
    });
});

describe("tier gate review findings, fourth Codex round", () => {
    test("an exclusion names one of the compared arms", () => {
        const obs = binary("P1.pass", repeat(3, [0, 1] as [number, number]));
        const id = obs.items?.[0]?.item ?? "";
        const drop = (arm: string) => [{ id, arm, reason: "failed(interrupted)" }];
        expect(() => evaluate([obs], { excluded: drop("eidnrara") })).toThrow(StatsRefusal);
        expect(() => evaluate([obs], { excluded: drop("eidnara-kl") })).toThrow(StatsRefusal);
        expect(evaluate([obs], { excluded: drop("host") }).excluded_per_arm).toEqual({
            host: 1,
            eidnara: 0,
        });
    });
});

describe("tier gate review findings, fifth Codex round", () => {
    test("a pp-scale graded value is a proportion", () => {
        expect(() =>
            evaluate([runs("P13.fold_fidelity_score", repeat(6, [2, 3] as [number, number]))]),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluate([runs("P13.fold_fidelity_score", repeat(6, [0.2, -0.1] as [number, number]))]),
        ).toThrow(StatsRefusal);
    });

    test("the falsification set keeps the bootstrap floor and finite-interval guard", () => {
        const thin = { ...S, bootstrap: { ...S.bootstrap, replicates: 39 } };
        const pairs = Array.from({ length: 6 }, (_, i) => ({
            control: 0,
            treatment: 0.1 * (i + 1),
        }));
        expect(() => falsificationSet(thin, { pre_divergence_pushback_rate: pairs })).toThrow(
            "bootstrap.replicates 39 is below the floor of 40",
        );
    });

    test("an item repeated across metrics keeps one ledger-fact cluster", () => {
        const pass = binary("P2.pass", repeat(4, [0, 1] as [number, number]), () => "f-one");
        const harm: Observation = {
            ...pass,
            metric: "P2.harm",
            items: pass.items?.map((x, i) => ({ ...x, treatment: 0, cluster: `f-${i}` })),
        };
        expect(() => evaluate([pass, harm])).toThrow(StatsRefusal);
        const same: Observation = {
            ...harm,
            items: harm.items?.map((x) => ({ ...x, cluster: "f-one" })),
        };
        expect(() => evaluate([pass, same])).not.toThrow();
    });

    test("a family registered without an interval method reports a descriptive difference only", () => {
        const m = metric(
            evaluate([runs("usd_per_component", repeat(7, [1, 1.5] as [number, number]))]),
            "cost",
            "usd_per_component",
        );
        expect([m?.verdict, m?.passed, m?.n, m?.difference]).toEqual(["descriptive", null, 7, 0.5]);
        expect([m?.interval, m?.p, m?.detectable, m?.resolution_ratio]).toEqual([
            null,
            null,
            null,
            null,
        ]);
        expect(m?.method).toContain("no interval");
        const XL = loadPrereg("XL");
        const v = evaluateTier(XL, {
            observations: [runs("turn_latency_p95_delta_ms", [[0, 40]])],
            excluded: [],
            asymmetric: [],
            journal_seq_at_eval: 1,
            arms: { control: "host", treatment: XL.arms.default },
        });
        expect(metric(v, "latency", "turn_latency_p95_delta_ms")?.verdict).toBe("descriptive");
    });
});

describe("tier gate review findings, sixth Codex round", () => {
    test("an event count is an integer; a cost is any non-negative amount", () => {
        expect(() =>
            evaluate([runs("failed_turns", repeat(6, [1.5, 0] as [number, number]))]),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluate([runs("internal_string_hits", repeat(6, [0, 0.5] as [number, number]))]),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluate([runs("usd_per_component", repeat(6, [1.25, 1.5] as [number, number]))]),
        ).not.toThrow();
    });

    test("falsification values stay in their measurement domain", () => {
        const rate = Array.from({ length: 4 }, () => ({ control: 2, treatment: 3 }));
        expect(() => falsificationSet(S, { gateway_4xx_rate_without_faults: rate })).toThrow(
            StatsRefusal,
        );
        const negative = Array.from({ length: 4 }, () => ({ control: -5, treatment: 10 }));
        expect(() => falsificationSet(S, { wall_ms_per_scripted_idle_gap: negative })).toThrow(
            StatsRefusal,
        );
        const fine = Array.from({ length: 4 }, (_, i) => ({ control: 100, treatment: 100 + i }));
        expect(() => falsificationSet(S, { wall_ms_per_scripted_idle_gap: fine })).not.toThrow();
    });
});

describe("tier gate review findings, seventh Codex round", () => {
    test("a metric registered in two families is refused", () => {
        const twice = {
            ...M,
            families: M.families.map((f) =>
                f.id === "probe-P2" ? { ...f, metrics: ["P2.pass", "P1.pass"] } : f,
            ),
        };
        expect(() =>
            evaluateTier(twice, {
                observations: [],
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            }),
        ).toThrow("P1.pass is registered in two families");
    });

    test("one paired item may be excluded once per arm", () => {
        const obs = binary("P1.pass", repeat(4, [0, 1] as [number, number]));
        const [a, b] = obs.items?.map((x) => x.item) ?? [];
        const drop = (id: string, arm: string) => ({ id, arm, reason: "failed(interrupted)" });
        const v = evaluate([obs], { excluded: [drop(a ?? "", "host"), drop(a ?? "", "eidnara")] });
        expect(v.excluded_per_arm).toEqual({ host: 1, eidnara: 1 });
        expect(metric(v, "probe-P1", "P1.pass")?.n).toBe(3);
        expect(() =>
            evaluate([obs], { excluded: [drop(b ?? "", "host"), drop(b ?? "", "host")] }),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluate([obs], { excluded: [drop(b ?? "", "host")], asymmetric: [b] }),
        ).toThrow(StatsRefusal);
    });

    test("a Holm family's detectable size uses the first-step one-sided alpha", () => {
        const half: [number, number][] = Array.from({ length: 120 }, (_, i) =>
            i < 15 ? [0, 1] : i < 30 ? [1, 0] : [0, 0],
        );
        const m = metric(evaluate([binary("P2.harm", half)]), "harm", "P2.harm");
        expect(m?.detectable).toBeCloseTo(9.93, 2);
        expect(m?.resolution_ratio).toBeCloseTo(0.993, 3);
    });
});

describe("tier gate review findings, eighth Codex round", () => {
    test("excluded_per_arm names both compared arms, zero included", () => {
        const obs = binary("P1.pass", repeat(3, [0, 1] as [number, number]));
        const id = obs.items?.[0]?.item ?? "";
        expect(evaluate([obs]).excluded_per_arm).toEqual({ host: 0, eidnara: 0 });
        const one = evaluate([obs], {
            excluded: [{ id, arm: "host", reason: "failed(interrupted)" }],
        });
        expect(one.excluded_per_arm).toEqual({ host: 1, eidnara: 0 });
    });

    test("an event count is a safe integer", () => {
        expect(() =>
            evaluate([runs("failed_turns", repeat(6, [1e308, 1e308] as [number, number]))]),
        ).toThrow(StatsRefusal);
        expect(() =>
            evaluate([runs("hangs", repeat(6, [2 ** 53, 0] as [number, number]))]),
        ).toThrow(StatsRefusal);
    });

    test("the verdict holds copies of the evidence it was given", () => {
        const obs = binary("P1.pass", repeat(3, [0, 1] as [number, number]));
        const excluded = [
            { id: obs.items?.[0]?.item ?? "", arm: "host", reason: "failed(interrupted)" },
        ];
        const asymmetric = [obs.items?.[1]?.item ?? ""];
        const arms = { control: "host", treatment: "eidnara" };
        const v = evaluate([obs], { excluded, asymmetric, arms });
        excluded.pop();
        asymmetric.pop();
        arms.treatment = "eidnara-kl";
        expect([v.excluded.length, v.asymmetric_stratum.length, v.arms.treatment]).toEqual([
            1,
            1,
            "eidnara",
        ]);
        const fam = v.families.find((f) => f.family === "probe-P1");
        expect(fam?.mde).not.toBe(M.families.find((f) => f.id === "probe-P1")?.mde);
    });

    test("a descriptive difference that overflows is refused", () => {
        expect(() =>
            evaluate([runs("usd_per_component", repeat(6, [0, 1e308] as [number, number]))]),
        ).toThrow(StatsRefusal);
    });
});

describe("tier gate review findings, ninth Codex round", () => {
    const seq = { journal_seq_at_eval: 7, arms: { control: "host", treatment: "eidnara" } };

    test("event totals stay exact", () => {
        const big = Number.MAX_SAFE_INTEGER;
        expect(() =>
            evaluate([runs("failed_turns", repeat(6, [big, big] as [number, number]))]),
        ).toThrow(StatsRefusal);
    });

    test("a detectable size that overflows is refused", () => {
        const L = loadPrereg("L");
        const wild = runs(
            "daemon_rss_growth_bytes_per_session",
            Array.from({ length: 10 }, (_, i): [number, number] => [0, i % 2 ? 1e200 : -1e200]),
        );
        expect(() =>
            evaluateTier(L, { observations: [wild], excluded: [], asymmetric: [], ...seq }),
        ).toThrow(StatsRefusal);
    });

    test("an item-level family is binary", () => {
        const counted = {
            ...M,
            families: M.families.map((f) =>
                f.id === "probe-P1" ? { ...f, outcome: "count" as const } : f,
            ),
        };
        expect(() =>
            evaluateTier(counted, {
                observations: [binary("P1.pass", [[2, 3]])],
                excluded: [],
                asymmetric: [],
                ...seq,
            }),
        ).toThrow("probe-P1: an item-level family has a binary outcome");
    });
});

describe("tier gate review findings, tenth Codex round", () => {
    const seq = { journal_seq_at_eval: 7, arms: { control: "host", treatment: "eidnara" } };
    const s = (observations: Observation[], extra: object = {}) =>
        evaluateTier(S, { observations, excluded: [], asymmetric: [], ...seq, ...extra });

    test("a family's interval method matches its unit, outcome, and claim", () => {
        const rewire = (id: string, patch: object) => ({
            ...M,
            families: M.families.map((f) => (f.id === id ? { ...f, ...patch } : f)),
        });
        const input = { observations: [], excluded: [], asymmetric: [], ...seq };
        expect(() =>
            evaluateTier(rewire("probe-P1", { interval_method: "paired-sign-test" }), input),
        ).toThrow("probe-P1: paired-sign-test is not a method for item binary");
        expect(() => evaluateTier(rewire("probe-P1", { interval_method: "none" }), input)).toThrow(
            "probe-P1: a gate with a paired claim names an interval method",
        );
        expect(() =>
            evaluateTier(rewire("resources", { interval_method: "paired-bca-bootstrap" }), input),
        ).toThrow("resources: a bound family has no interval method");
    });

    test("the journal sequence is a safe integer", () => {
        expect(() => evaluate([], { journal_seq_at_eval: 2 ** 53 })).toThrow(StatsRefusal);
    });

    test("item, cluster, and run identifiers are non-blank strings", () => {
        const obs = binary("P1.pass", [[0, 1]]);
        const objCluster = {
            ...obs,
            items: obs.items?.map((x) => ({ ...x, cluster: {} as unknown as string })),
        };
        expect(() => evaluate([objCluster])).toThrow(StatsRefusal);
        const blankItem = { ...obs, items: obs.items?.map((x) => ({ ...x, item: " " })) };
        expect(() => evaluate([blankItem])).toThrow(StatsRefusal);
        const blankRun = runs("failed_turns", [[0, 0]]);
        blankRun.runs = blankRun.runs?.map((r) => ({ ...r, run: "" }));
        expect(() => evaluate([blankRun])).toThrow(StatsRefusal);
    });

    test("failed exclusions are counted in the arm's failed turns", () => {
        const obs = binary("P8.cross_session_pass_rate", repeat(4, [1, 1] as [number, number]));
        const id = obs.items?.[0]?.item ?? "";
        const failed = [{ id, arm: "eidnara", reason: "failed(interrupted)" }];
        const zeros = runs("failed_turns", repeat(2, [0, 0] as [number, number]));
        expect(() => s([obs, zeros], { excluded: failed })).toThrow(StatsRefusal);
        const one = runs("failed_turns", [
            [0, 1],
            [0, 0],
        ]);
        expect(() => s([obs, one], { excluded: failed })).not.toThrow();
    });

    test("an exclusion carries a non-blank reason", () => {
        const obs = binary("P1.pass", repeat(3, [0, 1] as [number, number]));
        const id = obs.items?.[0]?.item ?? "";
        expect(() => evaluate([obs], { excluded: [{ id, arm: "host", reason: "" }] })).toThrow(
            StatsRefusal,
        );
        expect(() =>
            evaluate([obs], {
                excluded: [{ id, arm: "host", reason: undefined as unknown as string }],
            }),
        ).toThrow(StatsRefusal);
    });
});

describe("tier gate review findings, eleventh Codex round", () => {
    test("run sets compare by membership, whatever the identifiers contain", () => {
        const a: Observation = {
            metric: "failed_turns",
            unit: "run",
            cluster_key: "run",
            runs: [
                { run: "a\nb", control: 0, treatment: 0 },
                { run: "c", control: 0, treatment: 0 },
            ],
        };
        const b: Observation = {
            metric: "hangs",
            unit: "run",
            cluster_key: "run",
            runs: ["a", "b", "c"].map((run) => ({ run, control: 0, treatment: 0 })),
        };
        expect(() => evaluate([a, b])).toThrow(StatsRefusal);
    });

    test("a collection that is not an array of pairs is refused", () => {
        const bad = { ...binary("P1.pass", [[0, 1]]), items: {} as unknown as ItemPair[] };
        expect(() => evaluate([bad])).toThrow(StatsRefusal);
        const holes = { ...binary("P1.pass", [[0, 1]]), items: [null as unknown as ItemPair] };
        expect(() => evaluate([holes])).toThrow(StatsRefusal);
    });

    test("a binary threshold lies in [0, 1]", () => {
        const high = {
            ...S,
            families: S.families.map((f) =>
                f.id === "probe-P8"
                    ? { ...f, margin: { value: "1.1", scale: "ratio" as const } }
                    : f,
            ),
        };
        expect(() =>
            evaluateTier(high, {
                observations: [
                    binary("P8.cross_session_pass_rate", repeat(4, [1, 1] as [number, number])),
                ],
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            }),
        ).toThrow("probe-P8: a binary threshold lies in [0, 1]");
    });

    test("a single graded run keeps its observed difference", () => {
        const XL = loadPrereg("XL");
        const v = evaluateTier(XL, {
            observations: [runs("P13.fold_fidelity_score", [[0.2, 0.8]])],
            excluded: [],
            asymmetric: [],
            journal_seq_at_eval: 1,
            arms: { control: "host", treatment: XL.arms.default },
        });
        const m = metric(v, "probe-P13", "P13.fold_fidelity_score");
        expect([m?.n, m?.interval]).toEqual([1, null]);
        expect(m?.difference).toBeCloseTo(60, 9);
    });
});

describe("tier gate review findings, twelfth Codex round", () => {
    test("a count family uses the method it registered at any run count", () => {
        const many: [number, number][] = Array.from({ length: 12 }, (_, i) => [
            2 + (i % 3),
            2 + ((i + 1) % 3),
        ]);
        const sign = metric(evaluate([runs("hangs", many)]), "dependability", "hangs");
        expect(sign?.method).toBe("one-sided paired sign test with run as unit");
        const glmPrereg = {
            ...M,
            families: M.families.map((f) =>
                f.id === "dependability"
                    ? { ...f, interval_method: "negative-binomial-glm" as const }
                    : f,
            ),
        };
        const fit = metric(
            evaluateTier(glmPrereg, {
                observations: [runs("hangs", many)],
                excluded: [],
                asymmetric: [],
                journal_seq_at_eval: 7,
                arms: { control: "host", treatment: "eidnara" },
            }),
            "dependability",
            "hangs",
        );
        expect(fit?.method).toStartWith("negative-binomial GLM");
    });

    test("the combined event total stays exact", () => {
        const perRun = 750599937895083;
        expect(Number.isSafeInteger(6 * perRun)).toBe(true);
        expect(Number.isSafeInteger(12 * perRun)).toBe(false);
        expect(() =>
            evaluate([runs("failed_turns", repeat(6, [perRun, perRun] as [number, number]))]),
        ).toThrow(StatsRefusal);
    });

    test("an issue order is a safe integer", () => {
        const obs = binary("P1.pass", [[0, 1]]);
        obs.items = obs.items?.map((x) => ({ ...x, order: 2 ** 53 }));
        expect(() => evaluate([obs])).toThrow(StatsRefusal);
    });
});
