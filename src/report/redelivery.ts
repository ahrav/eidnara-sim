import type { ArmLogs, RunLogs } from "../oracle/logs";
import { type Activation, runOracles } from "../oracle/oracles";

/**
 * `arm` as F4 reads a redelivered turn: the turn's `BeginTurn` stamped at its last `undelivered`
 * marker, and the turn's calls from before that marker left out (a user-sim attempt the gateway
 * recorded before the stop). `arm` itself when its journal holds no marker.
 */
function fromRedelivery(arm: ArmLogs): ArmLogs {
    const at = new Map<unknown, { scenario_ms: number; wall_ms: number }>();
    for (const e of arm.journal) {
        if (e.kind === "ItemState" && e.state === "undelivered") at.set(e.event, e);
    }
    if (at.size === 0) return arm;
    const journal = arm.journal.map((e) => {
        const marker = e.kind === "BeginTurn" ? at.get(e.event) : undefined;
        return marker ? { ...e, scenario_ms: marker.scenario_ms } : e;
    });
    const calls = arm.calls.filter((c) => {
        const marker = at.get(c.turn);
        return marker === undefined || c.started_wall_ms >= marker.wall_ms;
    });
    return { ...arm, journal, calls };
}

/**
 * The run's oracle activations as the reports count them. A turn that carries an `undelivered`
 * marker stopped inside the user-sim's delivery and a later process delivered it (`docs/run.md`,
 * Undelivered turns): its `BeginTurn` precedes the harness's stop and restart, and its marker
 * stands where the delivery started again. F4 measures a turn's quiet from its `BeginTurn`, so
 * F4 is read from a view of the run in which such a turn begins at its marker; every other
 * oracle is read from the run as recorded.
 */
export function measuredActivations(run: RunLogs): Activation[] {
    const view = { ...run, arms: run.arms.map(fromRedelivery) };
    if (view.arms.every((a, i) => a === run.arms[i])) return runOracles(run);
    // The F4 activations follow the others in the list; the reports count them by oracle.
    return [
        ...runOracles(run).filter((a) => a.oracle !== "F4"),
        ...runOracles(view).filter((a) => a.oracle === "F4"),
    ];
}
