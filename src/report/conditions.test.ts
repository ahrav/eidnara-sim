import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import {
    continuity,
    recallDrift,
    renderConditions,
    renderDrift,
    runConditions,
} from "./conditions";
import type { GradedRun } from "./observe";

const BASE = 1_792_000_000_000;
const HOUR = 3_600_000;

function fixture(): GradedRun {
    const dir = mkdtempSync(join(tmpdir(), "sim-conditions-"));
    const sessions = join(dir, "host/r/home/.pi/agent/sessions/p");
    mkdirSync(sessions, { recursive: true });
    const stamp = (id: string, ms: number) =>
        writeFileSync(
            join(sessions, `${id}.jsonl`),
            `${JSON.stringify({ type: "session", id, timestamp: new Date(ms).toISOString() })}\n`,
        );
    stamp("sim-s-1", BASE + 40);
    stamp("sim-s-2", BASE + HOUR - 25);
    const db = join(dir, "eidnara/opencode.db");
    mkdirSync(join(dir, "eidnara"), { recursive: true });
    const d = new Database(db);
    d.run("create table session (title text, time_created integer)");
    d.run("insert into session values ('sim-s-1', ?), ('sim-s-2', ?)", [BASE + 2 * HOUR, BASE]);
    d.close();
    writeFileSync(
        join(dir, "host/transcripts.json"),
        JSON.stringify({ paths: [join(dir, "host/r/home/.pi/agent/sessions")], missing: [] }),
    );
    writeFileSync(
        join(dir, "eidnara/transcripts.json"),
        JSON.stringify({ paths: [db], missing: ["/gone"] }),
    );
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            host: "pi",
            seed: 101,
            events: 4,
            preflight: {
                time_injection: [{ name: "pi", intercepted: true, wall_clock_only: false }],
            },
        }),
    );
    const journal = [
        { kind: "Event", event: "e-0", scenario_ms: 0 },
        { kind: "Event", event: "e-2", scenario_ms: HOUR },
    ] as unknown as Entry[];
    const arm = (name: string, tools: ArmLogs["tools"]) =>
        ({ arm: name, journal, tools, calls: [], resources: [] }) as unknown as ArmLogs;
    const read = { turn: "e-1", command: "grep -r cache ~/.pi/agent/sessions", exit: 0 };
    const events = [
        { id: "e-0", kind: "session_start", session: "s-1", scenario_ms: 0 },
        { id: "e-1", kind: "user_turn", session: "s-1" },
        { id: "e-2", kind: "session_start", session: "s-2", scenario_ms: HOUR },
        { id: "e-3", kind: "user_turn", session: "s-2" },
        { id: "e-4", kind: "session_end", session: "s-2" },
    ];
    const grade = (arm: string, probe: string, turn: string, verdict: string) =>
        ({ arm, probe_type: probe, snapshot: `${arm}:q:${turn}`, verdict }) as GradeRecord;
    return {
        run: {
            dir,
            base_wall_ms: BASE,
            kinds: new Map(events.map((e) => [e.id, e.kind])),
            arms: [arm("host", [read as never]), arm("eidnara", [])],
        },
        scenario: { events } as unknown as Scenario,
        grades: [
            grade("host", "P8", "e-1", "pass"),
            grade("host", "P8", "e-3", "pass"),
            grade("host", "P8", "e-3", "fail"),
            grade("eidnara", "P9", "e-3", "pass"),
            grade("eidnara", "P9", "e-3", "excluded"),
            grade("eidnara", "P1", "e-3", "pass"),
        ],
    } as unknown as GradedRun;
}

