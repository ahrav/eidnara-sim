import { describe, expect, test } from "bun:test";
import { Rng } from "../rng";
import { cdfProblems, fitCdf, GRID, quantile, sample, tailShare } from "./cdf";

describe("cdfProblems", () => {
    test("fitted tables pass", () => {
        expect(cdfProblems(fitCdf([1, 2, 2, 3], "discrete"))).toEqual([]);
        expect(cdfProblems(fitCdf([5, 1, 3], "continuous"))).toEqual([]);
    });
    test("names decreasing, out-of-range, non-finite, and unequal tables", () => {
        const bad = { kind: "continuous" as const, p: [0.5, 0.4], x: [100, -1] };
        expect(cdfProblems(bad)).toEqual([
            "p must increase strictly within [0, 1]",
            "p must end at 1",
            "x must not decrease",
        ]);
        expect(cdfProblems({ kind: "discrete", p: [1], x: [Number.NaN] })).toEqual([
            "entries must be finite",
        ]);
        expect(cdfProblems({ kind: "discrete", p: [], x: [] })).toContain(
            "p and x need equal nonzero length",
        );
        expect(cdfProblems({ kind: "discrete", p: [0.5, 1.5], x: [1, 2] })).toContain(
            "p must increase strictly within [0, 1]",
        );
    });
});

describe("tailShare", () => {
    test("a continuous table interpolates the CDF at the threshold", () => {
        const t = { kind: "continuous" as const, p: [0, 0.5, 1], x: [0, 10, 20] };
        expect(tailShare(t, 5)).toBeCloseTo(0.75, 9);
        expect(tailShare(t, 10)).toBeCloseTo(0.5, 9);
        expect(tailShare(t, 0)).toBe(1);
        expect(tailShare(t, 25)).toBe(0);
    });
    test("a discrete table counts mass at the threshold", () => {
        const t = fitCdf([1, 2, 2, 3], "discrete");
        expect(tailShare(t, 2)).toBeCloseTo(0.75, 9);
        expect(tailShare(t, 3)).toBeCloseTo(0.25, 9);
        expect(tailShare(t, 4)).toBe(0);
    });
});

describe("fitCdf and quantile", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 1);

    test("discrete tables store each distinct value with its cumulative probability", () => {
        const t = fitCdf([3, 1, 1, 2, 1, 50], "discrete");
        expect(t.x).toEqual([1, 2, 3, 50]);
        expect(t.p).toEqual([0.5, 0.666666667, 0.833333333, 1]);
    });

    test("discrete quantiles are the inverse empirical CDF at any q", () => {
        const t = fitCdf(values, "discrete");
        expect(quantile(t, 0.5)).toBe(500);
        expect(quantile(t, 0.5001)).toBe(501);
        expect(quantile(t, 0.9)).toBe(900);
        expect(quantile(t, 0.99)).toBe(990);
        expect(quantile(t, 0)).toBe(1);
        expect(quantile(t, 1)).toBe(1000);
    });

    test("continuous tables interpolate order statistics like quantile_cont", () => {
        const t = fitCdf(values, "continuous");
        expect(t.p).toEqual([...GRID]);
        expect(quantile(t, 0.5)).toBe(500.5);
        expect(quantile(t, 0.9)).toBeCloseTo(900.1, 3);
    });

    test("continuous quantiles interpolate linearly between grid points", () => {
        const t = fitCdf(
            values.map((v) => v * v),
            "continuous",
        );
        const lo = quantile(t, 0.5);
        const hi = quantile(t, 0.505);
        expect(quantile(t, 0.5025)).toBeCloseTo((lo + hi) / 2, 2);
        expect(quantile(t, 0.5025)).not.toBe(hi);
    });

    test("quantile is monotone in q", () => {
        const t = fitCdf(
            values.map((v) => v * v),
            "continuous",
        );
        let prev = Number.NEGATIVE_INFINITY;
        for (let q = 0; q <= 1; q += 0.001) {
            const x = quantile(t, q);
            expect(x).toBeGreaterThanOrEqual(prev);
            prev = x;
        }
    });

    test("fitCdf rejects an empty sample", () => {
        expect(() => fitCdf([], "discrete")).toThrow();
    });
});

describe("sample", () => {
    test("a tail floor draws only from the tail and spreads across it", () => {
        const t = fitCdf(
            Array.from({ length: 1000 }, (_, i) => i + 1),
            "discrete",
        );
        const rng = new Rng(3);
        const draws = Array.from({ length: 1000 }, () => sample(t, rng, 0.9));
        expect(Math.min(...draws)).toBeGreaterThanOrEqual(901);
        expect(new Set(draws).size).toBeGreaterThan(80);
    });
});
