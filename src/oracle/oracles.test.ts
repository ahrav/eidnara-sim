import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenarioHash } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { type ArmLogs, loadRun, type RunLogs } from "./logs";
import { ledger, ORACLES, oracleReport, rssFit, runOracles } from "./oracles";

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
    base_wall_ms: 0,
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
        const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
        const scenario_hash = scenarioHash(scenario);
        const manifest = { tier: "S", order, events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        writeFileSync(
            join(dir, "calls.jsonl"),
            line(call({ arm: "eidnara", seq: 0 })) + line(call({ arm: "host", seq: 1 })),
        );
        const turn = (arm: string) => [
            { kind: "BeginTurn", arm, event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm, event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm, event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm, scenario_ms: 0 },
        ];
        const journal = [
            { kind: "StartRun", arm: null, order, scenario_ms: 0 },
            { kind: "StartArm", arm: "host", scenario_ms: 0 },
            ...turn("host"),
            ...turn("eidnara"),
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "a\nb\n");
        writeFileSync(join(dir, "eidnara", "daemon.log"), "c\n");
        writeFileSync(join(dir, "eidnara", "resources.jsonl"), line({ scenario_ms: 0, rss: 100 }));
        const run = loadRun(dir, prereg);
        const eidnara = run.arms.find((a) => a.arm === "eidnara");
        expect(run.kinds.get("e-1")).toBe("user_turn");
        expect([eidnara?.calls.length, eidnara?.pluginLog, eidnara?.daemonLog]).toEqual([
            1,
            ["a", "b"],
            ["c"],
        ]);
        expect(run.arms.find((a) => a.arm === "host")?.journal).toHaveLength(5);
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
    base_wall_ms: 0,
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
        const scenario = { events: [{ id: "e-1", kind: "session_end" }] };
        const scenario_hash = scenarioHash(scenario);
        const manifest = { tier: "S", order: ["host"], events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        const entries: Record<string, unknown>[] = [
            { kind: "StartRun", arm: null, order: ["host"], seq: 0, scenario_ms: 0 },
            { kind: "StartArm", arm: "host", seq: 1, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(/arm host .*0 of 1 events/);
        entries.push(
            { kind: "Event", arm: "host", event: "e-1", seq: 2, scenario_ms: 0 },
            { kind: "EndArm", arm: "host", seq: 3, scenario_ms: 0 },
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow("no EndRun");
        entries.push({ kind: "EndRun", arm: null, seq: 4, scenario_ms: 0 });
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(loadRun(dir, prereg).arms.map((a) => a.arm)).toEqual(["host"]);
    });
});

describe("oracle evidence integrity", () => {
    test("a scenario whose digest differs from the manifest's is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const events = [{ id: "e-1", kind: "user_turn" }];
        const scenario_hash = scenarioHash({ events });
        const manifest = { tier: "S", order: ["host"], events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        const journal = [
            { kind: "StartRun", arm: null, order: ["host"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "host", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "host", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm: "host", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "host", scenario_ms: 0 },
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ events, scenario_hash }));
        expect(loadRun(dir, prereg).kinds.get("e-1")).toBe("user_turn");
        const edited = [{ id: "e-1", kind: "session_end" }];
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({ events: edited, scenario_hash }),
        );
        expect(() => loadRun(dir, prereg)).toThrow("scenario_hash");
    });

    test("F5 evaluates each daemon lifetime on its own, so restarts hide no leak", () => {
        const c = Number(prereg.leak_bound.c_bytes_per_session);
        const ends = [1, 2, 3, 4, 5, 6].map((i) => ({
            kind: "Event" as const,
            arm: "eidnara",
            event: `end-${i}`,
            seq: i,
            wall_ms: 0,
            scenario_ms: i * 1000 + 500,
        }));
        const kinds = new Map(ends.map((e) => [e.event, "session_end"]));
        const leak = 3 * c;
        const resources = [1, 2, 3, 4, 5, 6].map((i) => ({
            scenario_ms: i * 1000 + 900,
            pid: i <= 3 ? 100 : 200,
            rss: 100 * c + ((i - 1) % 3) * leak,
        }));
        const run: RunLogs = {
            dir: "",
            tier: "S",
            base_wall_ms: 0,
            prereg,
            kinds,
            arms: [armOf("eidnara", { journal: ends, resources })],
        };
        const acts = oracle(run, "F5");
        expect(acts.map((a) => a.at)).toEqual(["daemon 100", "daemon 200"]);
        expect(acts.every((a) => a.evidence.includes("B/session"))).toBe(true);
        const unsegmented = {
            ...run,
            arms: [
                armOf("eidnara", {
                    journal: ends,
                    resources: resources.map((r) => ({ ...r, pid: 100 })),
                }),
            ],
        };
        expect(oracle(unsegmented, "F5")).toEqual([]);
    });
});

describe("token ledger", () => {
    test("ledger sums all four token fields per component and leaves the harness's own calls out (SIM-P38)", () => {
        const tokens = {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 4,
            cache_write_tokens: 8,
        };
        const arm = armOf("eidnara", {
            calls: [
                call({ seq: 0, component: "agent", ...tokens }),
                call({ seq: 1, component: "agent", ...tokens }),
                call({ seq: 2, component: "memory_capture", ...tokens }),
                call({ seq: 3, component: "title", ...tokens }),
                call({ seq: 4, component: "user-sim", ...tokens }),
                call({ seq: 5, component: "judge", ...tokens }),
                call({ seq: 6, component: "rejected", ...tokens }),
            ],
        });
        const l = ledger(arm);
        expect(l.tokens).toEqual({ agent: 30, memory_capture: 15, title: 15 });
        expect(l.total).toBe(Object.values(l.tokens).reduce((a, b) => a + b, 0));
        expect(l.title_calls).toBe(1);
    });
});

