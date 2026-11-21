import { expect, test } from "bun:test";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import { loadPrereg } from "../scenario/inputs";
import { measuredActivations } from "./redelivery";

type HeldCall = ArmLogs["calls"][number];
const prereg = loadPrereg("S");
const entry = (kind: string, event: string, scenario_ms: number, more: object = {}) => ({
    kind: kind as "BeginTurn",
    arm: "host",
    event,
    seq: 0,
    wall_ms: 0,
    scenario_ms,
    ...more,
});
const marker = (event: string, scenario_ms: number) =>
    entry("ItemState", event, scenario_ms, { state: "undelivered", cause: "harness-exit" });
const armOf = (arm: string, journal: ArmLogs["journal"], calls: HeldCall[] = []): ArmLogs => ({
    arm,
    calls,
    journal: journal.map((e) => ({ ...e, arm })),
    pluginLog: [],
    daemonLog: [],
    resources: [],
    tools: [],
});
const runWith = (...arms: ArmLogs[]): RunLogs => ({
    dir: "",
    tier: "S",
    base_wall_ms: 0,
    price: null,
    journal_seq: 0,
    prereg,
    kinds: new Map(),
    arms,
});
/** An agent call of turn `e-1` that starts at `scenario_ms` and runs `ms`. */
const agent = (seq: number, scenario_ms: number, ms: number) =>
    ({
        arm: "host",
        seq,
        turn: "e-1",
        component: "agent",
        scenario_ms,
        started_wall_ms: 0,
        wall_ms: ms,
    }) as unknown as HeldCall;
const f4 = (run: RunLogs, read = measuredActivations) =>
    read(run)
        .filter((a) => a.oracle === "F4")
        .map((a) => [a.arm, a.at, a.evidence]);
const quiet = (s: number) => `turn began, then ${s} s with no tool run, call, or turn end`;

test("a redelivered turn begins at its marker, so the harness's stop before it is no F4", () => {
    // The turn began at 0, stopped inside its delivery, and was delivered from 900 s on.
    const turn = [entry("BeginTurn", "e-1", 0), marker("e-1", 900_000)];
    const redelivered = runWith(armOf("host", [...turn, entry("EndTurn", "e-1", 1_000_000)]));
    expect(f4(redelivered, runOracles)).toEqual([["host", "e-1", quiet(1_000)]]);
    expect(f4(redelivered)).toEqual([]);
    // A turn that then ran to its deadline with calls a minute apart was active throughout.
    const calls = Array.from({ length: 15 }, (_, i) => agent(i, 910_000 + i * 60_000, 60_000));
    const deadline = { outcome: "turn deadline 900000 ms" };
    const busy = runWith(
        armOf("host", [...turn, entry("EndTurn", "e-1", 1_810_000, deadline)], calls),
    );
    expect(f4(busy, runOracles)).toEqual([
        ["host", "e-1", "turn deadline after 15 model calls, 910 s silent"],
    ]);
    expect(f4(busy)).toEqual([]);
});

test("quiet after the marker is the host's, and the turn keeps that F4", () => {
    const hung = runWith(
        armOf("host", [
            entry("BeginTurn", "e-1", 0),
            marker("e-1", 10_000),
            entry("EndTurn", "e-1", 1_010_000),
        ]),
    );
    expect(f4(hung)).toEqual([["host", "e-1", quiet(1_000)]]);
    // A second stop moves the turn's start to its last marker.
    const twice = runWith(
        armOf("host", [
            entry("BeginTurn", "e-1", 0),
            marker("e-1", 10_000),
            marker("e-1", 600_000),
            entry("EndTurn", "e-1", 1_010_000),
        ]),
    );
    expect(f4(twice)).toEqual([["host", "e-1", quiet(410)]]);
    const afterCall = runWith(
        armOf(
            "host",
            [
                entry("BeginTurn", "e-1", 0),
                marker("e-1", 900_000),
                entry("EndTurn", "e-1", 1_000_400 + 600_000),
            ],
            [agent(7, 1_000_000, 400)],
        ),
    );
    expect(f4(afterCall)).toEqual([
        ["host", "e-1", "call 7 completed, then 600 s with no tool run, call, or turn end"],
    ]);
});

test("a marker moves its own arm's turn alone, and a run with no marker reads as recorded", () => {
    const plain = [entry("BeginTurn", "e-1", 0), entry("EndTurn", "e-1", 1_000_000)];
    const own = runWith(armOf("host", plain));
    expect(measuredActivations(own)).toEqual(runOracles(own));
    expect(f4(own)).toEqual([["host", "e-1", quiet(1_000)]]);
    // The other arm redelivered the same event; another turn of this arm carries a marker.
    const mixed = runWith(
        armOf("host", [
            ...plain,
            entry("BeginTurn", "e-2", 1_000_000),
            marker("e-2", 1_000_000),
            entry("EndTurn", "e-2", 1_000_100),
        ]),
        armOf("eidnara", [
            entry("BeginTurn", "e-1", 0),
            marker("e-1", 900_000),
            entry("EndTurn", "e-1", 1_000_000),
        ]),
    );
    expect(f4(mixed)).toEqual([["host", "e-1", quiet(1_000)]]);
    // Every other oracle reads the run as recorded.
    const rest = (as: ReturnType<typeof runOracles>) => as.filter((a) => a.oracle !== "F4");
    expect(rest(measuredActivations(mixed))).toEqual(rest(runOracles(mixed)));
});
