import { describe, expect, test } from "bun:test";
import type { GradeRecord, Verdict } from "../grade/probes";
import { armOrder, referenceArm } from "../run/run";
import { bootstrapMean, disagreementRate, pairedDiffs } from "./paired";

const grade = (
    arm: string,
    item: string,
    verdict: Verdict,
    ratio?: number,
    type = "P3",
): GradeRecord => ({
    item,
    arm,
    probe_type: type,
    version: 1,
    snapshot: `${arm}:${item}`,
    inputs: [],
    later_attempts_logged: 0,
    verdict,
    metrics:
        ratio === undefined ? { [`${type}.pass`]: verdict === "pass" } : { "P13.ratio": ratio },
});
const self = (item: string) => item;
const d = (pairs: [string, number][]) => pairs.map(([item, x]) => ({ item, d: x }));

describe("A/A pairing", () => {
    test("identical arms give zero differences, zero-width intervals, and no disagreement", () => {
        const grades = ["q-1", "q-2", "q-3"].flatMap((q) => [
            grade("host", q, "pass"),
            grade("host~aa", q, "pass"),
        ]);
        const diffs = pairedDiffs(grades, "host", "host~aa");
        expect([...diffs.keys()]).toEqual(["P3.pass"]);
        const m = bootstrapMean("P3.pass", diffs.get("P3.pass") ?? [], self, 2000, 7);
        expect(m).toEqual({
            metric: "P3.pass",
            n: 3,
            clusters: 3,
            mean: 0,
            lo: 0,
            hi: 0,
            covers_zero: true,
        });
        expect(disagreementRate(grades, "host", "host~aa")).toBe(0);
    });

    test("only items both arms graded pair, P7 never pairs, and a consistent gap leaves zero outside", () => {
        const grades = [
            ...["q-1", "q-2", "q-3", "q-4"].map((q) => grade("host", q, "fail")),
            ...["q-1", "q-2", "q-3", "q-4"].map((q) => grade("host~aa", q, "pass")),
            grade("host", "q-5", "pass"),
            grade("host~aa", "q-6", "excluded"),
            grade("host", "q-8", "pass", undefined, "P7"),
            grade("host~aa", "q-8", "fail", undefined, "P7"),
        ];
        const diffs = pairedDiffs(grades, "host", "host~aa");
        expect([...diffs.keys()]).toEqual(["P3.pass"]);
        expect(diffs.get("P3.pass")?.map((x) => x.d)).toEqual([1, 1, 1, 1]);
        const m = bootstrapMean("P3.pass", diffs.get("P3.pass") ?? [], self, 500, 7);
        expect([m.lo, m.hi, m.covers_zero]).toEqual([1, 1, false]);
        expect(disagreementRate(grades, "host", "host~aa")).toBe(1);
        const numeric = [grade("host", "q-7", "pass", 0.2), grade("host~aa", "q-7", "pass", 0.5)];
        expect(pairedDiffs(numeric, "host", "host~aa").get("P13.ratio")?.[0]?.d).toBeCloseTo(0.3);
    });

    test("items of one ledger fact resample together, which widens the interval", () => {
        const items = d([
            ["q-1", 1],
            ["q-2", 1],
            ["q-3", 1],
            ["q-4", -1],
            ["q-5", 0],
            ["q-6", 0],
        ]);
        const byFact = (item: string) => (["q-1", "q-2", "q-3"].includes(item) ? "f-1" : item);
        const clustered = bootstrapMean("x", items, byFact, 2000, 7);
        const flat = bootstrapMean("x", items, self, 2000, 7);
        expect([clustered.n, clustered.clusters, flat.clusters]).toEqual([6, 4, 6]);
        expect(clustered).toEqual(bootstrapMean("x", items, byFact, 2000, 7));
        expect(clustered.hi - clustered.lo).toBeGreaterThan(flat.hi - flat.lo);
        expect(clustered.covers_zero).toBe(true);
    });

    test("an A/A control runs beside its pre-registered pair, once, and diverges from its own arm", () => {
        expect(armOrder({ tier: "S", seed: 101, arms: ["host", "host~aa"] })).toEqual([
            "host",
            "host~aa",
        ]);
        expect(armOrder({ tier: "S", seed: 101, arms: ["eidnara~b", "eidnara"] })).toEqual([
            "eidnara",
            "eidnara~b",
        ]);
        expect(() => armOrder({ tier: "S", seed: 101, arms: ["host~aa"] })).toThrow(
            "beside its arm",
        );
        expect(() =>
            armOrder({ tier: "S", seed: 101, arms: ["host", "host~aa", "host~aa"] }),
        ).toThrow("twice");
        expect(() =>
            armOrder({ tier: "S", seed: 101, arms: ["eidnara-kl", "eidnara-kl~x"] }),
        ).toThrow("not in the S order");
        expect(() => armOrder({ tier: "L", seed: 301, arms: ["host", "host~aa"] })).toThrow(
            "not in the L order",
        );
        const ref = referenceArm(["eidnara", "eidnara~aa", "host", "host~aa"]);
        expect(["eidnara~aa", "host", "host~aa"].map(ref)).toEqual(["eidnara", "eidnara", "host"]);
        const cfAfter = referenceArm(["host", "eidnara", "eidnara-cf", "eidnara-kl"]);
        expect(["eidnara", "eidnara-cf", "eidnara-kl"].map(cfAfter)).toEqual([
            "host",
            "eidnara",
            "host",
        ]);
        const cfFirst = referenceArm(["eidnara-kl", "eidnara-cf", "eidnara", "host"]);
        expect(["eidnara-cf", "eidnara", "host"].map(cfFirst)).toEqual([
            "eidnara-kl",
            "eidnara-cf",
            "eidnara-kl",
        ]);
    });
});
