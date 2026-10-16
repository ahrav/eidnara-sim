import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrereg } from "../scenario/inputs";
import { type ArmLogs, loadRun, type RunLogs } from "./logs";
import { ORACLES, oracleReport, rssFit, runOracles } from "./oracles";

const DIR = join(import.meta.dir, "../../tests/fixtures/oracle");
const prereg = loadPrereg("S");

interface Fixture {
    kinds: Record<string, string>;
    arms: ArmLogs[];
    expect: Record<string, number>;
}
const fixtures = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture] as const);
const runOf = (f: Fixture, tier = "S"): RunLogs => ({
    dir: "",
    tier,
    prereg,
    kinds: new Map(Object.entries(f.kinds)),
    arms: f.arms,
});
const counts = (f: Fixture) => {
    const out: Record<string, number> = {};
    for (const a of runOracles(runOf(f))) out[a.oracle] = (out[a.oracle] ?? 0) + 1;
    return out;
};

describe("oracle fixtures", () => {
    test("each of F1 to F9 has a known-bad fixture that fires it and a known-good one that stays quiet", () => {
        for (const id of ORACLES) {
            const bad = fixtures.find(([f]) => f === `${id}-bad.json`)?.[1] as Fixture;
            const good = fixtures.find(([f]) => f === `${id}-good.json`)?.[1] as Fixture;
            expect([id, (counts(bad)[id] ?? 0) > 0]).toEqual([id, true]);
            expect([id, counts(good)[id] ?? 0]).toEqual([id, 0]);
        }
    });

    for (const [file, f] of fixtures) {
        test(`${file} activates each oracle the recorded number of times`, () => {
            const nonzero = Object.fromEntries(Object.entries(f.expect).filter(([, n]) => n > 0));
            expect(counts(f)).toEqual(nonzero);
        });
    }
});

describe("oracle report", () => {
    test("each tier lists an activation count per oracle and marks zero-activation oracles uncovered", () => {
        const bad = fixtures.find(([f]) => f === "F1-bad.json")?.[1] as Fixture;
        const good = fixtures.find(([f]) => f === "F3-good.json")?.[1] as Fixture;
        const report = oracleReport([runOf(bad, "S"), runOf(good, "S"), runOf(good, "M")]);
        expect(Object.keys(report).sort()).toEqual(["M", "S"]);
        expect(report.S?.F1).toEqual({
            activations: 1,
            uncovered: false,
            by_arm: { eidnara: 1 },
            by_component: { agent: 1 },
        });
        expect(report.S?.F7).toEqual({
            activations: 0,
            uncovered: true,
            by_arm: {},
            by_component: {},
        });
        expect(Object.values(report.M ?? {}).every((o) => o.uncovered)).toBe(true);
    });

    test("the RSS fit recovers a linear slope and reports its fit quality", () => {
        const fit = rssFit([0, 1, 2, 3].map((x) => ({ x, y: 100 + 10 * x })));
        expect(fit?.slope).toBeCloseTo(10);
        expect(fit?.r2).toBeCloseTo(1);
        expect(rssFit([{ x: 1, y: 2 }])).toBeNull();
    });

    test("a run directory loads into per-arm logs", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const order = ["host", "eidnara"];
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tier: "S", order, events: 1 }));
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({ events: [{ id: "e-1", kind: "session_end" }] }),
        );
        writeFileSync(
            join(dir, "calls.jsonl"),
            line({ arm: "eidnara", seq: 0 }) + line({ arm: "host", seq: 1 }),
        );
        const journal = [
            { kind: "StartRun", arm: null, order },
            { kind: "StartArm", arm: "host" },
            { kind: "Event", arm: "host", event: "e-1" },
            { kind: "EndArm", arm: "host" },
            { kind: "Event", arm: "eidnara", event: "e-1" },
            { kind: "EndArm", arm: "eidnara" },
            { kind: "EndRun", arm: null },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "a\nb\n");
        writeFileSync(join(dir, "eidnara", "daemon.log"), "c\n");
        const run = loadRun(dir, prereg);
        const eidnara = run.arms.find((a) => a.arm === "eidnara");
        expect(run.kinds.get("e-1")).toBe("session_end");
        expect([eidnara?.calls.length, eidnara?.pluginLog, eidnara?.daemonLog]).toEqual([
            1,
            ["a", "b"],
            ["c"],
        ]);
        expect(run.arms.find((a) => a.arm === "host")?.journal).toHaveLength(3);
    });
});

