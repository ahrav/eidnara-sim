import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileScenario } from "../src/scenario/compile";
import { loadCompileInput } from "../src/scenario/inputs";
import { hashEmbedder } from "../src/scenario/similarity";
import { SPAN_HEADER, type SpanScenario, scenarioSpan, spanRow } from "./scenario-span";

const S = 1_000;
const H = 3_600 * S;
const D = 24 * H;

/**
 * HAND has one advance in each threshold band: [30 s, 60 s), [60 s, 1 h), [1 h, 24 h),
 * [24 h, 7 d), and [7 d, ∞), over four sessions of two projects.
 */
const HAND: SpanScenario = {
    manifest: { seed: 7, tier: "S" },
    events: [
        { id: "e-0", kind: "session_start", session: "s-0", project: "a", scenario_ms: 0 },
        { id: "e-1", kind: "user_turn", session: "s-0", scenario_ms: 29_999 },
        { id: "e-2", kind: "user_turn", session: "s-0", scenario_ms: 59_999 },
        { id: "e-3", kind: "session_end", session: "s-0", scenario_ms: 119_999 },
        { id: "e-4", kind: "apply_diff", session: "s-1", project: "b", scenario_ms: 119_999 + H },
        {
            id: "e-5",
            kind: "session_start",
            session: "s-1",
            project: "b",
            scenario_ms: 119_999 + H,
        },
        { id: "e-6", kind: "session_end", session: "s-1", scenario_ms: 119_999 + H },
        { id: "e-7", kind: "session_start", session: "s-2", project: "a", scenario_ms: 2 * D },
        { id: "e-8", kind: "user_turn", session: "s-2", scenario_ms: 2 * D - 5 },
        { id: "e-9", kind: "session_end", session: "s-2", scenario_ms: 2 * D + 10 * S },
        { id: "e-10", kind: "session_start", session: "s-3", project: "b", scenario_ms: 10 * D },
        { id: "e-11", kind: "session_end", session: "s-3", scenario_ms: 10 * D + 1 },
    ],
};

test("a scenario's span, advances, and per-project session gaps are read from its events", () => {
    const span = scenarioSpan(HAND);
    expect(span).toEqual({
        seed: 7,
        tier: "S",
        events: 12,
        user_turns: 3,
        sessions: 4,
        span_ms: 10 * D + 1,
        span_days: 10,
        // The step onto the last session: from 10 s past day 2 to day 10.
        largest_advance_ms: 8 * D - 10 * S,
        largest_advance_at: "e-10",
        largest_session_gap_ms: 8 * D - 10 * S,
        // The eleven steps in ms: 29,999; 30,000; 60,000; 3,600,000; 0; 0; 169,080,001; 0 (a step back); 10,005; 8 days less 10 s; 1.
        advances_at_least: { "30s": 5, "60s": 4, "1h": 3, "24h": 2, "7d": 1 },
        projects: {
            a: {
                sessions: 2,
                span_ms: 2 * D + 10 * S,
                span_days: 2,
                largest_gap_ms: 2 * D - 119_999,
                gaps_at_least: { "30s": 1, "60s": 1, "1h": 1, "24h": 1, "7d": 0 },
            },
            b: {
                sessions: 2,
                span_ms: 10 * D + 1 - (119_999 + H),
                span_days: 9.957,
                largest_gap_ms: 10 * D - (119_999 + H),
                gaps_at_least: { "30s": 1, "60s": 1, "1h": 1, "24h": 1, "7d": 1 },
            },
        },
    });
    // An advance of exactly a threshold counts toward it, and one a millisecond short stays below it.
    const at = (ms: number) =>
        scenarioSpan({
            events: [
                { kind: "session_start", session: "s", project: "p", scenario_ms: 0 },
                { kind: "session_end", session: "s", scenario_ms: ms },
            ],
        }).advances_at_least;
    expect(at(7 * D)).toEqual({ "30s": 1, "60s": 1, "1h": 1, "24h": 1, "7d": 1 });
    expect(at(7 * D - 1)).toEqual({ "30s": 1, "60s": 1, "1h": 1, "24h": 1, "7d": 0 });
    expect(at(30 * S - 1)).toEqual({ "30s": 0, "60s": 0, "1h": 0, "24h": 0, "7d": 0 });
    // The text row holds the same numbers in the header's columns.
    const row = spanRow("hand.json", span).split(" | ");
    expect(row).toHaveLength(SPAN_HEADER.split(" | ").length);
    expect(row.slice(0, 11)).toEqual([
        "hand.json",
        "7",
        "S",
        "12",
        "3",
        "4",
        "a (2), b (2)",
        "10.00",
        "192.0 h",
        "192.0 h",
        "5 / 4 / 3 / 2 / 1",
    ]);
    expect(row[11]).toBe("a: 2.00 d, 48.0 h, 1 / 0; b: 9.96 d, 239.0 h, 1 / 1");
    // A scenario the report cannot place is refused by what it lacks.
    expect(() => scenarioSpan({ events: [] })).toThrow("the scenario holds no event");
    expect(() =>
        scenarioSpan({ events: [{ id: "e-0", kind: "session_start", session: "s" }] }),
    ).toThrow("event e-0 holds no scenario time");
    expect(() =>
        scenarioSpan({
            events: [{ id: "e-0", kind: "session_start", session: "s", scenario_ms: 0 }],
        }),
    ).toThrow("session s names no project");
    expect(() =>
        scenarioSpan({ events: [{ id: "e-0", kind: "user_turn", session: "s", scenario_ms: 0 }] }),
    ).toThrow("event e-0 precedes the start of session s");
});