describe("oracle round three", () => {
    const beginTurn = (arm: string, event: string, scenario_ms: number) => ({
        kind: "BeginTurn" as const,
        arm,
        event,
        seq: 0,
        wall_ms: 0,
        scenario_ms,
    });

    test("F4 fires on a long turn with no agent call that ended without a deadline", () => {
        const long = runWith(
            armOf("host", {
                journal: [beginTurn("host", "e-1", 1_000), endTurn("host", "e-1", 1_000 + 400_000)],
            }),
        );
        expect(oracle(long, "F4").map((a) => a.evidence)).toEqual([
            "turn began, then 400 s with no tool run, call, or turn end",
        ]);
        const short = runWith(
            armOf("host", {
                journal: [beginTurn("host", "e-1", 1_000), endTurn("host", "e-1", 1_000 + 200_000)],
            }),
        );
        expect(oracle(short, "F4")).toEqual([]);
    });

    test("an auxiliary call's overflow leaves the same turn's agent overflow in place", () => {
        const overflow = "ValidationException: prompt is too long";
        const both = runWith(
            armOf("eidnara", {
                calls: [call({ component: "memory_capture", status: 400, error: overflow })],
                journal: [endTurn("eidnara", "e-1", 0, overflow)],
            }),
        );
        expect(oracle(both, "F1").map((a) => a.component ?? "turn")).toEqual([
            "memory_capture",
            "turn",
        ]);
        expect(oracle(both, "F9")).toHaveLength(1);
        const agentCall = runWith(
            armOf("eidnara", {
                calls: [call({ status: 400, error: overflow })],
                journal: [endTurn("eidnara", "e-1", 0, overflow)],
            }),
        );
        expect(oracle(agentCall, "F1")).toHaveLength(1);
    });

    test("a completed arm that runs a daemon must have RSS samples", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const order = ["host", "eidnara"];
        const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
        const scenario_hash = scenarioHash(scenario);
        const manifest = { tier: "S", order, events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        const journal = [
            { kind: "StartRun", arm: null, order, scenario_ms: 0 },
            { kind: "BeginTurn", arm: "host", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "host", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm: "host", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "host", scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 0 },
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no daemon RSS samples");
        mkdirSync(join(dir, "eidnara"), { recursive: true });
        writeFileSync(
            join(dir, "eidnara", "resources.jsonl"),
            line({ scenario_ms: 0, rss: null, pid: null }),
        );
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no daemon RSS samples");
        writeFileSync(join(dir, "eidnara", "resources.jsonl"), line({ scenario_ms: 0, rss: 100 }));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no daemon.log");
        writeFileSync(join(dir, "eidnara", "daemon.log"), "");
        writeFileSync(join(dir, "eidnara", "tools.jsonl"), "");
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "");
        expect(loadRun(dir, prereg).arms.map((a) => a.arm)).toEqual(order);
    });
});

describe("oracle round four", () => {
    const beginTurn = (arm: string, event: string, scenario_ms: number) => ({
        kind: "BeginTurn" as const,
        arm,
        event,
        seq: 0,
        wall_ms: 0,
        scenario_ms,
    });

    test("a deadline turn is a hang only with a silent window; one active to the deadline is not", () => {
        const deadline = "turn deadline 900000 ms";
        const every = (step: number) =>
            Array.from({ length: Math.floor(900_000 / step) }, (_, i) =>
                call({
                    seq: i,
                    arm: "host",
                    scenario_ms: i * step,
                    started_wall_ms: 0,
                    wall_ms: 1_000,
                }),
            );
        const active = runWith(
            armOf("host", {
                calls: every(120_000),
                journal: [beginTurn("host", "e-1", 0), endTurn("host", "e-1", 900_000, deadline)],
            }),
        );
        expect(oracle(active, "F4")).toEqual([]);
        const stalled = runWith(
            armOf("host", {
                calls: every(400_000),
                journal: [beginTurn("host", "e-1", 0), endTurn("host", "e-1", 900_000, deadline)],
            }),
        );
        expect(oracle(stalled, "F4").map((a) => a.evidence)).toEqual([
            "turn deadline after 2 model calls, 499 s silent",
        ]);
    });

    test("a call record that fails the proxy's record contract refuses the run", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const order = ["eidnara"];
        const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
        const scenario_hash = scenarioHash(scenario);
        const manifest = { tier: "S", order, events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        const journal = [
            { kind: "StartRun", arm: null, order, scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 0 },
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        mkdirSync(join(dir, "eidnara"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "resources.jsonl"), line({ scenario_ms: 0, rss: 100 }));
        writeFileSync(join(dir, "eidnara", "daemon.log"), "");
        writeFileSync(join(dir, "eidnara", "tools.jsonl"), "");
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "");
        const { output_tokens: _dropped, ...damaged } = call({ seq: 0 });
        writeFileSync(join(dir, "calls.jsonl"), line(damaged));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: output_tokens missing");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0 })));
        expect(loadRun(dir, prereg).arms[0]?.calls).toHaveLength(1);
    });
});