type Call = ArmLogs["calls"][number];
const call = (over: Partial<Call>): Call => ({
    seq: 0,
    arm: "eidnara",
    session: "s-1",
    turn: "e-1",
    component: "agent",
    componentSource: "inferred",
    model: "m",
    status: 200,
    finish_reason: "end_turn",
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    started_wall_ms: 0,
    wall_ms: 500,
    scenario_ms: 0,
    first_byte_ms: null,
    proxy_retries: 0,
    fault_ref: null,
    error: null,
    ...over,
});
const endTurn = (arm: string, event: string, scenario_ms: number, outcome = "ok") => ({
    kind: "EndTurn" as const,
    arm,
    event,
    outcome,
    seq: 0,
    wall_ms: 0,
    scenario_ms,
});
const armOf = (arm: string, over: Partial<ArmLogs>): ArmLogs => ({
    arm,
    calls: [],
    journal: [],
    pluginLog: [],
    daemonLog: [],
    resources: [],
    tools: [],
    ...over,
});
const runWith = (...arms: ArmLogs[]): RunLogs => ({
    dir: "",
    tier: "S",
    prereg,
    kinds: new Map(),
    arms,
});
const oracle = (run: RunLogs, id: string) => runOracles(run).filter((a) => a.oracle === id);

describe("oracle edge cases", () => {
    test("F4 fires on a sub-second call followed by silence until the turn end", () => {
        const quiet = runWith(
            armOf("host", {
                calls: [
                    call({ arm: "host", started_wall_ms: 0, wall_ms: 400, scenario_ms: 10_000 }),
                ],
                journal: [endTurn("host", "e-1", 10_000 + 400 + 600_000)],
            }),
        );
        expect(oracle(quiet, "F4").map((a) => a.evidence)).toEqual([
            "call 0 completed, then 600 s with no tool run, call, or turn end",
        ]);
    });

    test("F4 counts a same-turn persistence call as follow-up activity", () => {
        const persisted = runWith(
            armOf("eidnara", {
                calls: [
                    call({ seq: 0, started_wall_ms: 0, wall_ms: 400, scenario_ms: 10_000 }),
                    call({ seq: 1, component: "memory_capture", scenario_ms: 10_000 + 120_000 }),
                ],
                journal: [endTurn("eidnara", "e-1", 10_000 + 600_000)],
            }),
        );
        expect(oracle(persisted, "F4")).toEqual([]);
    });

    test("F1 and F2 classify 4xx refusals only; a 5xx carrying the same text is infrastructure", () => {
        const overflow = "ValidationException: prompt is too long: 300000 tokens > 200000 maximum";
        const shape = "messages: roles must alternate between user and assistant";
        const infra = runWith(
            armOf("eidnara", {
                calls: [
                    call({ seq: 0, status: 502, error: overflow }),
                    call({ seq: 1, status: 500, error: shape }),
                    call({ seq: 2, status: 400, error: overflow }),
                    call({ seq: 3, status: 400, error: shape }),
                ],
            }),
        );
        expect(oracle(infra, "F1").map((a) => a.evidence)).toEqual([`400 ${overflow}`]);
        expect(oracle(infra, "F2").map((a) => a.evidence)).toEqual([`400 ${shape}`]);
    });

    test("F9 reads agent-conversation overflows; an auxiliary call's overflow is F1 alone", () => {
        const overflow = "ValidationException: prompt is too long";
        const aux = runWith(
            armOf("eidnara", {
                calls: [call({ component: "memory_capture", status: 400, error: overflow })],
            }),
        );
        expect(oracle(aux, "F1")).toHaveLength(1);
        expect(oracle(aux, "F9")).toEqual([]);
        const agent = runWith(
            armOf("eidnara", { calls: [call({ status: 400, error: overflow })] }),
        );
        expect(oracle(agent, "F9")).toHaveLength(1);
        const turn = runWith(
            armOf("eidnara", { journal: [endTurn("eidnara", "e-1", 0, overflow)] }),
        );
        expect(oracle(turn, "F9")).toHaveLength(1);
    });

    test("F6 is one activation per arm and run, with every exceeded bound as evidence", () => {
        const host = armOf("host", { calls: [call({ arm: "host", input_tokens: 100 })] });
        const costly = armOf("eidnara", {
            calls: [
                call({ seq: 0, input_tokens: 1000 }),
                call({ seq: 1, component: "title", input_tokens: 10 }),
            ],
        });
        const acts = oracle(runWith(host, costly), "F6");
        expect(acts).toHaveLength(1);
        expect(acts[0]?.evidence).toContain("tokens vs host");
        expect(acts[0]?.evidence).toContain("title calls vs host");
    });

    test("a run whose journal lacks an arm's EndArm or the EndRun is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const manifest = { tier: "S", order: ["host"], events: 1 };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({ events: [{ id: "e-1", kind: "session_end" }] }),
        );
        const entries: Record<string, unknown>[] = [
            { kind: "StartRun", arm: null, order: ["host"], seq: 0 },
            { kind: "StartArm", arm: "host", seq: 1 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(/arm host .*0 of 1 events/);
        entries.push(
            { kind: "Event", arm: "host", event: "e-1", seq: 2 },
            { kind: "EndArm", arm: "host", seq: 3 },
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow("no EndRun");
        entries.push({ kind: "EndRun", arm: null, seq: 4 });
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(loadRun(dir, prereg).arms.map((a) => a.arm)).toEqual(["host"]);
    });
});