describe("run conditions", () => {
    test("transcript times read back from both stores are checked against scenario order", () => {
        const g = fixture();
        const c = runConditions(g);
        expect(c).toMatchObject({
            host: "pi",
            seed: 101,
            events: 4,
            events_run: 2,
            scenario_events: 5,
        });
        expect(c.interception).toEqual([{ name: "pi", intercepted: true, wall_clock_only: false }]);
        expect(c.transcript_order).toEqual([
            {
                arm: "host",
                checked: true,
                sessions: 2,
                missing: [],
                in_order: true,
                max_lead_ms: 40,
                max_lag_ms: 25,
            },
            {
                arm: "eidnara",
                checked: true,
                sessions: 2,
                missing: [],
                in_order: false,
                max_lead_ms: 2 * HOUR,
                max_lag_ms: HOUR,
            },
        ]);
        const text = renderConditions([c], continuity([g])).join("\n");
        expect(text).toContain("2 of 4 planned, a capped prefix of 5");
        expect(text).toContain("| /gone |");
    });

    test("P8 and P9 rates carry the v1 band and the passes that read the host's transcripts", () => {
        expect(continuity([fixture()])).toEqual([
            {
                host: "pi",
                arm: "host",
                probe: "P8",
                n: 3,
                pass: 2,
                pass_with_transcript_read: 1,
                v1: [0, 0.03],
            },
            {
                host: "pi",
                arm: "eidnara",
                probe: "P9",
                n: 1,
                pass: 1,
                pass_with_transcript_read: 0,
                v1: [0.99, 1],
            },
        ]);
    });
});

describe("recall drift", () => {
    const row = (arm: string, n: number, pass: number) => ({
        host: "pi",
        arm,
        probe: "P8" as const,
        n,
        pass,
        pass_with_transcript_read: 0,
        v1: null,
    });
    test("a rate outside the reference tier's interval is drift, inside it is within", () => {
        const reference = [row("eidnara", 40, 38), row("host", 40, 1)];
        const drift = recallDrift(
            [row("eidnara", 20, 10), row("host", 20, 1), row("x", 3, 1)],
            reference,
        );
        expect(drift.map((d) => [d.arm, d.drift])).toEqual([
            ["eidnara", true],
            ["host", false],
            ["x", null],
        ]);
        expect(renderDrift(drift, "L").join("\n")).toContain("| pi | eidnara | P8 | 0.50 |");
    });
});
test("a symlink inside the transcript tree is skipped, so a loop or an escape cannot derail the walk", () => {
    const g = fixture();
    const sessions = join(g.run.dir, "host/r/home/.pi/agent/sessions");
    symlinkSync("..", join(sessions, "p/loop"));
    symlinkSync("/", join(sessions, "p/root"));
    expect(runConditions(g).transcript_order[0]).toMatchObject({ sessions: 2 });
});

test("a transcript path in a command counts as a read only with a reading or searching operation", () => {
    const g = fixture();
    const host = g.run.arms[0] as ArmLogs;
    host.tools = [
        { turn: "e-1", command: "rm -rf ~/.pi/agent/sessions", exit: 0, scenario_ms: 0 },
        { turn: "e-1", command: "echo cat ~/.pi/agent/sessions", exit: 0, scenario_ms: 0 },
        {
            turn: "e-1",
            command: "grep x f.txt; echo ~/.pi/agent/sessions",
            exit: 0,
            scenario_ms: 0,
        },
        { turn: "e-1", command: "cat ./opencode.db", exit: 0, scenario_ms: 0 },
        { turn: "e-1", command: "cat notes/sessions/today.jsonl", exit: 0, scenario_ms: 0 },
        {
            turn: "e-3",
            command: "cd /tmp && sqlite3 ~/.local/share/opencode/opencode.db 'select 1'",
            exit: 0,
            scenario_ms: 0,
        },
    ];
    expect(continuity([g])[0]).toMatchObject({
        probe: "P8",
        pass: 2,
        pass_with_transcript_read: 1,
    });
});

test("an arm that never reached its transcript check renders as unchecked, apart from a clean check", () => {
    const g = fixture();
    rmSync(join(g.run.dir, "eidnara/transcripts.json"));
    const c = runConditions(g);
    expect(c.transcripts[1]).toEqual({ arm: "eidnara", paths: [], missing: null });
    expect(c.transcript_order[1]).toMatchObject({ arm: "eidnara", checked: false, missing: [] });
    const text = renderConditions([c], []).join("\n");
    expect(text).toContain("eidnara unchecked");
    expect(text).toContain("| eidnara | unchecked |");
});

