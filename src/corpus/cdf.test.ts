import { describe, expect, test } from "bun:test";
import { Rng } from "../rng";
import { fitCdf, GRID, quantile, sample } from "./cdf";

describe("fitCdf and quantile", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 1);

    test("discrete tables return the inverse empirical CDF at grid points", () => {
        const t = fitCdf(values, "discrete");
        expect(t.p).toEqual([...GRID]);
        expect(quantile(t, 0.5)).toBe(500);
        expect(quantile(t, 0.9)).toBe(900);
        expect(quantile(t, 0.99)).toBe(990);
        expect(quantile(t, 0)).toBe(1);
        expect(quantile(t, 1)).toBe(1000);
    });

    test("continuous tables interpolate order statistics like quantile_cont", () => {
        const t = fitCdf(values, "continuous");
        expect(quantile(t, 0.5)).toBe(500.5);
        expect(quantile(t, 0.9)).toBeCloseTo(900.1, 3);
    });

    test("discrete tables keep integer values between grid points", () => {
        const t = fitCdf([1, 1, 1, 2, 3, 50], "discrete");
        for (let q = 0; q <= 1; q += 0.0137) expect(Number.isInteger(quantile(t, q))).toBe(true);
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
    test("a tail floor draws only from the tail", () => {
        const t = fitCdf(
            Array.from({ length: 1000 }, (_, i) => i + 1),
            "discrete",
        );
        const rng = new Rng(3);
        for (let i = 0; i < 1000; i++) expect(sample(t, rng, 0.9)).toBeGreaterThanOrEqual(900);
    });
});
