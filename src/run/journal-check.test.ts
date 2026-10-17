import { describe, expect, test } from "bun:test";
import type { Entry } from "./journal";
import { checkJournal, type Schedule } from "./journal-check";

function journal() {
    const entries: Entry[] = [];
    const at = (kind: Entry["kind"], scenario_ms: number, extra: Record<string, unknown> = {}) =>
        entries.push({ kind, arm: "a", scenario_ms, seq: entries.length, wall_ms: 0, ...extra });
    return { entries, at };
}

const schedule = (
    events: Record<string, number>,
    sleeps: Record<string, number> = {},
): Schedule => ({
    events: new Map(Object.entries(events)),
    sleeps: new Map(Object.entries(sleeps)),
});

describe("checkJournal", () => {
    test("a clean journal reports its jumps and the job held after its turn", () => {
        const { entries, at } = journal();
        at("BeginTurn", 0, { event: "e-1" });
        at("RegisterJob", 10, { job: "j0" });
        at("EndTurn", 20, { event: "e-1" });
        at("Event", 20, { event: "e-1" });
        at("EndJob", 25, { job: "j0" });
        at("RegisterJob", 30, { job: "j1" });
        at("EndJob", 40, { job: "j1" });
        at("AdvanceClock", 140, { from_ms: 40, fault: "sleep" });
        at("AdvanceClock", 500, { from_ms: 140, next_event: "e-2" });
        expect(checkJournal(entries, schedule({ "e-1": 0, "e-2": 500 }, { sleep: 100 }))).toEqual({
            entries: 9,
            next_event_jumps: 1,
            sleep_jumps: 1,
            decreasing_scenario_ms: [],
            advance_while_busy: [],
            off_schedule_jumps: [],
            events_inside_sleep: [],
            jobs_held_after_turn: [{ job: "j1", seq: 5 }],
        });
    });

    test("each violated invariant names the offending entry", () => {
        const { entries, at } = journal();
        at("RegisterJob", 10, { job: "j" });
        at("AdvanceClock", 400, { from_ms: 10, next_event: "e-3" });
        at("EndJob", 300, { job: "j" });
        at("AdvanceClock", 900, { from_ms: 400, fault: "sleep" });
        const report = checkJournal(entries, schedule({ "e-2": 450, "e-3": 400 }, { sleep: 400 }));
        expect(report.advance_while_busy).toEqual([1]);
        expect(report.decreasing_scenario_ms).toEqual([2]);
        expect(report.off_schedule_jumps).toEqual([3]);
        expect(report.events_inside_sleep).toEqual([3]);
    });

    test("a jump whose from_ms is not the arm's clock before it is off schedule", () => {
        const { entries, at } = journal();
        at("Event", 0, { event: "e-0" });
        at("AdvanceClock", 200, { from_ms: 100, next_event: "e-2" });
        expect(
            checkJournal(entries, schedule({ "e-0": 0, "e-1": 100, "e-2": 200 }))
                .off_schedule_jumps,
        ).toEqual([1]);
    });

    test("a jump past an earlier pending event is off schedule", () => {
        const { entries, at } = journal();
        at("AdvanceClock", 500, { from_ms: 0, next_event: "e-2" });
        expect(
            checkJournal(entries, schedule({ "e-1": 200, "e-2": 500 })).off_schedule_jumps,
        ).toEqual([0]);
    });

    test("an interrupted turn and a job ended on resume no longer hold the clock", () => {
        const { entries, at } = journal();
        at("BeginTurn", 0, { event: "e-1" });
        at("RegisterJob", 5, { job: "j" });
        at("ItemState", 5, { event: "e-1", state: "failed(interrupted)" });
        at("Event", 5, { event: "e-1" });
        at("EndJob", 5, { job: "j", interrupted: true });
        at("AdvanceClock", 60, { from_ms: 5, next_event: "e-2" });
        const report = checkJournal(entries, schedule({ "e-1": 0, "e-2": 60 }));
        expect([report.advance_while_busy, report.off_schedule_jumps]).toEqual([[], []]);
    });

    test("arms keep separate clocks", () => {
        const { entries, at } = journal();
        at("Event", 900);
        entries.push({ kind: "StartArm", arm: "b", scenario_ms: 0, seq: 1, wall_ms: 0 });
        expect(checkJournal(entries, schedule({})).decreasing_scenario_ms).toEqual([]);
    });
});
