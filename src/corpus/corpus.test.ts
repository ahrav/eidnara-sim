import { describe, expect, test } from "bun:test";
import { Rng } from "../rng";
import { checkCorpus } from "./check";
import {
    type CheckResult,
    compareCited,
    failedChecks,
    loadCited,
    loadDistributions,
    table,
} from "./distributions";
import { type SampledSession, sampleSession } from "./sampler";

interface Rate {
    value: number | null;
    low?: number;
    high?: number;
    quote: string;
}

const dist = loadDistributions();
const cited = loadCited();
const SESSIONS = 10_000;

function percentile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

describe("committed corpus", () => {
    test("checkCorpus finds no problems", () => {
        expect(checkCorpus().problems).toEqual([]);
    });

    test("every quantity names its source and sample size", () => {
        for (const q of Object.values(dist.quantities)) {
            expect(q.source).toContain("@");
            expect(q.n).toBeGreaterThan(1000);
        }
    });

    test("fitted percentiles sit within the cited bands, except recorded deviations", () => {
        const results = compareCited(cited, (quantity, q) => {
            const t = table(dist, quantity);
            return t.x[t.p.indexOf(q)] ?? Number.NaN;
        });
        expect(failedChecks(results)).toEqual([]);
        expect(results.filter((r) => r.deviation !== undefined).map((r) => r.q)).toEqual([0.9]);
    });
});

describe("sampler over 10,000 sessions", () => {
    const rng = new Rng(20261012);
    const sessions: SampledSession[] = Array.from({ length: SESSIONS }, () =>
        sampleSession(dist, rng),
    );
    const pooled = {
        requests_per_session: sessions.map((s) => s.requests),
        idle_within_session_s: sessions.flatMap((s) => s.idle_s),
        append_tokens_per_step: sessions.flatMap((s) => s.append_tokens),
    } as Record<string, number[]>;

    test("sampled percentiles sit within the cited bands, except recorded deviations", () => {
        const results: CheckResult[] = compareCited(cited, (quantity, q) =>
            percentile(pooled[quantity] ?? [], q),
        );
        expect(failedChecks(results)).toEqual([]);
    });

    test("SIM-P17: idle gaps beyond the cited p99 band floor are reachable", () => {
        const p99 = cited.checks.find(
            (c) => c.quantity === "idle_within_session_s" && c.q === 0.99,
        );
        const floor = (p99?.cited ?? Number.POSITIVE_INFINITY) * (1 - cited.rel);
        const long = (pooled.idle_within_session_s ?? []).filter((g) => g >= floor);
        expect(long.length).toBeGreaterThan(0);
        expect(Math.max(...(pooled.idle_within_session_s ?? []))).toBeGreaterThan(11 * 3600);
    });

    test("the append tail reaches 10k tokens per step", () => {
        const append = pooled.append_tokens_per_step ?? [];
        const share = append.filter((a) => a >= 10_000).length / append.length;
        expect(share).toBeGreaterThan(0.01);
    });
});

describe("SIM-P09: forced p90 sessions", () => {
    test("a 0.9 tail floor yields only sessions at or above the fitted p90", () => {
        const t = table(dist, "requests_per_session");
        const p90 = t.x[t.p.indexOf(0.9)] ?? Number.NaN;
        const rng = new Rng(9);
        for (let i = 0; i < 200; i++) {
            expect(sampleSession(dist, rng, 0.9).requests).toBeGreaterThanOrEqual(p90);
        }
    });
});

describe("SIM-P10: user-behaviour rates", () => {
    test("each rate carries a source quote and a value or a band", () => {
        for (const name of [
            "pushback_per_turn",
            "interrupt_per_turn",
            "redirect_per_session",
            "abandon_per_session",
        ]) {
            const rate = dist.rates[name] as Rate;
            expect(rate.quote.length).toBeGreaterThan(10);
            const bounds = [rate.value, rate.low, rate.high].filter(
                (v): v is number => typeof v === "number",
            );
            expect(bounds.length).toBeGreaterThan(0);
            for (const v of bounds) expect(v >= 0 && v <= 1).toBe(true);
        }
        expect(typeof dist.rates.source).toBe("string");
    });
});

describe("failedChecks", () => {
    const base = { quantity: "q", q: 0.5, cited: 1, measured: 1, low: 0, high: 2 };
    test("an out-of-band check without a deviation fails", () => {
        expect(failedChecks([{ ...base, within: false }])).toHaveLength(1);
    });
    test("an out-of-band check with a deviation passes", () => {
        expect(failedChecks([{ ...base, within: false, deviation: "why" }])).toHaveLength(0);
    });
    test("an in-band check that still carries a deviation fails", () => {
        expect(failedChecks([{ ...base, within: true, deviation: "stale" }])).toHaveLength(1);
    });
});