describe("oracle round five", () => {
    test("F4 reads a same-turn call as follow-up only when it starts at or after the evaluated call's end", () => {
        const overlapped = runWith(
            armOf("eidnara", {
                calls: [
                    call({ seq: 0, scenario_ms: 10_000, started_wall_ms: 0, wall_ms: 2_000 }),
                    call({ seq: 1, component: "memory_capture", scenario_ms: 11_500 }),
                ],
                journal: [endTurn("eidnara", "e-1", 12_000 + 600_000)],
            }),
        );
        expect(oracle(overlapped, "F4").map((a) => a.evidence)).toEqual([
            "call 0 completed, then 600 s with no tool run, call, or turn end",
        ]);
    });

    test("F4 measures the silence after a failed agent call too", () => {
        const failed = runWith(
            armOf("eidnara", {
                calls: [
                    call({
                        seq: 0,
                        status: 400,
                        error: "bad request",
                        scenario_ms: 10_000,
                        started_wall_ms: 0,
                        wall_ms: 200,
                    }),
                ],
                journal: [endTurn("eidnara", "e-1", 10_200 + 600_000)],
            }),
        );
        expect(oracle(failed, "F4").map((a) => a.evidence)).toEqual([
            "call 0 completed, then 600 s with no tool run, call, or turn end",
        ]);
    });

    test("a malformed newline-terminated line in an evidence file refuses the run", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const order = ["eidnara"];
        const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
        const scenario_hash = scenarioHash(scenario);
        const manifest = { tier: "S", order, events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        const journal = [
            { kind: "StartRun", arm: null, order, scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 0 },
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        mkdirSync(join(dir, "eidnara"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "daemon.log"), "");
        writeFileSync(join(dir, "eidnara", "tools.jsonl"), "");
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "");
        const good = line({ scenario_ms: 0, rss: 100 });
        writeFileSync(
            join(dir, "eidnara", "resources.jsonl"),
            `${good}{"scenario_ms": 1, "rss":\n`,
        );
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 2/);
        writeFileSync(join(dir, "eidnara", "resources.jsonl"), good);
        expect(loadRun(dir, prereg).arms[0]?.resources).toHaveLength(1);
    });
});

function completeDir(order: string[]): { dir: string; line: (o: unknown) => string } {
    const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
    const scenario_hash = scenarioHash(scenario);
    const manifest = { tier: "S", order, events: 1, scenario_hash };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "calls.jsonl"), "");
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
    const journal = [
        { kind: "StartRun", arm: null, order, scenario_ms: 0 },
        ...order.flatMap((arm) => [
            { kind: "BeginTurn", arm, event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm, event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "Event", arm, event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm, scenario_ms: 0 },
        ]),
        { kind: "EndRun", arm: null, scenario_ms: 0 },
    ];
    writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
    writeFileSync(join(dir, "calls.jsonl"), "");
    for (const arm of order) {
        if (arm.startsWith("..")) continue;
        mkdirSync(join(dir, arm));
        writeFileSync(join(dir, arm, "tools.jsonl"), "");
        if (arm === "host") continue;
        writeFileSync(
            join(dir, arm, "resources.jsonl"),
            line({ scenario_ms: 0, rss: 100, pid: 1 }),
        );
        writeFileSync(join(dir, arm, "daemon.log"), "");
        mkdirSync(join(dir, arm, "r"));
        writeFileSync(join(dir, arm, "r", "eidnara.log"), "");
    }
    return { dir, line };
}

describe("oracle round six", () => {
    test("F4 is one activation per turn, its evidence naming every silent window", () => {
        const twice = runWith(
            armOf("host", {
                calls: [
                    call({
                        seq: 0,
                        arm: "host",
                        scenario_ms: 0,
                        started_wall_ms: 0,
                        wall_ms: 1_000,
                    }),
                    call({
                        seq: 1,
                        arm: "host",
                        scenario_ms: 400_000,
                        started_wall_ms: 0,
                        wall_ms: 1_000,
                    }),
                ],
                journal: [endTurn("host", "e-1", 800_000)],
            }),
        );
        const acts = oracle(twice, "F4");
        expect(acts).toHaveLength(1);
        expect(acts[0]?.evidence).toContain("call 0 completed, then 399 s");
        expect(acts[0]?.evidence).toContain("call 1 completed, then 399 s");
    });

    test("a resource sample without a numeric scenario time, or a tool run without its fields, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        writeFileSync(join(dir, "eidnara", "resources.jsonl"), line({ rss: 100, pid: 1 }));
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 1: scenario_ms/);
        writeFileSync(
            join(dir, "eidnara", "resources.jsonl"),
            line({ scenario_ms: 0, rss: "big", pid: 1 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 1: rss/);
        writeFileSync(
            join(dir, "eidnara", "resources.jsonl"),
            line({ scenario_ms: 0, rss: 100, pid: 1 }),
        );
        writeFileSync(
            join(dir, "eidnara", "tools.jsonl"),
            line({ turn: "e-1", command: "ls", exit: 0 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(/tools\.jsonl: line 1: scenario_ms/);
        writeFileSync(
            join(dir, "eidnara", "tools.jsonl"),
            line({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 1 }),
        );
        expect(loadRun(dir, prereg).arms[0]?.tools).toHaveLength(1);
    });

    test("a call naming an arm outside the manifest, or repeating a sequence number, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, arm: "eidnara-typo" })));
        expect(() => loadRun(dir, prereg)).toThrow(
            "call 0: arm eidnara-typo is not in the manifest",
        );
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0 })) + line(call({ seq: 0 })));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: sequence number repeated");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0 })) + line(call({ seq: 1 })));
        expect(loadRun(dir, prereg).arms[0]?.calls).toHaveLength(2);
    });

    test("a manifest arm outside the pre-registered arm names refuses the run before any path is built", () => {
        const { dir } = completeDir(["../outside"]);
        expect(() => loadRun(dir, prereg)).toThrow(
            "manifest arm ../outside is not a pre-registered arm",
        );
    });
});

