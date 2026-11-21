import { expect, test } from "bun:test";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import { loadPrereg } from "../scenario/inputs";
import { measuredActivations } from "./redelivery";

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
type HeldCall = ArmLogs["calls"][number];
const runWith = (journal: ArmLogs["journal"], calls: HeldCall[] = []): RunLogs => ({
    dir: "",
    tier: "S",
    base_wall_ms: 0,
    price: null,
    journal_seq: 0,
    prereg,
    kinds: new Map(),
    arms: [{ arm: "host", calls, journal, pluginLog: [], daemonLog: [], resources: [], tools: [] }],
});
const f4 = (run: RunLogs, read = measuredActivations) =>
    read(run)
        .filter((a) => a.oracle === "F4")
        .map((a) => [a.at, a.evidence]);
const START = "turn began, then 1000 s with no tool run, call, or turn end";
const marker = entry("ItemState", "e-1", 900_000, { state: "undelivered", cause: "harness-exit" });

test("a redelivered turn's quiet start is the harness's stop, and the reports leave that F4 out", () => {
    const turn = [entry("BeginTurn", "e-1", 0), marker, entry("EndTurn", "e-1", 1_000_000)];
    const redelivered = runWith(turn);
    expect(f4(redelivered, runOracles)).toEqual([["e-1", START]]);
    expect(f4(redelivered)).toEqual([]);
});

test("the same quiet start on a turn delivered by its own process stays an F4", () => {
    const own = runWith([entry("BeginTurn", "e-1", 0), entry("EndTurn", "e-1", 1_000_000)]);
    expect(f4(own)).toEqual([["e-1", START]]);
    // A marker names its own turn and arm alone.
    const other = runWith([
        entry("BeginTurn", "e-1", 0),
        entry("EndTurn", "e-1", 1_000_000),
        entry("BeginTurn", "e-2", 1_000_000),
        { ...marker, event: "e-2", scenario_ms: 1_000_000 },
        entry("EndTurn", "e-2", 1_000_100),
    ]);
    expect(f4(other)).toEqual([["e-1", START]]);
    const otherArm = runWith([
        entry("BeginTurn", "e-1", 0),
        { ...marker, arm: "eidnara" },
        entry("EndTurn", "e-1", 1_000_000),
    ]);
    expect(f4(otherArm)).toEqual([["e-1", START]]);
});

test("a redelivered turn that also went quiet after a completed call keeps its F4", () => {
    const call = {
        arm: "host",
        seq: 7,
        turn: "e-1",
        component: "agent",
        scenario_ms: 1_000_000,
        started_wall_ms: 0,
        wall_ms: 400,
    } as unknown as HeldCall;
    const hung = runWith(
        [entry("BeginTurn", "e-1", 0), marker, entry("EndTurn", "e-1", 1_000_400 + 600_000)],
        [call],
    );
    expect(f4(hung)).toEqual([
        [
            "e-1",
            "turn began, then 1000 s; call 7 completed, then 600 s with no tool run, call, or turn end",
        ],
    ]);
});
