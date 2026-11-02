import type { Entry } from "./journal";
import { fatalCause, isFatal, pendingFatals } from "./scheduler";

export interface ArmInterruptions {
    interrupted_turns: number;
    turns_by_cause: Record<string, number>;
    stops_by_cause: Record<string, number>;
    daemon_exits: number;
    unresolved: string[];
}

export function interruptions(entries: readonly Entry[]): Record<string, ArmInterruptions> {
    const out: Record<string, ArmInterruptions> = {};
    const of = (arm: string): ArmInterruptions => {
        const known = out[arm];
        if (known) return known;
        const fresh: ArmInterruptions = {
            interrupted_turns: 0,
            turns_by_cause: {},
            stops_by_cause: {},
            daemon_exits: 0,
            unresolved: [],
        };
        out[arm] = fresh;
        return fresh;
    };
    const bump = (counts: Record<string, number>, key: string) => {
        counts[key] = (counts[key] ?? 0) + 1;
    };
    for (const e of entries) {
        if (typeof e.arm !== "string") continue;
        if (e.kind === "StartArm") of(e.arm);
        if (e.kind === "ItemState" && e.state === "failed(interrupted)" && e.event !== undefined) {
            const arm = of(e.arm);
            arm.interrupted_turns++;
            bump(arm.turns_by_cause, typeof e.cause === "string" ? e.cause : "unrecorded");
        }
        if (e.kind === "Recovered") bump(of(e.arm).stops_by_cause, String(e.cause));
        if (isFatal(e) && e.daemon_exit !== undefined) of(e.arm).daemon_exits++;
    }
    for (const f of pendingFatals(entries)) {
        if (typeof f.arm === "string") of(f.arm).unresolved.push(fatalCause(f));
    }
    return out;
}

/**
 * The turns a stop cut, read in journal order: a `failed(interrupted)` marker naming an event
 * counts when it follows its arm's `BeginTurn` for that event, comes before any `EndTurn` or
 * `Event` for it, is the turn's only marker, and is followed by the turn's `Event` with outcome
 * `failed(interrupted)` and no `EndTurn` in between. `cut` maps `<arm>/<event>` to the marker's
 * cause; `invalid` names every turn whose markers break that shape, which `cut` leaves out.
 */
export function cutTurns(entries: readonly Entry[]): {
    cut: Map<string, string>;
    invalid: string[];
} {
    const begun = new Set<string>();
    const closed = new Set<string>();
    const pending = new Map<string, string>();
    const cut = new Map<string, string>();
    const bad = new Set<string>();
    for (const e of entries) {
        if (typeof e.event !== "string") continue;
        const key = `${e.arm}/${e.event}`;
        if (e.kind === "BeginTurn") begun.add(key);
        if (e.kind === "EndTurn") {
            if (pending.has(key)) bad.add(key);
            closed.add(key);
        }
        if (e.kind === "ItemState" && e.state === "failed(interrupted)") {
            if (!begun.has(key) || closed.has(key) || pending.has(key) || cut.has(key)) {
                bad.add(key);
            } else pending.set(key, typeof e.cause === "string" ? e.cause : "unrecorded");
        }
        if (e.kind === "Event") {
            const cause = pending.get(key);
            if (cause !== undefined) {
                if (e.outcome === "failed(interrupted)") cut.set(key, cause);
                else bad.add(key);
                pending.delete(key);
            }
            closed.add(key);
        }
    }
    for (const key of pending.keys()) bad.add(key);
    for (const key of bad) cut.delete(key);
    return { cut, invalid: [...bad] };
}
