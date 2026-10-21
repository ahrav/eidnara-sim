import { describe, expect, test } from "bun:test";
import type { Entry } from "./journal";
import { checkJournal, type Schedule } from "./journal-check";

function journal() {
    const entries: Entry[] = [];
    const at = (kind: Entry["kind"], scenario_ms: number, extra: Record<string, unknown> = {}) =>
        entries.push({ kind, arm: "a", scenario_ms, seq: entries.length, wall_ms: 0, ...extra });
    return { entries, at };
}

const schedule = (events: Record<string, number>): Schedule => ({
    events: new Map(Object.entries(events)),
});

describe("checkJournal", () => {
    test("a clean journal reports its jumps and the jobs that held the clock with no turn open", () => {
        const { entries, at } = journal();
        at("BeginTurn", 0, { event: "e-1" });
        at("RegisterJob", 10, { job: "j0" });
        at("EndTurn", 20, { event: "e-1" });
        at("Event", 20, { event: "e-1" });
        at("EndJob", 25, { job: "j0" });
        at("RegisterJob", 30, { job: "j1" });
        at("EndJob", 40, { job: "j1" });
        at("AdvanceClock", 500, { from_ms: 40, fault: "sleep" });
        at("Event", 500, { event: "e-2" });
        at("AdvanceClock", 600, { from_ms: 500, next_event: "e-3" });
        expect(checkJournal(entries, schedule({ "e-1": 0, "e-2": 500, "e-3": 600 }))).toEqual({
            entries: 10,
            next_event_jumps: 1,
            sleep_jumps: 1,
            sleep_jump_faults: [{ arm: "a", fault: "sleep", to_ms: 500 }],
            decreasing_scenario_ms: [],
            advance_while_busy: [],
            off_schedule_jumps: [],
            events_inside_sleep: [],
            repeated_sleeps: [],
            missing_events: [],
            out_of_order_events: [],
            jump_origin_mismatch: [],
            jobs_held_after_turn: [
                { job: "j0", seq: 1 },
                { job: "j1", seq: 5 },
            ],
        });
    });

    test("each violated invariant names the offending entry", () => {
        const { entries, at } = journal();
        at("RegisterJob", 10, { job: "j" });
        at("AdvanceClock", 400, { from_ms: 10, next_event: "e-3" });
        at("EndJob", 300, { job: "j" });
        at("AdvanceClock", 900, { from_ms: 400, fault: "sleep" });
        const report = checkJournal(entries, schedule({ "e-2": 450, "e-3": 400 }));
        expect(report.advance_while_busy).toEqual([1]);
        expect(report.decreasing_scenario_ms).toEqual([2]);
        expect(report.off_schedule_jumps).toEqual([3]);
        expect(report.events_inside_sleep).toEqual([3]);
    });

    test("a sleep jump lands on its session's first event, whatever the nominal duration", () => {
        const { entries, at } = journal();
        at("EndTurn", 140, { event: "e-1" });
        at("Event", 140, { event: "e-1" });
        at("AdvanceClock", 500, { from_ms: 140, fault: "sleep" });
        const report = checkJournal(entries, schedule({ "e-1": 0, "e-2": 500 }));
        expect([report.sleep_jumps, report.off_schedule_jumps, report.events_inside_sleep]).toEqual(
            [1, [], []],
        );
    });

    test("a job registered inside a turn that outlives the turn counts as held after it", () => {
        const { entries, at } = journal();
        at("BeginTurn", 0, { event: "e-1" });
        at("RegisterJob", 10, { job: "fold" });
        at("EndTurn", 20, { event: "e-1" });
        at("Event", 20, { event: "e-1" });
        at("EndJob", 30, { job: "fold" });
        at("BeginTurn", 30, { event: "e-2" });
        at("RegisterJob", 31, { job: "short" });
        at("EndJob", 32, { job: "short" });
        at("EndTurn", 40, { event: "e-2" });
        const report = checkJournal(entries, schedule({ "e-1": 0, "e-2": 30 }));
        expect(report.jobs_held_after_turn).toEqual([{ job: "fold", seq: 1 }]);
    });

    test("a jump past an unrun event scheduled at from_ms is off schedule", () => {
        const { entries, at } = journal();
        at("AdvanceClock", 500, { from_ms: 200, next_event: "e-2" });
        at("AdvanceClock", 900, { from_ms: 500, fault: "sleep" });
        const report = checkJournal(entries, schedule({ "e-1": 200, "e-2": 500, "e-3": 900 }));
        expect(report.off_schedule_jumps).toEqual([0, 1]);
        expect(report.events_inside_sleep).toEqual([1]);
    });

    test("a second jump for the same sleep fault is reported", () => {
        const { entries, at } = journal();
        at("AdvanceClock", 500, { from_ms: 0, fault: "sleep" });
        at("Event", 500, { event: "e-2" });
        at("AdvanceClock", 900, { from_ms: 500, fault: "sleep" });
        const report = checkJournal(entries, schedule({ "e-2": 500, "e-3": 900 }));
        expect([report.sleep_jumps, report.repeated_sleeps]).toEqual([2, [2]]);
    });

    test("an arm that reached EndArm without journaling every scheduled event is incomplete", () => {
        const { entries, at } = journal();
        at("StartArm", 0);
        at("Event", 0, { event: "e-1" });
        at("AdvanceClock", 900, { from_ms: 0, next_event: "e-3" });
        at("Event", 900, { event: "e-3" });
        at("EndArm", 900);
        const report = checkJournal(entries, schedule({ "e-1": 0, "e-2": 0, "e-3": 900 }));
        expect(report.missing_events).toEqual([{ arm: "a", event: "e-2" }]);
    });

    test("events journaled out of scheduled order, or unknown to the schedule, are reported", () => {
        const { entries, at } = journal();
        at("Event", 0, { event: "e-2" });
        at("Event", 0, { event: "e-1" });
        at("Event", 0, { event: "e-9" });
        at("EndArm", 0);
        const report = checkJournal(entries, schedule({ "e-1": 0, "e-2": 0 }));
        expect(report.out_of_order_events).toEqual([
            { arm: "a", event: "e-2", seq: 0 },
            { arm: "a", event: "e-1", seq: 1 },
            { arm: "a", event: "e-9", seq: 2 },
        ]);
    });

    test("a jump that does not advance is off schedule even between events at one time", () => {
        const { entries, at } = journal();
        at("Event", 500, { event: "e-1" });
        at("AdvanceClock", 500, { from_ms: 500, next_event: "e-2" });
        const report = checkJournal(entries, schedule({ "e-1": 500, "e-2": 500 }));
        expect(report.off_schedule_jumps).toEqual([1]);
        expect(report.jump_origin_mismatch).toEqual([]);
    });

    test("a jump whose claimed origin differs from the arm's previous time is reported", () => {
        const { entries, at } = journal();
        at("Event", 0, { event: "e-0" });
        at("AdvanceClock", 500, { from_ms: 500, next_event: "e-2" });
        const report = checkJournal(entries, schedule({ "e-0": 0, "e-1": 200, "e-2": 500 }));
        expect(report.jump_origin_mismatch).toEqual([1]);
        expect(report.off_schedule_jumps).toEqual([1]);
    });

    test("an entry without a finite scenario time breaks the order", () => {
        const { entries, at } = journal();
        at("Event", 10, { event: "e-0" });
        at("Event", Number.NaN, { event: "e-1" });
        at("Event", 5, { event: "e-2" });
        expect(checkJournal(entries, schedule({})).decreasing_scenario_ms).toEqual([1, 2]);
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
