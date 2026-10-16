import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../rng";
import type { CdfTable } from "./cdf";
import { checkCorpus } from "./check";
import {
    type CheckResult,
    compareCited,
    failedChecks,
    loadCited,
    loadDistributions,
    table,
    waived,
} from "./distributions";
import { bankProblems } from "./fact-bank";
import { type SampledSession, sampleSession } from "./sampler";
import { CORPUS_DIR } from "./sources";

interface Rate {
    value: number | null;
    low?: number;
    high?: number;
    by_mode?: Record<string, number>;
    quote: string;
}

const dist = loadDistributions();
const cited = loadCited();
const SESSIONS = 10_000;

function percentile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
}

function cdfAt(t: CdfTable, v: number): number {
    let i = -1;
    while (i + 1 < t.x.length && (t.x[i + 1] ?? 0) <= v) i++;
    if (i < 0) return 0;
    const p = t.p[i] ?? 1;
    if (t.kind === "discrete" || i === t.x.length - 1) return p;
    const [x0, x1, p1] = [t.x[i] ?? 0, t.x[i + 1] ?? 0, t.p[i + 1] ?? 1];
    return x1 === x0 ? p : p + ((v - x0) / (x1 - x0)) * (p1 - p);
}

function ksDistance(t: CdfTable, draws: number[]): number {
    const sorted = [...draws].sort((a, b) => a - b);
    const n = sorted.length;
    let d = 0;
    if (t.kind === "discrete") {
        let below = 0;
        for (const [i, x] of t.x.entries()) {
            while (below < n && (sorted[below] ?? 0) <= x) below++;
            d = Math.max(d, Math.abs(below / n - (t.p[i] ?? 1)));
        }
    }
    let first = 0;
    for (let i = 0; i < n; i++) {
        const v = sorted[i] ?? 0;
        if (sorted[i + 1] === v) continue;
        const f = cdfAt(t, v);
        d = Math.max(d, Math.abs((i + 1) / n - f));
        if (t.kind === "continuous") {
            const atom = t.x.indexOf(v);
            const below = atom < 0 ? f : (t.p[atom] ?? 0);
            d = Math.max(d, Math.abs(below - first / n));
        }
        first = i + 1;
    }
    return d;
}

/** DKW: P(sup |F_n - F| > eps) <= 2 exp(-2 n eps^2); this solves for eps at alpha = 0.001. */
function dkw(n: number): number {
    return Math.sqrt(Math.log(2 / 0.001) / (2 * n));
}

describe("committed corpus", () => {
    test("checkCorpus finds no problems", () => {
        expect(checkCorpus().problems).toEqual([]);
    });

    test("the fact bank gate names a template without a probe and an unknown check key", () => {
        const bank = JSON.parse(readFileSync(join(CORPUS_DIR, "fact-bank.json"), "utf8"));
        expect(bankProblems(bank)).toEqual([]);
        const broken = structuredClone(bank);
        delete broken.rust.plan[0].probe;
        broken.any.lookup[0].check.musts = ["x"];
        broken.typescript.filler = "not a list";
        broken.rust.filler = [];
        expect(bankProblems(broken)).toEqual([
            "fact-bank rust/plan[0] rs-plan-field: probe missing",
            "fact-bank rust/filler: expected a non-empty list of non-blank strings",
            "fact-bank typescript/filler: expected a non-empty list of non-blank strings",
            "fact-bank any/lookup[0] lookup-staging-alias: check key musts is not a check kind",
        ]);
    });

    test("every quantity names its source and sample size", () => {
        for (const q of Object.values(dist.quantities)) {
            expect(q.source).toContain("@");
            expect(q.n).toBeGreaterThan(1000);
        }
    });

    test("only append p90 carries a recorded deviation", () => {
        const deviations = cited.checks.filter(waived);
        expect(deviations.map((c) => [c.quantity, c.q])).toEqual([["append_tokens_per_step", 0.9]]);
    });

    test("discrete tables keep every distinct count and end at probability 1", () => {
        const t = table(dist, "requests_per_session");
        expect(t.kind).toBe("discrete");
        expect(new Set(t.x).size).toBe(t.x.length);
        expect(t.p[t.p.length - 1]).toBe(1);
    });
});

