import type { RunLogs } from "../oracle/logs";
import { type Activation, runOracles } from "../oracle/oracles";

/** F4's evidence when its one quiet window is the turn's start: `BeginTurn` to the first agent call. */
const TURN_START = /^turn began, then \d+ s with no tool run, call, or turn end$/;

/**
 * The run's oracle activations as the reports count them. A turn that carries an `undelivered`
 * marker stopped inside the user-sim's delivery and a later process delivered it (`docs/run.md`,
 * Undelivered turns), so the quiet F4 reads from that turn's `BeginTurn` to its first agent call
 * spans the harness's stop and restart, and an F4 whose one window is that start is left out.
 * An F4 at such a turn that also names a window after a completed call stays, as does every
 * other activation.
 */
export function measuredActivations(run: RunLogs): Activation[] {
    const redelivered = new Set(
        run.arms.flatMap((a) =>
            a.journal
                .filter(
                    (e) => e.arm === a.arm && e.kind === "ItemState" && e.state === "undelivered",
                )
                .map((e) => `${a.arm}/${String(e.event)}`),
        ),
    );
    return runOracles(run).filter(
        (a) =>
            a.oracle !== "F4" ||
            !redelivered.has(`${a.arm}/${a.at}`) ||
            !TURN_START.test(a.evidence),
    );
}