test("a built tier S scenario's report agrees with the scenario's own session list, and the script prints a row and a JSON line for it", async () => {
    const scenario = await compileScenario(loadCompileInput(101, "S", hashEmbedder, true));
    const span = scenarioSpan(scenario as unknown as SpanScenario);
    const sessions = scenario.sessions as unknown as {
        id: string;
        project: string;
        start_ms: number;
    }[];
    expect([span.seed, span.tier]).toEqual([101, "S"]);
    expect(span.events).toBe(scenario.events.length);
    expect(span.sessions).toBe(sessions.length);
    expect(span.user_turns).toBe(scenario.events.filter((e) => e.kind === "user_turn").length);
    // The session list names each session's project and start, apart from the events.
    const projects = [...new Set(sessions.map((s) => s.project))].sort();
    expect(Object.keys(span.projects)).toEqual(projects);
    for (const project of projects) {
        const own = sessions.filter((s) => s.project === project);
        const reported = span.projects[project];
        expect(reported?.sessions).toBe(own.length);
        const starts = own.map((s) => s.start_ms);
        // A project's span covers its session starts, and its largest gap fits inside the longest start-to-start step.
        expect(reported?.span_ms).toBeGreaterThanOrEqual(Math.max(...starts) - Math.min(...starts));
        const stepped = starts.slice(1).map((start, i) => start - (starts[i] as number));
        expect(reported?.largest_gap_ms).toBeLessThanOrEqual(Math.max(0, ...stepped));
    }
    const times = scenario.events.map((e) => e.scenario_ms as number);
    expect(span.span_ms).toBe(Math.max(...times) - Math.min(...times));
    // The thresholds nest: a longer advance counts under every shorter threshold too.
    const a = span.advances_at_least;
    expect(a["30s"]).toBeGreaterThan(0);
    expect([a["30s"] >= a["60s"], a["60s"] >= a["1h"], a["1h"] >= a["24h"]]).toEqual([
        true,
        true,
        true,
    ]);
    expect(a["24h"]).toBeGreaterThanOrEqual(a["7d"]);
    expect(span.largest_advance_ms).toBeGreaterThanOrEqual(span.largest_session_gap_ms);
    const dir = mkdtempSync(join(tmpdir(), "sim-span-"));
    try {
        const path = join(dir, "S-101.json");
        writeFileSync(path, JSON.stringify(scenario));
        const script = join(import.meta.dir, "scenario-span.ts");
        const text = Bun.spawnSync([process.execPath, script, path]);
        expect(text.exitCode).toBe(0);
        expect(text.stdout.toString()).toBe(`${SPAN_HEADER}\n${spanRow("S-101.json", span)}\n`);
        const json = Bun.spawnSync([process.execPath, script, "--json", path]);
        expect(JSON.parse(json.stdout.toString())).toEqual({ scenario: path, ...span });
        const none = Bun.spawnSync([process.execPath, script]);
        expect([none.exitCode, none.stderr.toString()]).toEqual([
            2,
            "usage: bun scripts/scenario-span.ts [--json] <scenario.json>...\n",
        ]);
        const absent = Bun.spawnSync([process.execPath, script, join(dir, "absent.json")]);
        expect(absent.exitCode).toBe(2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
