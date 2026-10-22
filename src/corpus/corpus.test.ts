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
    loadRates,
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
        broken.schema = "sim-fact-bank/v0";
        broken.python = {};
        broken.rust.rationale = [];
        broken.typescript.scoped_update[0].check.quote_style_must = "backtick";
        broken.any.anchor[0].check.must_not = ["[unclosed"];
        broken.any.anchor[1].id = "lookup-port";
        delete broken.any.never_settled;
        expect(bankProblems(broken)).toEqual([
            "fact-bank schema: sim-fact-bank/v0 is not sim-fact-bank/v2",
            "fact-bank rust/plan[0] rs-plan-field: probe missing",
            "fact-bank rust/rationale: expected at least 1 templates",
            "fact-bank rust/filler: expected a non-empty list of distinct non-blank strings",
            "fact-bank typescript/scoped_update[0] ts-scope-quotes: check key quote_style_must is not double or single",
            "fact-bank typescript/filler: expected a non-empty list of distinct non-blank strings",
            "fact-bank any/never_settled: kind missing",
            "fact-bank any/lookup[0] lookup-staging-alias: check key musts is not a check kind",
            "fact-bank any/anchor[0] anchor-ticket: check key must_not pattern [unclosed is not a regular expression",
            "fact-bank any/anchor[1] lookup-port: duplicate template id",
            "fact-bank python: unknown language",
        ]);
    });

    test("the fact bank gate names kind-specific omissions and unusable patterns", () => {
        const bank = JSON.parse(readFileSync(join(CORPUS_DIR, "fact-bank.json"), "utf8"));
        const broken = structuredClone(bank);
        delete broken.rust.scoped_update[0].update;
        delete broken.rust.decision[0].authority;
        broken.rust.plan[0].check.must = ["{tokne}"];
        broken.rust.rationale[0].check.judge = "  ";
        broken.any.lookup[0].check.answer = "";
        broken.any.anchor[0].check.must_not = [""];
        delete broken.typescript.scoped_update[0].out_probe;
        delete broken.typescript.scoped_update[0].out_check;
        delete broken.any;
        broken.rust.constraint[0].statement = "   ";
        delete broken.rust.constraint[1].out_probe;
        broken.rust.plan[1].check = { must: ["{code}"] };
        broken.rust.rejected[0].check = { answer: "x" };
        broken.typescript.rationale[0].check = { judge: "{codenam}" };
        broken.rust.constraint[2].statement = "helpers use {tokne}";
        broken.rust.constraint[3].check = { must_not: ["DO_NOT"] };
        broken.rust.decision[1].authority.content = "// unrelated authority\n";
        broken.typescript.decision[0].check = { must_not: ["{value}"] };
        broken.typescript.scoped_update[0].update = "   ";
        broken.typescript.constraint[0].check = { first_line_must: ["^x"] };
        broken.typescript.decision[1].authority.path = "  ";
        broken.rust.constraint[1].example.path = "../../outside.rs";
        broken.rust.constraint[0].example.content = "pub const WRONG = 1;";
        expect(bankProblems(broken)).toEqual([
            "fact-bank any: language missing",
            "fact-bank rust/constraint[0] rs-cmd-const-prefix: statement missing",
            "fact-bank rust/constraint[0] rs-cmd-const-prefix: example content does not satisfy the check",
            "fact-bank rust/constraint[1] rs-cmd-error-tag: example path escapes the project",
            "fact-bank rust/constraint[1] rs-cmd-error-tag: out_probe missing",
            "fact-bank rust/constraint[2] rs-db-helper-prefix: statement names an unknown placeholder",
            "fact-bank rust/constraint[3] rs-test-suffix: check needs must or paths_must",
            "fact-bank rust/decision[0] rs-scan-page: authority missing",
            "fact-bank rust/decision[1] rs-conn-buffer: authority content does not satisfy the check",
            "fact-bank rust/plan[0] rs-plan-field: a plan task binds only {token} and {TOKEN}, which a second task rebinds",
            "fact-bank rust/plan[0] rs-plan-field: check key must pattern {tokne} names an unknown placeholder",
            "fact-bank rust/plan[1] rs-plan-cmd: a plan task binds only {token} and {TOKEN}, which a second task rebinds",
            "fact-bank rust/plan[1] rs-plan-cmd: check key must pattern {code} names an unknown placeholder",
            "fact-bank rust/rationale[0] rs-why-noalloc: check key judge is blank",
            "fact-bank rust/rejected[0] rs-no-global-mutex: check key answer is not graded for rejected facts",
            "fact-bank rust/scoped_update[0] rs-scope-log-level: update missing",
            "fact-bank typescript/constraint[0] ts-const-prefix: check needs must or paths_must",
            "fact-bank typescript/decision[0] ts-body-limit: check needs must",
            "fact-bank typescript/decision[1] ts-cookie-age: authority path is blank",
            "fact-bank typescript/rationale[0] ts-why-aot: check key judge names an unknown placeholder",
            "fact-bank typescript/scoped_update[0] ts-scope-quotes: update missing",
            "fact-bank typescript/scoped_update[0] ts-scope-quotes: out_probe missing",
            "fact-bank typescript/scoped_update[0] ts-scope-quotes: out_check missing",
        ]);
    });

    test("the fact bank gate names revision, variant, plan, framing, and tool-error problems", () => {
        const bank = JSON.parse(readFileSync(join(CORPUS_DIR, "fact-bank.json"), "utf8"));
        const broken = structuredClone(bank);
        broken.rust.constraint[0].revise = "the {old_tokne} prefix is retired";
        broken.rust.scoped_update[0].variants = [{ level: "trace", LEVEL: "TRACE" }];
        broken.rust.decision[0].variants = [{ unit: "rows" }, { unit: "rows" }];
        broken.rust.tool_error[0].form = "log";
        broken.rust.tool_error[1].paste = "no identity here";
        broken.typescript.tool_error[0].script.content = "exit 1";
        broken.typescript.plan = [broken.typescript.plan[0]];
        broken.any.framings = ["Next.", "Next."];
        broken.rust.plan[1].check = { paths_must: ["x"] };
        broken.typescript.tool_error[0].command = "true";
        broken.typescript.scoped_update[0].variants[0].outer = "backtick";
        expect(bankProblems(broken)).toEqual([
            "fact-bank rust/constraint[0] rs-cmd-const-prefix: revise names an unknown placeholder",
            "fact-bank rust/decision[0] rs-scan-page: variants repeat",
            "fact-bank rust/plan[1] rs-plan-cmd: check needs must, which a clarify item names",
            "fact-bank rust/scoped_update[0] rs-scope-log-level: variants is not a list of at least two objects",
            "fact-bank rust/tool_error[0] rs-check-replay: form is not tool_result or pasted",
            "fact-bank rust/tool_error[1] rs-ci-paste: the pasted text does not carry the error the check names",
            "fact-bank typescript/plan: expected at least 2 templates",
            "fact-bank typescript/scoped_update[0] ts-scope-quotes out_check: check key quote_style_must is not double or single",
            "fact-bank typescript/tool_error[0] ts-check-replay: command does not run the committed script scripts/check-quiet_vole.sh",
            "fact-bank typescript/tool_error[0] ts-check-replay: the tool_result text does not carry the error the check names",
            "fact-bank any/framings: expected a non-empty list of distinct non-blank strings",
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
    const published = loadRates();

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
