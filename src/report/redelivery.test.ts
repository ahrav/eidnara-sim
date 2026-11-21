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
    entry("ItemState", event, scenario_ms, {
        state: "undelivered",
        cause: "harness-exit",
        wall_ms: scenario_ms,
    });
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
/** A call of turn `e-1` that starts at `scenario_ms`, the fixture's wall time too, and runs `ms`. */
const call = (seq: number, scenario_ms: number, ms: number, component = "agent") =>
    ({
        arm: "host",
        seq,
        turn: "e-1",
        component,
        scenario_ms,
        started_wall_ms: scenario_ms,
        wall_ms: scenario_ms + ms,
    }) as unknown as HeldCall;
const agent = (seq: number, scenario_ms: number, ms: number) => call(seq, scenario_ms, ms);
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
    // A user-sim attempt the gateway recorded before the stop belongs to the stopped delivery.
    const attempted = runWith(
        armOf(
            "host",
            [...turn, entry("EndTurn", "e-1", 1_810_000, deadline)],
            [call(99, 1_000, 4_000, "user-sim"), ...calls],
        ),
    );
    expect(f4(attempted)).toEqual([]);
    // A refusal of that attempt is an F1 of the run as recorded, whatever the F4 view leaves out.
    const refused = {
        ...call(99, 1_000, 4_000, "user-sim"),
        status: 400,
        error: "prompt is too long",
    };
    const overflowed = runWith(
        armOf(
            "host",
            [...turn, entry("EndTurn", "e-1", 1_810_000, deadline)],
            [refused as HeldCall, ...calls],
        ),
    );
    expect(measuredActivations(overflowed).map((a) => [a.oracle, a.at, a.component])).toEqual([
        ["F1", "e-1", "user-sim"],
    ]);
});

test("a call belongs to the stopped delivery by its wall time, whatever scenario time it carries", () => {
    // The stopped process's clock ran under the open turn, so its last attempt is stamped at
    // scenario 500 s; the resumed clock restarted at the arm's last entry, and the marker
    // stands at scenario 10 s. The attempt's wall time, 1 s, precedes the marker's, 10 s.
    const stopped = { ...call(99, 1_000, 4_000, "user-sim"), scenario_ms: 500_000 };
    const hung = runWith(
        armOf(
            "host",
            [
                entry("BeginTurn", "e-1", 0),
                marker("e-1", 10_000),
                entry("EndTurn", "e-1", 1_000_400, { outcome: "turn deadline 900000 ms" }),
            ],
            [stopped as HeldCall, agent(1, 1_000_000, 400)],
        ),
    );
    expect(f4(hung)).toEqual([["host", "e-1", "turn deadline after 1 model calls, 990 s silent"]]);
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
    const overflow = { outcome: "prompt is too long" };
    const mixed = runWith(
        armOf("host", [
            ...plain,
            entry("BeginTurn", "e-2", 1_000_000),
            marker("e-2", 1_000_000),
            entry("EndTurn", "e-2", 1_000_100, overflow),
        ]),
        armOf("eidnara", [
            entry("BeginTurn", "e-1", 0),
            marker("e-1", 900_000),
            entry("EndTurn", "e-1", 1_000_000),
        ]),
    );
    expect(f4(mixed)).toEqual([["host", "e-1", quiet(1_000)]]);
    // Every other oracle reads the run as recorded: the redelivered turn's overflow is an F1.
    const rest = (as: ReturnType<typeof runOracles>) =>
        as.filter((a) => a.oracle !== "F4").map((a) => [a.oracle, a.arm, a.at]);
    expect(rest(measuredActivations(mixed))).toEqual([["F1", "host", "e-2"]]);
    expect(rest(runOracles(mixed))).toEqual([["F1", "host", "e-2"]]);
});
