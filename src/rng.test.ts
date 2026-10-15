import { describe, expect, test } from "bun:test";
import { Rng } from "./rng";

describe("Rng", () => {
    test("one seed yields one sequence", () => {
        const a = new Rng(42);
        const b = new Rng(42);
        const seqA = Array.from({ length: 100 }, () => a.nextU32());
        const seqB = Array.from({ length: 100 }, () => b.nextU32());
        expect(seqA).toEqual(seqB);
    });

    test("distinct seeds yield distinct sequences", () => {
        const a = new Rng(1);
        const b = new Rng(2);
        expect(Array.from({ length: 8 }, () => a.nextU32())).not.toEqual(
            Array.from({ length: 8 }, () => b.nextU32()),
        );
    });

    test("next() stays in [0, 1) and is close to uniform", () => {
        const rng = new Rng(7);
        const draws = Array.from({ length: 100_000 }, () => rng.next());
        expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
        const mean = draws.reduce((s, d) => s + d, 0) / draws.length;
        expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
        const deciles = new Array(10).fill(0);
        for (const d of draws) deciles[Math.floor(d * 10)]++;
        for (const count of deciles) expect(Math.abs(count - 10_000)).toBeLessThan(500);
    });

    test("the sequence is pinned so compiled scenarios stay byte-stable", () => {
        const rng = new Rng(0);
        expect(Array.from({ length: 4 }, () => rng.nextU32())).toEqual([
            3809008728, 1133695204, 53579671, 2891528803,
        ]);
    });
});
