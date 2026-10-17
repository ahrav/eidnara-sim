import type { Entry } from "./journal";

export interface JournalReport {
    entries: number;
    next_event_jumps: number;
    sleep_jumps: number;
    decreasing_scenario_ms: number[];
    advance_while_busy: number[];
    off_schedule_jumps: number[];
    events_inside_sleep: number[];
    jobs_held_after_turn: { job: string; seq: number }[];
}

export interface Schedule {
    events: Map<string, number>;
    sleeps: Map<string, number>;
}

export function checkJournal(entries: Entry[], schedule: Schedule): JournalReport {
    const report: JournalReport = {
        entries: entries.length,
        next_event_jumps: 0,
        sleep_jumps: 0,
        decreasing_scenario_ms: [],
        advance_while_busy: [],
        off_schedule_jumps: [],
        events_inside_sleep: [],
        jobs_held_after_turn: [],
    };
    const last = new Map<string, number>();
    const open = new Map<string, Set<string>>();
    const ran = new Map<string, Set<string>>();
    for (const e of entries) {
        const arm = e.arm ?? "";
        const seq = Number(e.seq);
        const ms = Number(e.scenario_ms);
        const before = last.get(arm) ?? 0;
        // A time that is not a finite number cannot be shown in order and breaks it.
        if (!Number.isFinite(ms) || ms < before) report.decreasing_scenario_ms.push(seq);
        if (Number.isFinite(ms)) last.set(arm, ms);
        const busy = open.get(arm) ?? new Set<string>();
        open.set(arm, busy);
        const done = ran.get(arm) ?? new Set<string>();
        ran.set(arm, done);
        const turn = `turn:${String(e.event)}`;
        if (e.kind === "BeginTurn") busy.add(turn);
        if (e.kind === "EndTurn" || e.state === "failed(interrupted)") busy.delete(turn);
        if (e.kind === "Event") done.add(String(e.event));
        if (e.kind === "RegisterJob") {
            if (busy.size === 0) report.jobs_held_after_turn.push({ job: String(e.job), seq });
            busy.add(`job:${String(e.job)}`);
        }
        if (e.kind === "EndJob") busy.delete(`job:${String(e.job)}`);
        if (e.kind !== "AdvanceClock") continue;
        if (busy.size > 0) report.advance_while_busy.push(seq);
        // The jump's origin is the arm's clock before it; a record that claims another origin is
        // off schedule whatever destination it names.
        const from = Number(e.from_ms);
        const off = (why: boolean) => {
            if ((why || from !== before) && !report.off_schedule_jumps.includes(seq))
                report.off_schedule_jumps.push(seq);
        };
        const pending = [...schedule.events].filter(([id]) => !done.has(id)).map(([, t]) => t);
        if (e.fault !== undefined) {
            report.sleep_jumps++;
            const duration = schedule.sleeps.get(String(e.fault));
            off(duration !== ms - from);
            if (pending.some((t) => t > from && t < ms)) report.events_inside_sleep.push(seq);
            continue;
        }
        report.next_event_jumps++;
        const later = pending.filter((t) => t > from);
        off(later.length === 0 || Math.min(...later) !== ms);
    }
    return report;
}