describe("oracle round seven", () => {
    const beginTurn = (arm: string, event: string, scenario_ms: number) => ({
        kind: "BeginTurn" as const,
        arm,
        event,
        seq: 0,
        wall_ms: 0,
        scenario_ms,
    });

    test("an auxiliary call does not end the initial agent-silence window", () => {
        const titled = runWith(
            armOf("eidnara", {
                calls: [call({ seq: 0, component: "title", scenario_ms: 60_000 })],
                journal: [beginTurn("eidnara", "e-1", 0), endTurn("eidnara", "e-1", 360_000)],
            }),
        );
        expect(oracle(titled, "F4").map((a) => a.evidence)).toEqual([
            "turn began, then 360 s with no tool run, call, or turn end",
        ]);
    });

    test("a turn whose agent call failed with 5xx overflow wording is infrastructure, not F1", () => {
        const overflow = "ValidationException: prompt is too long";
        const infra = runWith(
            armOf("eidnara", {
                calls: [call({ seq: 0, status: 502, error: overflow })],
                journal: [endTurn("eidnara", "e-1", 0, overflow)],
            }),
        );
        expect(oracle(infra, "F1")).toEqual([]);
        expect(oracle(infra, "F9")).toEqual([]);
    });

    test("a journal entry without its fields, or a daemon arm without daemon.log, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1" },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: "late" },
            { kind: "Event", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 0 },
            { kind: "EndRun", arm: null, scenario_ms: 0 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(/journal\.jsonl: line 2: scenario_ms/);
        const timed = journal.map((e) => ({ ...e, scenario_ms: 5 }));
        writeFileSync(join(dir, "journal.jsonl"), timed.map(line).join(""));
        expect(loadRun(dir, prereg).arms[0]?.journal).toHaveLength(4);
        rmSync(join(dir, "eidnara", "daemon.log"));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no daemon.log");
    });
});

describe("oracle round eight", () => {
    test("an EndTurn without an outcome refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", scenario_ms: 5 },
            { kind: "Event", arm: "eidnara", event: "e-1", scenario_ms: 5 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 5 },
            { kind: "EndRun", arm: null, scenario_ms: 5 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(/journal\.jsonl: line 2: outcome/);
    });
});

describe("oracle round nine", () => {
    test("a scheduled user turn needs its EndTurn, or an interrupted outcome", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
        const scenario_hash = scenarioHash(scenario);
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        const manifest = { tier: "S", order: ["eidnara"], events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        const base = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 9 },
            { kind: "EndRun", arm: null, scenario_ms: 9 },
        ];
        const began = { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 };
        const ended = {
            kind: "EndTurn",
            arm: "eidnara",
            event: "e-1",
            outcome: "ok",
            scenario_ms: 5,
        };
        const event = (outcome: string) => ({
            kind: "Event",
            arm: "eidnara",
            event: "e-1",
            outcome,
            scenario_ms: 5,
        });
        const write = (rows: unknown[]) =>
            writeFileSync(join(dir, "journal.jsonl"), rows.map(line).join(""));
        write([base[0], began, event("ok"), base[1], base[2]]);
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara: turn e-1 has no EndTurn");
        write([base[0], began, ended, ended, event("ok"), base[1], base[2]]);
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara: turn e-1 has 2 EndTurn entries");
        write([base[0], began, ended, event("ok"), base[1], base[2]]);
        expect(loadRun(dir, prereg).arms[0]?.journal).toHaveLength(4);
        write([base[0], began, event("failed(interrupted)"), base[1], base[2]]);
        expect(loadRun(dir, prereg).arms[0]?.journal).toHaveLength(3);
    });

    test("a manifest claiming more events than the scenario holds is refused", () => {
        const { dir } = completeDir(["eidnara"]);
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        const manifest = {
            tier: "S",
            order: ["eidnara"],
            events: 2,
            scenario_hash: scenario.scenario_hash,
        };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        expect(() => loadRun(dir, prereg)).toThrow("manifest events 2 exceeds the scenario's 1");
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, events: 0 }));
        expect(() => loadRun(dir, prereg)).toThrow("manifest events 0");
    });
});

