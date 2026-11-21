import type { ArmLogs, RunLogs } from "../oracle/logs";
import { type Activation, runOracles } from "../oracle/oracles";

/**
 * `arm` with each redelivered turn's `BeginTurn` stamped at the turn's last `undelivered`
 * marker, or `arm` itself when its journal holds no marker.
 */
function fromRedelivery(arm: ArmLogs): ArmLogs {
    const at = new Map<unknown, number>();
    for (const e of arm.journal) {
        if (e.kind === "ItemState" && e.state === "undelivered") at.set(e.event, e.scenario_ms);
    }
    if (at.size === 0) return arm;
    const journal = arm.journal.map((e) =>
        e.kind === "BeginTurn" && at.has(e.event)
            ? { ...e, scenario_ms: at.get(e.event) as number }
            : e,
    );
    return { ...arm, journal };
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
    return [
        ...runOracles(run).filter((a) => a.oracle !== "F4"),
        ...runOracles(view).filter((a) => a.oracle === "F4"),
    ];
}
