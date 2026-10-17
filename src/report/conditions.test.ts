import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import { continuity, renderConditions, runConditions } from "./conditions";
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
            { arm: "host", sessions: 2, in_order: true, max_lead_ms: 40, max_lag_ms: 25 },
            {
                arm: "eidnara",
                sessions: 2,
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

test("a symlink inside the transcript tree is skipped, so a loop or an escape cannot derail the walk", () => {
    const g = fixture();
    const sessions = join(g.run.dir, "host/r/home/.pi/agent/sessions");
    symlinkSync("..", join(sessions, "p/loop"));
    symlinkSync("/", join(sessions, "p/root"));
    expect(runConditions(g).transcript_order[0]).toMatchObject({ sessions: 2 });
});