describe("oracle round ten", () => {
    test("a scheduled user turn needs one BeginTurn, and an EndTurn for an unscheduled event is refused", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rows = (extra: unknown[], drop: string[] = []) => {
            const base: Record<string, unknown>[] = [
                { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
                { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 },
                { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
                { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
                { kind: "EndArm", arm: "eidnara", scenario_ms: 9 },
                { kind: "EndRun", arm: null, scenario_ms: 9 },
            ];
            const kept = base.filter((r) => !drop.includes(String(r.kind)));
            writeFileSync(join(dir, "journal.jsonl"), [...kept, ...extra].map(line).join(""));
        };
        rows([], ["BeginTurn"]);
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara: turn e-1 has no BeginTurn");
        rows([
            {
                kind: "EndTurn",
                arm: "eidnara",
                event: "bogus",
                outcome: "prompt is too long",
                scenario_ms: 9,
            },
        ]);
        expect(() => loadRun(dir, prereg)).toThrow(
            "arm eidnara: EndTurn for unscheduled event bogus",
        );
        rows([]);
        expect(loadRun(dir, prereg).arms[0]?.journal).toHaveLength(4);
    });

    test("a call or tool run naming a turn outside the schedule, or negative tokens, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, turn: "e-9" })));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: turn e-9 is not a scheduled user turn");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, input_tokens: -5 })));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: input_tokens negative");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, turn: null })));
        writeFileSync(
            join(dir, "eidnara", "tools.jsonl"),
            line({ turn: "e-9", command: "ls", exit: 0, scenario_ms: 1 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /tools\.jsonl: line 1: turn e-9 is not a scheduled user turn/,
        );
        writeFileSync(
            join(dir, "eidnara", "tools.jsonl"),
            line({ turn: null, command: "ls", exit: 0, scenario_ms: 1 }),
        );
        expect(loadRun(dir, prereg).arms[0]?.tools).toHaveLength(1);
    });

    test("resource samples mix pid presence or pair a numeric RSS with a null pid: refused", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1 }) + line({ scenario_ms: 1, rss: 110 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: pid present on some samples and absent on others/,
        );
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1 }) +
                line({ scenario_ms: 1, rss: 110, pid: null }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 2: numeric rss with a null pid/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100 }) + line({ scenario_ms: 1, rss: 110 }));
        expect(loadRun(dir, prereg).arms[0]?.resources).toHaveLength(2);
    });

    test("F5's absolute bound reads each lifetime's final sample (SIM-P57); a freed spike is not a leak", () => {
        const c = Number(prereg.leak_bound.c_bytes_per_session);
        const run: RunLogs = {
            dir: "",
            tier: "S",
            base_wall_ms: 0,
            prereg,
            kinds: new Map(),
            arms: [
                armOf("eidnara", {
                    resources: [
                        { scenario_ms: 0, rss: 100 * c, pid: 1 },
                        { scenario_ms: 1, rss: 300 * c, pid: 1 },
                        { scenario_ms: 2, rss: 100 * c, pid: 1 },
                    ],
                }),
            ],
        };
        expect(oracle(run, "F5")).toEqual([]);
        const leaked = {
            ...run,
            arms: [
                armOf("eidnara", {
                    resources: [
                        ...(run.arms[0]?.resources ?? []).slice(0, 2),
                        { scenario_ms: 2, rss: 300 * c, pid: 1 },
                    ],
                }),
            ],
        };
        expect(oracle(leaked, "F5").map((a) => a.at)).toEqual(["session 0"]);
    });
});

describe("oracle round eleven", () => {
    test("a negative RSS reading, or a null final reading on a daemon arm, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: -1, pid: 1 }) + line({ scenario_ms: 1, rss: 0, pid: 1 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 1: rss negative/);
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1 }) +
                line({ scenario_ms: 1, rss: null, pid: null }),
        );
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara: final RSS sample has no reading");
    });

    test("a manifest with no arms, or a call with an impossible status, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        const manifest = { tier: "S", order: [], events: 1, scenario_hash: scenario.scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        writeFileSync(
            join(dir, "journal.jsonl"),
            [
                { kind: "StartRun", arm: null, order: [], scenario_ms: 0 },
                { kind: "EndRun", arm: null, scenario_ms: 0 },
            ]
                .map(line)
                .join(""),
        );
        expect(() => loadRun(dir, prereg)).toThrow("manifest names no arms");
        const whole = completeDir(["eidnara"]);
        writeFileSync(join(whole.dir, "calls.jsonl"), whole.line(call({ seq: 0, status: 450.5 })));
        expect(() => loadRun(whole.dir, prereg)).toThrow(
            "call 0: status 450.5 is not an HTTP status",
        );
        writeFileSync(join(whole.dir, "calls.jsonl"), whole.line(call({ seq: 0, status: 0 })));
        expect(loadRun(whole.dir, prereg).arms[0]?.calls).toHaveLength(1);
    });
});

