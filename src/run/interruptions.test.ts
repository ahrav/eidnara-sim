import { expect, test } from "bun:test";
import { interruptions } from "./interruptions";
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
