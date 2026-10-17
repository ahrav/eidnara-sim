import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    binomialCdf,
    binomialPmf,
    digamma,
    incompleteBeta,
    normalCdf,
    normalQuantile,
} from "./dist";
import {
    acceleration,
    bootstrap,
    cusum,
    holm,
    mcnemarExact,
    negativeBinomial,
    newcombe,
    signTest,
} from "./tests";

const FIXTURES = join(import.meta.dir, "../../tests/fixtures/stats");
const ref = JSON.parse(readFileSync(join(FIXTURES, "references.json"), "utf8"));
const near = (got: number, want: number, tol: number) =>
    expect(Math.abs(got - want)).toBeLessThanOrEqual(tol);

describe("statistics against published references", () => {
    test("exact McNemar reproduces R exact2x2 on 150 and 86 discordant pairs", () => {
        const r = ref.mcnemar_exact;
        const m = mcnemarExact(r.b, r.c);
        near(m.p, r.p, 1e-8);
        near(m.odds_ratio, r.odds_ratio, r.tolerance);
        near(m.ci[0], r.ci[0], r.tolerance);
        near(m.ci[1], r.ci[1], r.tolerance);
    });

    test("the exact McNemar decision agrees with eval-core's integer tables, rejecting at p equal to alpha", () => {
        const r = ref.eval_core_mcnemar;
        for (const [b, c, reject] of r.cases as [number, number, boolean][]) {
            expect([b, c, mcnemarExact(b, c).p <= r.alpha]).toEqual([b, c, reject]);
        }
        const { b, c, rejects_at, keeps_at } = r.boundary;
        expect([mcnemarExact(b, c).p <= rejects_at, mcnemarExact(b, c).p <= keeps_at]).toEqual([
            true,
            false,
        ]);
    });

    test("the sign test and Newcombe's interval reproduce the Armitage and Berry media table", () => {
        const r = ref.paired_proportions;
        near(signTest(r.b, r.b + r.c), r.sign_test_p, 5e-5);
        const [lo, hi] = newcombe(r.a, r.b, r.c, r.d);
        near(lo, r.newcombe[0], r.tolerance);
        near(hi, r.newcombe[1], r.tolerance);
        expect(signTest(0, 0)).toBe(1);
    });

    test("Holm adjusts as R p.adjust does, in input order and monotone", () => {
        const r = ref.holm;
        holm(r.p).forEach((p, i) => {
            near(p, r.adjusted[i], 1e-12);
        });
        expect(holm([0.5, 0.001, 0.04, 0.2, 0.01])).toEqual([0.5, 0.005, 0.12, 0.4, 0.04]);
        expect(holm([0.04, 0.04])).toEqual([0.08, 0.08]);
        expect(holm([0.01, Number.NaN, 0.02])).toEqual([0.02, Number.NaN, 0.02]);
        expect(holm([0.01, 0.02, Number.NaN])).toEqual([0.02, 0.02, Number.NaN]);
    });

    test("the tabular CUSUM reproduces Hawkins's upward and downward sums and its signal", () => {
        const r = ref.cusum;
        const c = cusum(r.x, r.target, r.k, r.h, r.h / 2);
        c.upper.forEach((v, i) => {
            near(v, r.upper[i], r.tolerance);
        });
        c.lower.forEach((v, i) => {
            near(v, r.lower[i], r.tolerance);
        });
        expect((c.signal_upper ?? -1) + 1).toBe(r.signal_observation);
        expect(c.signal_lower).toBeNull();
        expect(cusum([1, 1, 1], 0, 2, 1).signal_upper).toBeNull();
        const down = cusum([-3, -3, -3], 0, 0.5, 4);
        expect([down.signal_upper, down.signal_lower]).toEqual([null, 1]);
    });

    test("BCa reproduces Efron and Tibshirani's spatial-variance acceleration and interval", () => {
        const r = ref.bca;
        const variance = (x: number[]) => {
            const m = x.reduce((s, t) => s + t, 0) / x.length;
            return x.reduce((s, t) => s + (t - m) ** 2, 0) / x.length;
        };
        near(acceleration(r.x, variance), r.acceleration, 5e-4);
        const b = bootstrap(r.x, variance, { replicates: 20_000, seed: 1, bca: true, alpha: 0.1 });
        near(b.estimate, r.estimate, 0.05);
        near(b.lo / r.interval_90[0], 1, r.interval_relative_tolerance);
        near(b.hi / r.interval_90[1], 1, r.interval_relative_tolerance);
        const pc = ref.percentile;
        const wide = bootstrap(r.x, variance, { replicates: 20_000, seed: 1, alpha: 0.1 });
        near(wide.lo / pc.interval_90[0], 1, pc.relative_tolerance);
        near(wide.hi / pc.interval_90[1], 1, pc.relative_tolerance);
        const p = bootstrap(r.x, variance, { replicates: 2_000, seed: 1, alpha: 0.1 });
        expect(p).toEqual(bootstrap(r.x, variance, { replicates: 2_000, seed: 1, alpha: 0.1 }));
        expect(p.lo).toBeLessThan(b.lo);
    });

    test("a bootstrap whose statistic is undefined on some resample reports NaN limits for every seed", () => {
        const undefinedOnTies = (s: number[]) =>
            new Set(s).size === 1 ? Number.NaN : s.reduce((a, b) => a + b, 0) / s.length;
        for (const seed of [2, 3]) {
            const b = bootstrap([0, 1], undefinedOnTies, { replicates: 20, seed });
            expect([b.estimate, b.lo, b.hi]).toEqual([0.5, Number.NaN, Number.NaN]);
        }
    });

    test("BCa stays finite when every replicate falls on one side of the estimate", () => {
        const xs = Array.from({ length: 12 }, (_, i) => i);
        const b = bootstrap(xs, (x) => new Set(x).size, { replicates: 2000, seed: 1, bca: true });
        expect(Number.isFinite(b.lo)).toBe(true);
        expect(Number.isFinite(b.hi)).toBe(true);
        expect(b.lo).toBeLessThanOrEqual(b.hi);
    });

    test("the negative-binomial GLM reproduces MASS glm.nb on the quine absences", () => {
        const r = ref.negative_binomial;
        const rows = readFileSync(join(FIXTURES, "quine.csv"), "utf8")
            .trim()
            .split("\n")
            .slice(1)
            .map((l) => l.split(","));
        const x = rows.map((c) => [
            1,
            Number(c[1] === "N"),
            Number(c[2] === "M"),
            Number(c[3] === "F1"),
            Number(c[3] === "F2"),
            Number(c[3] === "F3"),
            Number(c[4] === "SL"),
        ]);
        const fit = negativeBinomial(
            x,
            rows.map((c) => Number(c[5])),
        );
        Object.values(r.coefficients as Record<string, number>).forEach((want, i) => {
            near(fit.coefficients[i] as number, want, r.tolerance);
        });
        near(fit.theta, r.theta, r.tolerance);
        expect(fit.converged).toBe(true);
        const separated = negativeBinomial(
            [0, 1, 2, 3].flatMap(() => [
                [1, 0],
                [1, 1],
            ]),
            [3, 0, 2, 0, 6, 0, 4, 0],
        );
        expect(separated.converged).toBe(false);
        near(fit.coefficients[6] as number, r.lrn_sl.estimate, r.lrn_sl.tolerance);
        (r.standard_errors as number[]).forEach((want, i) => {
            near(fit.se[i] as number, want, 1e-4);
        });
    });

    test("the negative-binomial theta finds the overdispersed maximum of an intercept-only fit", () => {
        const fit = negativeBinomial([[1], [1], [1], [1]], [8, 3, 0, 0]);
        expect(fit.converged).toBe(true);
        near(fit.coefficients[0] as number, Math.log(2.75), 1e-6);
        near(fit.theta, 0.40095, 1e-4);
    });

    test("the negative-binomial fit reports a separated slope as unconverged even when theta hits its cap", () => {
        const fit = negativeBinomial(
            [
                [1, 0],
                [1, 0],
                [1, 1],
                [1, 1],
            ],
            [0, 0, 100, 100],
        );
        expect(fit.converged).toBe(false);
    });

    test("the negative-binomial fit refits the coefficients at the capped theta before converging", () => {
        const x = [
            [1, -2.5],
            [1, -1.5],
            [1, -0.5],
            [1, 0.5],
            [1, 1.5],
            [1, 2.5],
        ];
        const y = [0, 1, 2, 2, 3, 3];
        const fit = negativeBinomial(x, y);
        expect(fit.theta).toBe(1e8);
        expect(fit.converged).toBe(true);
        const score = [0, 1].map((j) =>
            x.reduce((s, row, i) => {
                const eta = row.reduce((e, v, k) => e + v * (fit.coefficients[k] as number), 0);
                return s + (row[j] as number) * ((y[i] as number) - Math.exp(eta));
            }, 0),
        );
        score.forEach((g) => {
            near(g, 0, 1e-6);
        });
    });

    test("the negative-binomial theta score keeps its sign for a large finite dispersion", () => {
        const x = Array.from({ length: 10 }, (_, i) => [1, (i - 4.5) / 10]);
        const fit = negativeBinomial(x, [0, 1, 1, 2, 1, 4, 0, 2, 4, 1]);
        expect(fit.converged).toBe(true);
        near(fit.theta / 15113.7489, 1, 1e-4);
    });

    test("the negative-binomial theta score stays accurate for counts above the harmonic cutoff", () => {
        const y = [962, 1040, 952, 1019, 1041, 1033, 1006, 983, 990, 1040];
        const fit = negativeBinomial(
            y.map(() => [1]),
            y,
        );
        expect(fit.converged).toBe(true);
        near(fit.theta / 4181996.5, 1, 1e-3);
    });

    test("the negative-binomial separation check is invariant to predictor units", () => {
        const rows = readFileSync(join(FIXTURES, "quine.csv"), "utf8")
            .trim()
            .split("\n")
            .slice(1)
            .map((l) => l.split(","));
        const y = rows.map((c) => Number(c[5]));
        const design = (scale: number) =>
            rows.map((c) => [
                1,
                Number(c[1] === "N"),
                Number(c[2] === "M"),
                Number(c[3] === "F1"),
                Number(c[3] === "F2"),
                Number(c[3] === "F3"),
                scale * Number(c[4] === "SL"),
            ]);
        const unit = negativeBinomial(design(1), y);
        const milli = negativeBinomial(design(0.001), y);
        expect([unit.converged, milli.converged]).toEqual([true, true]);
        near((milli.coefficients[6] as number) / 1000, unit.coefficients[6] as number, 1e-6);
        const nano = negativeBinomial(design(1e-7), y);
        expect(nano.converged).toBe(true);
        near((nano.coefficients[6] as number) * 1e-7, unit.coefficients[6] as number, 1e-6);
    });

    test("the negative-binomial fit bounds its work for a large count and rejects an empty or non-count response", () => {
        const started = performance.now();
        const fit = negativeBinomial(
            [
                [1, 0],
                [1, 1],
            ],
            [0, 10_000_000],
        );
        expect(fit.converged).toBe(false);
        const wide = negativeBinomial([[1], [1]], [0, 10_000_000]);
        expect(wide.converged).toBe(true);
        expect(wide.theta).toBeGreaterThan(0);
        expect(wide.theta).toBeLessThan(1);
        expect(performance.now() - started).toBeLessThan(2000);
        expect(() => negativeBinomial([[1, 0], [1]], [1, 2])).toThrow(RangeError);
        expect(() =>
            negativeBinomial(
                [
                    [1, Number.NaN],
                    [1, 1],
                ],
                [1, 2],
            ),
        ).toThrow(RangeError);
        expect(() => negativeBinomial([], [])).toThrow(RangeError);
        expect(() => negativeBinomial([[1], [1], [1]], [-1, 2, 3])).toThrow(RangeError);
        expect(() => negativeBinomial([[1], [1], [1]], [0.5, 2, 3])).toThrow(RangeError);
        expect(() => negativeBinomial([[1], [1]], [1, 2, 100])).toThrow(RangeError);
        expect(() => mcnemarExact(1.5, 2)).toThrow(RangeError);
        expect(() => mcnemarExact(-1, 2)).toThrow(RangeError);
        expect(() => signTest(-1, 6)).toThrow(RangeError);
        expect(() => signTest(7, 6)).toThrow(RangeError);
        expect(() => signTest(1.5, 6)).toThrow(RangeError);
        expect(() => newcombe(10, -1, 2, 5)).toThrow(RangeError);
        expect(() => newcombe(10, 0.5, 2, 5)).toThrow(RangeError);
    });

    test("the negative-binomial alternation has room to settle a slowly converging theta", () => {
        const fit = negativeBinomial(
            [-3, -2, -1, 1, 2, 3].map((v) => [1, v]),
            [15, 12, 1, 2, 2, 2],
        );
        expect(fit.converged).toBe(true);
        near(fit.theta, 90.1321046, 1e-6);
    });

    test("the negative-binomial fit starts from the observed counts, whatever the column order or a rare large count", () => {
        const y = [0, 1, 2, 2, 3, 5, 8, 13];
        const first = negativeBinomial(
            y.map((_, i) => [1, 100 * (i - 3.5)]),
            y,
        );
        const last = negativeBinomial(
            y.map((_, i) => [100 * (i - 3.5), 1]),
            y,
        );
        expect([first.converged, last.converged]).toEqual([true, true]);
        near(last.coefficients[0] as number, first.coefficients[1] as number, 1e-9);
        near(last.coefficients[1] as number, first.coefficients[0] as number, 1e-9);
        const x = Array.from({ length: 800 }, (_, i) => [1, Number(i === 799)]);
        const rare = negativeBinomial(
            x,
            x.map((_, i) => (i === 799 ? 10_000 : 1)),
        );
        expect(rare.converged).toBe(true);
        near(rare.coefficients[0] as number, 0, 1e-9);
        near(rare.coefficients[1] as number, Math.log(10_000), 1e-9);
    });

    test("an empty bootstrap sample and a non-positive digamma argument are rejected", () => {
        expect(() => bootstrap([], (s) => s.length, { replicates: 100, seed: 1 })).toThrow(
            RangeError,
        );
        expect(() => digamma(0)).toThrow(RangeError);
        expect(() => digamma(-1_000_000_000.5)).toThrow(RangeError);
        near(digamma(1), -0.5772156649015329, 1e-9);
    });

    test("a BCa interval of a single observation is that observation", () => {
        const avg = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length;
        expect(acceleration([5], avg)).toBe(0);
        const b = bootstrap([5], avg, { replicates: 200, seed: 1, bca: true });
        expect([b.estimate, b.lo, b.hi]).toEqual([5, 5, 5]);
    });

    test("the incomplete beta function converges for large concentrated shapes", () => {
        near(incompleteBeta(0.5, 1e7, 1e7), 0.5, 1e-7);
        expect(() => incompleteBeta(0.5, 1e12, 1e12)).toThrow(RangeError);
    });

    test("the binomial mass keeps representable tails and exact half probabilities", () => {
        near(binomialPmf(500, 1000, 0.2) / 3.1032622600153052e-99, 1, 1e-9);
        expect(binomialPmf(0, 6, 0.5)).toBe(1 / 64);
        expect(binomialPmf(3, 6, 0.5)).toBe(20 / 64);
        near(binomialCdf(900, 2000, 0.5) / 4.228544767750218e-6, 1, 1e-9);
        const started = performance.now();
        near(signTest(50_000_000, 100_000_000), 1, 1e-3);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(() => signTest(5_000_000_000, 10_000_000_000)).toThrow(/at most/);
        expect(() => mcnemarExact(5_000_000_000, 5_000_000_000)).toThrow(/at most/);
    });

    test("the normal distribution functions invert each other", () => {
        for (const p of [0.001, 0.025, 0.5, 0.8, 0.975, 0.999])
            near(normalCdf(normalQuantile(p)), p, 1e-12);
        near(normalQuantile(0.975), 1.959963984540054, 1e-12);
    });
});