describe("oracle round twelve", () => {
    test("a call whose end precedes its start, or a gap in the sequence numbers, refuses the run", () => {
        const { dir, line } = completeDir(["eidnara"]);
        writeFileSync(
            join(dir, "calls.jsonl"),
            line(call({ seq: 0, started_wall_ms: 500, wall_ms: 100 })),
        );
        expect(() => loadRun(dir, prereg)).toThrow("call 0: wall_ms precedes started_wall_ms");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0 })) + line(call({ seq: 2 })));
        expect(() => loadRun(dir, prereg)).toThrow("call 2: expected sequence number 1");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 1 })));
        expect(() => loadRun(dir, prereg)).toThrow("call 1: expected sequence number 0");
    });

    test("F5 tells daemon lifetimes apart by pid and process start time", () => {
        const c = Number(prereg.leak_bound.c_bytes_per_session);
        const ends = [1, 2, 3, 4, 5, 6].map((i) => ({
            kind: "Event" as const,
            arm: "eidnara",
            event: `end-${i}`,
            seq: i,
            wall_ms: 0,
            scenario_ms: i * 1000 + 500,
        }));
        const kinds = new Map(ends.map((e) => [e.event, "session_end"]));
        const resources = [1, 2, 3, 4, 5, 6].map((i) => ({
            scenario_ms: i * 1000 + 900,
            pid: 100,
            start: i <= 3 ? "1000" : "2000",
            rss: 100 * c + ((i - 1) % 3) * 3 * c,
        }));
        const run: RunLogs = {
            dir: "",
            tier: "S",
            prereg,
            kinds,
            arms: [armOf("eidnara", { journal: ends, resources })],
        };
        expect(oracle(run, "F5").map((a) => a.at)).toEqual(["daemon 100", "daemon 100"]);
    });
});

describe("oracle round thirteen", () => {
    test("pid-bearing samples carry a start time on every row or on none, never null", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1, start: "7" }) +
                line({ scenario_ms: 1, rss: 110, pid: 1 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: start present on some samples and absent on others/,
        );
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1, start: "7" }) +
                line({ scenario_ms: 1, rss: 110, pid: 1, start: null }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 2: pid with a null start/,
        );
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: 100, pid: 1, start: "7" }) +
                line({ scenario_ms: 1, rss: 110, pid: 1, start: "7" }),
        );
        expect(loadRun(dir, prereg).arms[0]?.resources).toHaveLength(2);
    });

    test("journal entries run in scenario order per arm, and the manifest tier matches the scenario's", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 9 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 9 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 9 },
            { kind: "EndRun", arm: null, scenario_ms: 9 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(
            /journal\.jsonl: line 3: scenario_ms 5 precedes 9/,
        );
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        const tiered = { ...scenario, manifest: { tier: "M" } };
        const { scenario_hash: _old, ...body } = tiered;
        const scenario_hash = scenarioHash(body);
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...body, scenario_hash }));
        const manifest = { tier: "S", order: ["eidnara"], events: 1, scenario_hash };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "calls.jsonl"), "");
        for (const arm of manifest.order) {
            mkdirSync(join(dir, arm), { recursive: true });
            writeFileSync(join(dir, arm, "tools.jsonl"), "");
        }
        expect(() => loadRun(dir, prereg)).toThrow("manifest tier S differs from the scenario's M");
    });
});

describe("oracle round fourteen", () => {
    test("resource samples run forward in scenario time, and a turn's call starts inside its journaled interval", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(
            rs,
            line({ scenario_ms: 5, rss: 100, pid: 1 }) + line({ scenario_ms: 4, rss: 110, pid: 1 }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 2: scenario_ms 4 precedes 5/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1 }));
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 10 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 20 },
            { kind: "EndRun", arm: null, scenario_ms: 20 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, scenario_ms: 25 })));
        expect(() => loadRun(dir, prereg)).toThrow(
            "call 0: starts at 25, outside turn e-1 (10 to 20)",
        );
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, scenario_ms: 15 })));
        expect(loadRun(dir, prereg).arms[0]?.calls).toHaveLength(1);
    });

    test("only the harness's turn-deadline wording puts a no-call turn in the deadline branch", () => {
        const quick = runWith(
            armOf("eidnara", {
                journal: [
                    {
                        kind: "BeginTurn",
                        arm: "eidnara",
                        event: "e-1",
                        seq: 0,
                        wall_ms: 0,
                        scenario_ms: 0,
                    },
                    endTurn("eidnara", "e-1", 2_000, "provider error: deadline exceeded"),
                ],
            }),
        );
        expect(oracle(quick, "F4")).toEqual([]);
        const hit = runWith(
            armOf("eidnara", {
                journal: [endTurn("eidnara", "e-1", 900_000, "turn deadline 900000 ms")],
            }),
        );
        expect(oracle(hit, "F4").map((a) => a.evidence)).toEqual([
            "turn deadline with no model call",
        ]);
    });
});

describe("oracle round fifteen", () => {
    test("a tool run attributed to a turn starts inside that turn, and an Eidnara arm has its plugin log", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 10_000 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20_000 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20_000 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 20_000 },
            { kind: "EndRun", arm: null, scenario_ms: 20_000 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        const tools = join(dir, "eidnara", "tools.jsonl");
        writeFileSync(tools, line({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 25_000 }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /tools\.jsonl: line 1: starts at 25000, outside turn e-1/,
        );
        writeFileSync(tools, line({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 10_500 }));
        expect(loadRun(dir, prereg).arms[0]?.tools).toHaveLength(1);
        rmSync(join(dir, "eidnara", "r", "eidnara.log"));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no r/eidnara.log");
    });
});

