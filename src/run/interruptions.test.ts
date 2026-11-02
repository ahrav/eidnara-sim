import { expect, test } from "bun:test";
import { cutTurns, interruptions } from "./interruptions";
import type { Entry } from "./journal";

let seq = 0;
const at = (fields: Record<string, unknown>): Entry =>
    ({ arm: "a", scenario_ms: 0, wall_ms: 0, seq: seq++, ...fields }) as Entry;

test("interruptions count interrupted turns, recovered stops, and daemon exits per arm", () => {
    seq = 0;
    const exit = at({
        kind: "ItemState",
        daemon_exit: { signal: "SIGSEGV" },
        expected: false,
        fatal: true,
    });
    const overrun = at({
        kind: "ItemState",
        job: "agent-1",
        state: "failed",
        error: "busy set held the clock past 1200000 ms: job:agent-1",
        fatal: true,
        arm: "b",
    });
    const entries = [
        at({ kind: "StartArm" }),
        at({ kind: "ItemState", event: "e-1", state: "failed(interrupted)" }),
        exit,
        at({ kind: "Recovered", recovers: exit.seq, cause: "daemon-exit" }),
        at({ kind: "ItemState", event: "e-2", state: "failed(interrupted)", cause: "daemon-exit" }),
        at({ kind: "StartArm", arm: "b" }),
        overrun,
    ];
    expect(interruptions(entries)).toEqual({
        a: {
            interrupted_turns: 2,
            turns_by_cause: { unrecorded: 1, "daemon-exit": 1 },
            stops_by_cause: { "daemon-exit": 1 },
            daemon_exits: 1,
            unresolved: [],
        },
        b: {
            interrupted_turns: 0,
            turns_by_cause: {},
            stops_by_cause: {},
            daemon_exits: 0,
            unresolved: ["job-deadline"],
        },
    });
});

test("cutTurns honors a marker only between its turn's BeginTurn and its interrupted Event", () => {
    seq = 0;
    const turn = (event: string, ...kinds: Record<string, unknown>[]) =>
        kinds.map((k) => at({ event, ...k }));
    const marker = { kind: "ItemState", state: "failed(interrupted)", cause: "harness-exit" };
    const cutEvent = { kind: "Event", outcome: "failed(interrupted)" };
    const entries = [
        ...turn("e-1", { kind: "BeginTurn" }, marker, cutEvent),
        // Before its BeginTurn.
        ...turn("e-2", marker, { kind: "BeginTurn" }, cutEvent),
        // After its EndTurn.
        ...turn("e-3", { kind: "BeginTurn" }, { kind: "EndTurn" }, marker, cutEvent),
        // Closed by an Event that reports the turn ok.
        ...turn("e-4", { kind: "BeginTurn" }, marker, { kind: "Event", outcome: "ok" }),
        // Never closed by an Event.
        ...turn("e-5", { kind: "BeginTurn" }, marker),
    ];
    const { cut, invalid } = cutTurns(entries);
    expect([...cut]).toEqual([["a/e-1", "harness-exit"]]);
    expect(invalid.sort()).toEqual(["a/e-2", "a/e-3", "a/e-4", "a/e-5"]);
});