describe("sampler over 10,000 sessions", () => {
    const rng = new Rng(20261012);
    const sessions: SampledSession[] = Array.from({ length: SESSIONS }, () =>
        sampleSession(dist, rng),
    );
    const pooled: Record<string, number[]> = {
        requests_per_session: sessions.map((s) => s.requests),
        tool_steps_per_request: sessions.flatMap((s) => s.steps),
        idle_within_session_s: sessions.flatMap((s) => s.idle_s),
        append_tokens_per_step: sessions.flatMap((s) => s.append_tokens),
    };

    test("sampled percentiles sit within the cited bands, except recorded deviations", () => {
        const results: CheckResult[] = compareCited(cited, (quantity, q) =>
            percentile(pooled[quantity] ?? [], q),
        );
        expect(failedChecks(results)).toEqual([]);
    });

    test("each sampled quantity matches its table CDF within the DKW bound", () => {
        for (const [name, draws] of Object.entries(pooled)) {
            const within = ksDistance(table(dist, name), draws) < dkw(draws.length);
            expect({ name, within }).toEqual({ name, within: true });
        }
    });

    test("SIM-P17: idle gaps beyond the cited p99 band floor are reachable", () => {
        const p99 = cited.checks.find(
            (c) => c.quantity === "idle_within_session_s" && c.q === 0.99,
        );
        const floor = (p99?.cited ?? Number.POSITIVE_INFINITY) * (1 - cited.rel);
        const idle = pooled.idle_within_session_s ?? [];
        expect(idle.filter((g) => g >= floor).length).toBeGreaterThan(0);
        expect(Math.max(...idle)).toBeGreaterThan(11 * 3600);
    });

    test("append token counts are whole numbers", () => {
        const append = pooled.append_tokens_per_step ?? [];
        expect(append.filter((a) => !Number.isInteger(a))).toEqual([]);
    });

    test("the append tail reaches 10k tokens per step", () => {
        const append = pooled.append_tokens_per_step ?? [];
        const share = append.filter((a) => a >= 10_000).length / append.length;
        expect(share).toBeGreaterThan(0.01);
    });
});

describe("between-session idle gaps", () => {
    test("the fitted tail reaches multi-day gaps for scenario spans", () => {
        const t = table(dist, "idle_between_sessions_s");
        expect(t.x[t.x.length - 1] ?? 0).toBeGreaterThan(3 * 86_400);
        expect(t.x[t.p.indexOf(0.5)] ?? 0).toBeGreaterThan(60);
    });
});

describe("SIM-P09: forced p90 sessions", () => {
    const t = table(dist, "requests_per_session");
    const at = (q: number) => t.x[t.p.findIndex((p) => p >= q)] ?? Number.NaN;

    test("a 0.9 tail floor draws from the conditional tail, not its maximum", () => {
        const rng = new Rng(9);
        const draws = Array.from({ length: 2000 }, () => sampleSession(dist, rng, 0.9).requests);
        expect(Math.min(...draws)).toBeGreaterThanOrEqual(at(0.9));
        expect(draws.filter((d) => d < at(0.99)).length).toBeGreaterThan(1500);
        const median = percentile(draws, 0.5);
        expect(median).toBeGreaterThanOrEqual(at(0.94));
        expect(median).toBeLessThanOrEqual(at(0.96));
    });
});

describe("SIM-P10: user-behaviour rates", () => {
    const published = JSON.parse(readFileSync(join(CORPUS_DIR, "published-rates.json"), "utf8"));

    test("the four behaviour rates are present", () => {
        expect(Object.keys(published.rates).sort()).toEqual([
            "abandon_per_session",
            "interrupt_per_turn",
            "pushback_per_turn",
            "redirect_per_session",
        ]);
    });

    test("distributions.json carries the published rates unchanged", () => {
        expect(dist.rates).toEqual({
            source: published.source,
            note: published.note,
            ...published.rates,
        });
    });

    test("each rate's numbers lie in [0, 1], appear as percentages in its quote, and stay ordered", () => {
        for (const [name, raw] of Object.entries(published.rates)) {
            const rate = raw as Rate;
            const numbers = [
                rate.value,
                rate.low,
                rate.high,
                ...Object.values(rate.by_mode ?? {}),
            ].filter((v): v is number => typeof v === "number");
            expect({ name, any: numbers.length > 0 }).toEqual({ name, any: true });
            const quoted = [...rate.quote.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
            for (const v of numbers) {
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(1);
                const found = quoted.some((q) => Math.abs(q / 100 - v) < 1e-9);
                expect({ name, v, found }).toEqual({ name, v, found: true });
            }
            if (rate.low !== undefined && rate.high !== undefined) {
                expect(rate.low).toBeLessThanOrEqual(rate.high);
                if (rate.value !== null) {
                    expect(rate.value).toBeGreaterThanOrEqual(rate.low);
                    expect(rate.value).toBeLessThanOrEqual(rate.high);
                }
            }
        }
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
    test("a blank or non-string deviation waives nothing", () => {
        for (const deviation of ["", "  ", null, 0] as unknown[]) {
            const check = { ...base, within: false, deviation } as CheckResult;
            expect(failedChecks([check])).toHaveLength(1);
        }
    });
});