describe("oracle round sixteen", () => {
    test("a tool run starts at or after its turn's BeginTurn; the slack covers the end only", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 10_000 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20_000 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 20_000 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 20_000 },
            { kind: "EndRun", arm: null, scenario_ms: 20_000 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        const tools = join(dir, "eidnara", "tools.jsonl");
        writeFileSync(tools, line({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 9_500 }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /tools\.jsonl: line 1: starts at 9500, outside turn e-1/,
        );
        writeFileSync(tools, line({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 20_500 }));
        expect(loadRun(dir, prereg).arms[0]?.tools).toHaveLength(1);
    });

    test("pids are positive integers, token counts safe integers, response text a string", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1.5 }));
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 1: pid missing/);
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1 }));
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, input_tokens: 1.5 })));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: input_tokens is not a count");
        writeFileSync(join(dir, "calls.jsonl"), line({ ...call({ seq: 0 }), response_text: 7 }));
        expect(() => loadRun(dir, prereg)).toThrow("call 0: response_text is not a string");
        writeFileSync(
            join(dir, "calls.jsonl"),
            line({ ...call({ seq: 0 }), response_text_truncated: "yes" }),
        );
        expect(() => loadRun(dir, prereg)).toThrow("call 0: response_text_truncated is not true");
    });

    test("each daemon lifetime opens with a numeric reading, and calls.jsonl must exist", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(
            rs,
            line({ scenario_ms: 0, rss: null, pid: 1, start: "1" }) +
                line({ scenario_ms: 1, rss: 100, pid: 1, start: "1" }),
        );
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 1: lifetime opens without a reading/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1, start: "1" }));
        rmSync(join(dir, "calls.jsonl"), { force: true });
        expect(() => loadRun(dir, prereg)).toThrow("run has no calls.jsonl");
        writeFileSync(join(dir, "calls.jsonl"), "");
        expect(loadRun(dir, prereg).arms[0]?.calls).toEqual([]);
    });

    test("a deadline turn's gap search stops at the turn end, so a background call completing later adds no gap", () => {
        const agent = Array.from({ length: 5 }, (_, i) =>
            call({ seq: i, scenario_ms: i * 200_000, started_wall_ms: 0, wall_ms: 1_000 }),
        );
        const late = runWith(
            armOf("eidnara", {
                calls: [
                    ...agent,
                    call({
                        seq: 5,
                        component: "memory_capture",
                        scenario_ms: 899_000,
                        started_wall_ms: 0,
                        wall_ms: 700_000,
                    }),
                ],
                journal: [
                    {
                        kind: "BeginTurn",
                        arm: "eidnara",
                        event: "e-1",
                        seq: 0,
                        wall_ms: 0,
                        scenario_ms: 0,
                    },
                    endTurn("eidnara", "e-1", 900_000, "turn deadline 900000 ms"),
                ],
            }),
        );
        expect(oracle(late, "F4")).toEqual([]);
    });
});

describe("oracle round seventeen", () => {
    test("events end in the compiled order, identities never recur, and RSS and wall values are counts", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const scenario = {
            events: [
                { id: "e-1", kind: "user_turn" },
                { id: "e-2", kind: "session_end" },
            ],
        };
        const scenario_hash = scenarioHash(scenario);
        writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ tier: "S", order: ["eidnara"], events: 2, scenario_hash }),
        );
        const rows = (first: string, second: string) => [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
            { kind: "Event", arm: "eidnara", event: first, outcome: "ok", scenario_ms: 5 },
            { kind: "Event", arm: "eidnara", event: second, outcome: "ok", scenario_ms: 9 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 9 },
            { kind: "EndRun", arm: null, scenario_ms: 9 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), rows("e-2", "e-1").map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow(/arm eidnara is incomplete: .*out of order/);
        writeFileSync(join(dir, "journal.jsonl"), rows("e-1", "e-2").map(line).join(""));
        const rs = join(dir, "eidnara", "resources.jsonl");
        const row = (ms: number, pid: number, rss: number) =>
            line({ scenario_ms: ms, rss, pid, start: String(pid) });
        writeFileSync(rs, row(0, 1, 100) + row(1, 2, 100) + row(2, 1, 100));
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 3: process 1\/1 returns after a later lifetime/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 1e308, pid: 1, start: "1" }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 1: rss is not a byte count/,
        );
        writeFileSync(rs, row(0, 1, 100));
        writeFileSync(
            join(dir, "calls.jsonl"),
            line(call({ seq: 0, started_wall_ms: -1e308, wall_ms: 1e308 })),
        );
        expect(() => loadRun(dir, prereg)).toThrow("call 0: started_wall_ms is not a timestamp");
        writeFileSync(join(dir, "calls.jsonl"), line(call({ seq: 0, scenario_ms: 2 })));
        expect(loadRun(dir, prereg).arms[0]?.calls).toHaveLength(1);
        rmSync(join(dir, "eidnara", "tools.jsonl"));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara has no tools.jsonl");
    });

    test("the RSS slope needs three distinct session counts", () => {
        const c = Number(prereg.leak_bound.c_bytes_per_session);
        const ends = [
            {
                kind: "Event" as const,
                arm: "eidnara",
                event: "end-1",
                seq: 1,
                wall_ms: 0,
                scenario_ms: 1_500,
            },
        ];
        const kinds = new Map([["end-1", "session_end"]]);
        const resources = [
            { scenario_ms: 0, rss: 100 * c, pid: 1, start: "1" },
            { scenario_ms: 1_000, rss: 100 * c, pid: 1, start: "1" },
            { scenario_ms: 2_000, rss: 101 * c + 1, pid: 1, start: "1" },
        ];
        const run: RunLogs = {
            dir: "",
            tier: "S",
            prereg,
            kinds,
            arms: [armOf("eidnara", { journal: ends, resources })],
        };
        expect(oracle(run, "F5")).toEqual([]);
    });
});

