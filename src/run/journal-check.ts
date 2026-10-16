import type { Entry } from "./journal";

export interface JournalReport {
    entries: number;
    next_event_jumps: number;
    sleep_jumps: number;
    /** Each fault-tagged jump's arm, fault id, and landing time, in journal order. */
    sleep_jump_faults: { arm: string; fault: string; to_ms: number }[];
    decreasing_scenario_ms: number[];
    advance_while_busy: number[];
    off_schedule_jumps: number[];
    events_inside_sleep: number[];
    repeated_sleeps: number[];
    /** Scheduled events an arm never journaled as `Event` although it reached `EndArm`. */
    missing_events: { arm: string; event: string }[];
    /** `Event` entries whose id is unknown to the schedule or out of its order, at their seq. */
    out_of_order_events: { arm: string; event: string; seq: number }[];
    /** `AdvanceClock` entries whose `from_ms` differs from the arm's preceding `scenario_ms`. */
    jump_origin_mismatch: number[];
    /** Jobs that held the clock with no turn open, at their `RegisterJob` seq (SIM-P13 coverage). */
    jobs_held_after_turn: { job: string; seq: number }[];
}

/** Scheduled `scenario_ms` by event id. */
export interface Schedule {
    events: Map<string, number>;
}

export function checkJournal(entries: Entry[], schedule: Schedule): JournalReport {
    const report: JournalReport = {
        entries: entries.length,
        next_event_jumps: 0,
        sleep_jumps: 0,
        sleep_jump_faults: [],
        decreasing_scenario_ms: [],
        advance_while_busy: [],
        off_schedule_jumps: [],
        events_inside_sleep: [],
        repeated_sleeps: [],
        missing_events: [],
        out_of_order_events: [],
        jump_origin_mismatch: [],
        jobs_held_after_turn: [],
    };
    const order = [...schedule.events.keys()];
    const position = new Map(order.map((id, i) => [id, i]));
    const cursor = new Map<string, number>();
    const last = new Map<string, number>();
    const open = new Map<string, Set<string>>();
    const ran = new Map<string, Set<string>>();
    const registered = new Map<string, number>();
    const held = new Set<string>();
    const slept = new Set<string>();
    const noTurnOpen = (busy: Set<string>) => [...busy].every((id) => id.startsWith("job:"));
    const holding = (arm: string, busy: Set<string>) => {
        if (!noTurnOpen(busy)) return;
        for (const id of busy) {
            const key = `${arm}/${id}`;
            if (held.has(key)) continue;
            held.add(key);
            report.jobs_held_after_turn.push({ job: id.slice(4), seq: registered.get(key) ?? -1 });
        }
    };
    for (const e of entries) {
        const arm = e.arm ?? "";
        const seq = Number(e.seq);
        const ms = Number(e.scenario_ms);
        const previous = last.get(arm) ?? 0;
        if (ms < previous) report.decreasing_scenario_ms.push(seq);
        last.set(arm, ms);
        const busy = open.get(arm) ?? new Set<string>();
        open.set(arm, busy);
        const done = ran.get(arm) ?? new Set<string>();
        ran.set(arm, done);
        const turn = `turn:${String(e.event)}`;
        if (e.kind === "BeginTurn") busy.add(turn);
        if (e.kind === "EndTurn" || e.state === "failed(interrupted)") {
            busy.delete(turn);
            holding(arm, busy);
        }
        if (e.kind === "Event") {
            const id = String(e.event);
            done.add(id);
            const at = position.get(id);
            const next = cursor.get(arm) ?? 0;
            if (at !== next) report.out_of_order_events.push({ arm, event: id, seq });
            if (at !== undefined) cursor.set(arm, Math.max(next, at + 1));
        }
        if (e.kind === "EndArm") {
            for (const id of schedule.events.keys()) {
                if (!done.has(id)) report.missing_events.push({ arm, event: id });
            }
        }
        if (e.kind === "RegisterJob") {
            const job = `job:${String(e.job)}`;
            registered.set(`${arm}/${job}`, seq);
            busy.add(job);
            holding(arm, busy);
        }
        if (e.kind === "EndJob") busy.delete(`job:${String(e.job)}`);
        if (e.kind !== "AdvanceClock") continue;
        if (busy.size > 0) report.advance_while_busy.push(seq);
        if (Number(e.from_ms) !== previous) report.jump_origin_mismatch.push(seq);
        const from = previous;
        const pending = [...schedule.events].filter(([id]) => !done.has(id)).map(([, t]) => t);
        const later = pending.filter((t) => t > from);
        const crossed = pending.some((t) => t >= from && t < ms);
        const lands = ms > from && later.length > 0 && Math.min(...later) === ms;
        if (crossed || !lands) report.off_schedule_jumps.push(seq);
        if (e.fault === undefined) {
            report.next_event_jumps++;
            continue;
        }
        report.sleep_jumps++;
        report.sleep_jump_faults.push({ arm, fault: String(e.fault), to_ms: ms });
        if (crossed) report.events_inside_sleep.push(seq);
        const sleep = `${arm}/${String(e.fault)}`;
        if (slept.has(sleep)) report.repeated_sleeps.push(seq);
        slept.add(sleep);
    }
    return report;
}