test("a reached session with no transcript in the store is named as missing", () => {
    const g = fixture();
    const d = new Database(join(g.run.dir, "eidnara/opencode.db"));
    d.run("delete from session where title = 'sim-s-2'");
    d.close();
    const c = runConditions(g);
    expect(c.transcript_order[1]).toMatchObject({ arm: "eidnara", sessions: 1, missing: ["s-2"] });
    expect(renderConditions([c], []).join("\n")).toContain("| s-2 |");
});

test("a truncated transcripts.json reads as an unchecked arm instead of failing the report", () => {
    const g = fixture();
    writeFileSync(join(g.run.dir, "eidnara/transcripts.json"), "");
    const c = runConditions(g);
    expect(c.transcripts[1]).toEqual({ arm: "eidnara", paths: [], missing: null });
});

test("a transcript root that is itself a symlink is left unread", () => {
    const g = fixture();
    const sessions = join(g.run.dir, "host/r/home/.pi/agent/sessions");
    rmSync(sessions, { recursive: true });
    symlinkSync("/", sessions);
    expect(runConditions(g).transcript_order[0]).toMatchObject({
        sessions: 0,
        missing: ["s-1", "s-2"],
    });
});

test("a transcript root outside the arm directory, through a symlinked ancestor or a persisted path, is left unread", () => {
    const g = fixture();
    const outside = mkdtempSync(join(tmpdir(), "sim-conditions-outside-"));
    mkdirSync(join(outside, "agent/sessions/p"), { recursive: true });
    writeFileSync(
        join(outside, "agent/sessions/p/sim-s-1.jsonl"),
        `${JSON.stringify({ type: "session", id: "sim-s-1", timestamp: new Date(BASE).toISOString() })}\n`,
    );
    const home = join(g.run.dir, "host/r/home");
    rmSync(join(home, ".pi"), { recursive: true });
    symlinkSync(outside, join(home, ".pi"));
    expect(runConditions(g).transcript_order[0]).toMatchObject({ sessions: 0 });
    writeFileSync(
        join(g.run.dir, "host/transcripts.json"),
        JSON.stringify({ paths: [join(outside, "agent/sessions")], missing: [] }),
    );
    expect(runConditions(g).transcript_order[0]).toMatchObject({ sessions: 0 });
});

test("a transcript with no usable creation time counts as missing, not as ordered", () => {
    const g = fixture();
    const sessions = join(g.run.dir, "host/r/home/.pi/agent/sessions/p");
    writeFileSync(
        join(sessions, "sim-s-2.jsonl"),
        `${JSON.stringify({ type: "session", id: "sim-s-2" })}\n`,
    );
    expect(runConditions(g).transcript_order[0]).toMatchObject({
        sessions: 1,
        missing: ["s-2"],
        max_lead_ms: 40,
        max_lag_ms: 0,
    });
});

test("a transcripts.json of the wrong shape reads as an unchecked arm", () => {
    const g = fixture();
    writeFileSync(
        join(g.run.dir, "eidnara/transcripts.json"),
        JSON.stringify({ paths: {}, missing: [] }),
    );
    expect(runConditions(g).transcripts[1]).toEqual({ arm: "eidnara", paths: [], missing: null });
});

test("an OpenCode store that cannot be opened or queried reads as missing transcripts, and the report goes on", () => {
    const g = fixture();
    writeFileSync(join(g.run.dir, "eidnara/opencode.db"), "this is not a database");
    expect(runConditions(g).transcript_order[1]).toMatchObject({
        sessions: 0,
        missing: ["s-1", "s-2"],
    });
});

test("a transcripts.json holding null reads as an unchecked arm", () => {
    const g = fixture();
    writeFileSync(join(g.run.dir, "eidnara/transcripts.json"), "null");
    expect(runConditions(g).transcripts[1]).toEqual({ arm: "eidnara", paths: [], missing: null });
});