describe("oracle round eighteen", () => {
    test("manifest arms belong to the tier's pre-registered run, and journal timestamps are counts", () => {
        const { dir, line } = completeDir(["eidnara-cf"]);
        expect(() => loadRun(dir, prereg)).toThrow(
            "manifest arm eidnara-cf is not in tier S's run",
        );
        const good = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 0.5 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 5 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 5 },
            { kind: "EndRun", arm: null, scenario_ms: 5 },
        ];
        writeFileSync(join(good.dir, "journal.jsonl"), journal.map(good.line).join(""));
        expect(() => loadRun(good.dir, prereg)).toThrow(
            /journal\.jsonl: line 2: scenario_ms is not a count/,
        );
        void line;
    });

    test("an agent call carrying overflow wording at any status stands in for the turn's overflow", () => {
        const overflow = "ValidationException: prompt is too long";
        const streamed = runWith(
            armOf("eidnara", {
                calls: [call({ seq: 0, status: 200, error: overflow })],
                journal: [endTurn("eidnara", "e-1", 0, overflow)],
            }),
        );
        expect(oracle(streamed, "F1")).toEqual([]);
        expect(oracle(streamed, "F9")).toEqual([]);
    });
});

describe("oracle round nineteen", () => {
    const beginTurn = (arm: string, event: string, scenario_ms: number) => ({
        kind: "BeginTurn" as const,
        arm,
        event,
        seq: 0,
        wall_ms: 0,
        scenario_ms,
    });

    test("a tool start does not end the initial agent-call silence window", () => {
        const tooled = runWith(
            armOf("eidnara", {
                tools: [{ turn: "e-1", command: "ls", exit: 0, scenario_ms: 240_000 }],
                journal: [beginTurn("eidnara", "e-1", 0), endTurn("eidnara", "e-1", 600_001)],
            }),
        );
        expect(oracle(tooled, "F4").map((a) => a.evidence)).toEqual([
            "turn began, then 600 s with no tool run, call, or turn end",
        ]);
    });

    test("a call active through a deadline is activity for its whole span", () => {
        const spanning = runWith(
            armOf("eidnara", {
                calls: [call({ seq: 0, scenario_ms: 0, started_wall_ms: 0, wall_ms: 1_000_000 })],
                journal: [
                    beginTurn("eidnara", "e-1", 0),
                    endTurn("eidnara", "e-1", 900_000, "turn deadline 900000 ms"),
                ],
            }),
        );
        expect(oracle(spanning, "F4")).toEqual([]);
    });

    test("a turn's markers come in BeginTurn, EndTurn, Event order", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const journal = [
            { kind: "StartRun", arm: null, order: ["eidnara"], scenario_ms: 0 },
            { kind: "EndTurn", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 0 },
            { kind: "BeginTurn", arm: "eidnara", event: "e-1", scenario_ms: 600_001 },
            { kind: "Event", arm: "eidnara", event: "e-1", outcome: "ok", scenario_ms: 600_001 },
            { kind: "EndArm", arm: "eidnara", scenario_ms: 600_001 },
            { kind: "EndRun", arm: null, scenario_ms: 600_001 },
        ];
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => loadRun(dir, prereg)).toThrow("arm eidnara: turn e-1 markers out of order");
    });
});

describe("oracle round twenty", () => {
    test("sample timestamps and start ticks have the sampler's shapes, and the journal tail parses", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(rs, line({ scenario_ms: 1e308, rss: 100, pid: 1, start: "1" }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 1: scenario_ms is not a count/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1, start: "-1" }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 1: start is not a clock tick/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1, start: "1" }));
        appendFileSync(join(dir, "journal.jsonl"), '{"kind": \n');
        expect(() => loadRun(dir, prereg)).toThrow(/journal\.jsonl: line \d+ is corrupt/);
    });
});

describe("oracle round twenty-one", () => {
    test("a start tick needs a pid and the canonical decimal shape", () => {
        const { dir, line } = completeDir(["eidnara"]);
        const rs = join(dir, "eidnara", "resources.jsonl");
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, start: "1" }));
        expect(() => loadRun(dir, prereg)).toThrow(/resources\.jsonl: line 1: start without a pid/);
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1, start: "01" }));
        expect(() => loadRun(dir, prereg)).toThrow(
            /resources\.jsonl: line 1: start is not a clock tick/,
        );
        writeFileSync(rs, line({ scenario_ms: 0, rss: 100, pid: 1, start: "0" }));
        expect(loadRun(dir, prereg).arms[0]?.resources).toHaveLength(1);
    });

    test("a title call after an agent call is not follow-up progress", () => {
        const titled = runWith(
            armOf("eidnara", {
                calls: [
                    call({ seq: 0, scenario_ms: 10_000, started_wall_ms: 0, wall_ms: 400 }),
                    call({ seq: 1, component: "title", scenario_ms: 12_000 }),
                ],
                journal: [endTurn("eidnara", "e-1", 10_400 + 600_000)],
            }),
        );
        expect(oracle(titled, "F4").map((a) => a.evidence)).toEqual([
            "call 0 completed, then 600 s with no tool run, call, or turn end",
        ]);
    });
});
