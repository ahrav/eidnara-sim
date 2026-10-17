import type { Preregistration, UserSimRate } from "../prereg/schema";
import { Rng } from "../rng";

export const LABELS = [
    "task",
    "pushback",
    "interrupt",
    "redirect",
    "abandon",
    "clarify",
    "paste",
] as const;
export type Label = (typeof LABELS)[number];

export interface PlanTurn {
    id: string;
    session: string;
    index: number;
    role: string;
}

/** The scheduled behaviour of every user turn, the same for every arm of one seed. */
export interface Plan {
    labels: Map<string, Label>;
    /** Turns after an abandon, which the user never sends. */
    skipped: Set<string>;
    interruptMs: Map<string, number>;
}

const REACTIVE_ROLES = new Set(["filler", "conveyance", "update", "reversal"]);

function sample<T>(items: T[], n: number, rng: Rng): T[] {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
    }
    return pool.slice(0, Math.min(n, pool.length));
}

/**
 * Rounded quotas, capped by the eligible turns, bring the rates over a whole scenario close to
 * the pre-registered targets: abandon and redirect per session, then interrupt and pushback per
 * delivered turn. Probe turns are delivered as compiled and carry `task`; pastes carry `paste`.
 * `pinned` turns, the ones a fault fires at, are always sent and never interrupted: an abandon
 * skips only the trailing fillers after the last of them, and the interrupt draw leaves them
 * out, so a fault armed for a turn meets that turn's agent call and runs to its own outcome.
 */
export function behaviourPlan(
    turns: PlanTurn[],
    prereg: Preregistration,
    seed: number,
    pinned: ReadonlySet<string> = new Set(),
): Plan {
    const { rates, interrupt_after_ms: delay } = prereg.user_sim;
    const rng = new Rng((seed ^ 0x75736572) >>> 0);
    const labels = new Map<string, Label>();
    const skipped = new Set<string>();
    const interruptMs = new Map<string, number>();
    const sessions = new Map<string, PlanTurn[]>();
    for (const t of turns) {
        const s = sessions.get(t.session);
        if (s) s.push(t);
        else sessions.set(t.session, [t]);
    }
    for (const t of turns) if (t.role === "paste") labels.set(t.id, "paste");

    const trailing = (s: PlanTurn[]) => {
        let end = s.length;
        while (end > 1 && s[end - 1]?.role === "filler" && !pinned.has(s[end - 1]?.id ?? "")) end--;
        return s.slice(end);
    };
    const quota = (rate: UserSimRate, n: number) => Math.round(Number(rates[rate]) * n);
    const all = [...sessions.values()];
    const abandonable = all.filter((s) => trailing(s).length > 0);
    for (const s of sample(abandonable, quota("abandon_per_session", all.length), rng)) {
        const [first, ...rest] = trailing(s);
        if (first) labels.set(first.id, "abandon");
        for (const t of rest) skipped.add(t.id);
    }
    const free = (t: PlanTurn) => !labels.has(t.id) && !skipped.has(t.id);
    const redirectable = (s: PlanTurn[]) =>
        s.filter((t) => t.index > 0 && t.role === "filler" && free(t));
    const withRedirect = all.filter((s) => redirectable(s).length > 0);
    for (const s of sample(withRedirect, quota("redirect_per_session", all.length), rng)) {
        const [turn] = sample(redirectable(s), 1, rng);
        if (turn) labels.set(turn.id, "redirect");
    }
    const delivered = turns.length - skipped.size;
    const fillers = turns.filter((t) => t.role === "filler" && free(t) && !pinned.has(t.id));
    for (const t of sample(fillers, quota("interrupt_per_turn", delivered), rng)) {
        labels.set(t.id, "interrupt");
        interruptMs.set(t.id, delay.min + Math.floor(rng.next() * (delay.max - delay.min + 1)));
    }
    const reactive = turns.filter((t) => t.index > 0 && REACTIVE_ROLES.has(t.role) && free(t));
    for (const t of sample(reactive, quota("pushback_per_turn", delivered), rng)) {
        labels.set(t.id, "pushback");
    }
    return { labels, skipped, interruptMs };
}

/**
 * The user turns a fault schedule pins: each `user_turn` trigger, for a proxy fault the rest of
 * its session, since a burst, intermittent, or persistent provider fault stays armed for later
 * agent calls of that session, and for a fault whose trigger is a session start or a call the
 * host makes on its own (`first_summarizer_call`) the whole session, since no fixed turn
 * consumes it.
 */
export function pinnedTurns(
    events: readonly { id: string; kind: string; session: string; index?: number }[],
    faults: readonly {
        trigger: { kind: string; session: string; n?: number };
        seam: { layer: string };
    }[],
): Set<string> {
    const pinned = new Set<string>();
    for (const f of faults) {
        const t = f.trigger;
        const fixed = t.kind === "user_turn" && t.n !== undefined;
        const from = fixed ? (t.n as number) - 1 : 0;
        const tail = !fixed || f.seam.layer === "proxy-sink";
        for (const e of events) {
            if (e.kind !== "user_turn" || e.session !== t.session || e.index === undefined)
                continue;
            if (e.index === from || (tail && e.index > from)) pinned.add(e.id);
        }
    }
    return pinned;
}

export interface RealisedRates {
    turns: number;
    sessions: number;
    rates: Record<UserSimRate, number>;
    /** Rates outside their pre-registered band. */
    outside: UserSimRate[];
}

/** Rates over the turns a run delivered, with those outside the pre-registered bands named. */
export function realisedRates(
    delivered: { session: string; label: Label }[],
    prereg: Preregistration,
): RealisedRates {
    const sessions = new Set(delivered.map((t) => t.session)).size;
    const count = (label: Label) => delivered.filter((t) => t.label === label).length;
    const per = (n: number, d: number) => (d === 0 ? 0 : n / d);
    const rates: Record<UserSimRate, number> = {
        pushback_per_turn: per(count("pushback"), delivered.length),
        interrupt_per_turn: per(count("interrupt"), delivered.length),
        redirect_per_session: per(count("redirect"), sessions),
        abandon_per_session: per(count("abandon"), sessions),
    };
    const outside = (Object.keys(rates) as UserSimRate[]).filter((r) => {
        const { min, max } = prereg.user_sim.bands[r];
        return rates[r] < Number(min) || rates[r] > Number(max);
    });
    return { turns: delivered.length, sessions, rates, outside };
}
