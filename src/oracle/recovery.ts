import type { StoreCheck } from "../hosts/storecheck";
import type { Entry } from "../run/journal";
import { INFRA_FAULTS } from "../scenario/faults";
import type { ArmLogs, RunLogs } from "./logs";

const INFRA = new Set<string>([...INFRA_FAULTS, "host_upgrade", "two_hosts_one_daemon"]);
const RESTARTS = new Set(["daemon_sigkill_mid_fold", "daemon_restart"]);
/** A failed pass, not a policy decline such as `declined:invocation_budget`, which also serves raw. */
const FAIL_OPEN = /serving the input unchanged|decision=error/;
const OVERFLOW = /prompt is too long|ContextOverflow|input is too long/i;

export interface Recovery {
    arm: string;
    fault: string;
    type: string;
    turns_to_first_clean: number | null;
    /** Null when the arm skipped the fault, so no recovery was asked of it. */
    recovered: boolean | null;
    reasons: string[];
    /** Integrity of each store check, or `unchecked`. */
    store?: Record<string, string>;
}

interface Turn {
    event: string;
    /** Where the turn's log window opens on the arm's timeline: its start, or the fault inside it. */
    from: number;
    end: Entry;
    next: number;
}

/** One timeline for journal entries and plugin log stamps. */
interface Timeline {
    at(e: Entry): number;
    /** The timeline positions a log line's stamp can denote; empty for an unstamped line. */
    stamps(line: string): number[];
}

function logMs(line: string): number | null {
    const stamp = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(line)?.[1];
    return stamp ? Date.parse(stamp) : null;
}

/**
 * Hosts and plugins stamp logs with wall time plus the whole-second offset the harness wrote at
 * the arm's start and at each clock jump (`ClockOffset`), so a stamp maps back to wall time
 * through each offset whose span contains the result. Two spans claim one stamp when an offset
 * shrank; such a line counts in every turn it can belong to. A journal without `ClockOffset`
 * entries is read on scenario time, taking stamps as `base_wall_ms + scenario_ms`.
 */
function timeline(arm: ArmLogs, base: number): Timeline {
    const offsets = arm.journal.filter((e) => e.kind === "ClockOffset");
    if (offsets.length === 0) {
        const stamps = (line: string) => {
            const ms = logMs(line);
            return ms === null ? [] : [ms - base];
        };
        return { at: (e) => e.scenario_ms, stamps };
    }
    const spans = offsets.map((e, i) => ({
        offset: Number(e.offset_s) * 1000,
        from: e.wall_ms,
        to: offsets[i + 1]?.wall_ms ?? Number.POSITIVE_INFINITY,
    }));
    const stamps = (line: string) => {
        const ms = logMs(line);
        if (ms === null) return [];
        return spans
            .map((s) => ms - s.offset)
            .filter((t, i) => {
                const span = spans[i] as (typeof spans)[number];
                return t >= span.from && t < span.to;
            });
    };
    return { at: (e) => e.wall_ms, stamps };
}

/**
 * The turns that end after `fault`, starting with the one a mid-turn fault interrupted. Callers
 * anchor at `FaultFired` when available because the interrupted turn can end before
 * `FaultObserved` is journaled.
 */
function turnsAfter(arm: ArmLogs, fault: Entry, tl: Timeline): Turn[] {
    const begins = new Map<string, Entry>();
    const turns: Turn[] = [];
    for (const e of arm.journal) {
        if (e.kind === "BeginTurn") {
            begins.set(String(e.event), e);
            // The previous turn's window closes here, whether or not this turn ends.
            const last = turns.at(-1);
            if (last && last.next === Number.POSITIVE_INFINITY) last.next = tl.at(e);
        }
        const begin = begins.get(String(e.event));
        if (e.seq > fault.seq && e.kind === "EndTurn" && begin) {
            const from = begin.seq < fault.seq ? tl.at(fault) : tl.at(begin);
            turns.push({ event: String(e.event), from, end: e, next: Number.POSITIVE_INFINITY });
        }
    }
    return turns;
}

export function dirtyReasons(arm: ArmLogs, turn: Turn, tl: Timeline): string[] {
    const reasons: string[] = [];
    if (String(turn.end.outcome) !== "ok")
        reasons.push(`turn ended ${String(turn.end.outcome).slice(0, 80)}`);
    const calls = arm.calls.filter((c) => c.turn === turn.event);
    if (calls.some((c) => c.status >= 400 && c.status < 500)) reasons.push("gateway 4xx");
    if (calls.some((c) => OVERFLOW.test(c.error ?? ""))) reasons.push("overflow");
    const failOpen = arm.pluginLog.filter(
        (l) => FAIL_OPEN.test(l) && tl.stamps(l).some((t) => t >= turn.from && t < turn.next),
    );
    if (failOpen.length > 0) reasons.push(`${failOpen.length} fail-open publications`);
    return reasons;
}

type Checks = Record<"after_crash" | "post_crash_pass" | "final", StoreCheck | undefined>;

const key = (r: StoreCheck["ranges"][number]) => r.join("/");

/**
 * The wire contract's post-crash rule: the first pass after a crash folds from the surviving
 * history and removes nothing further, so each segment the kill left, inspected before the
 * replacement daemon starts, is still there after the arm's next turn.
 */
function storeReasons(checks: Checks): string[] {
    const reasons: string[] = [];
    for (const [name, check] of Object.entries(checks)) {
        const label = name.replaceAll("_", " ");
        if (!check) reasons.push(`store unchecked: ${label}`);
        else if (check.integrity !== "ok")
            reasons.push(`store integrity, ${label}: ${check.integrity}`);
        else if (check.overlaps.length > 0) {
            reasons.push(`${check.overlaps.length} overlapping history segments, ${label}`);
        }
    }
    const after = checks.after_crash?.ranges ?? [];
    const kept = new Set((checks.post_crash_pass?.ranges ?? []).map(key));
    const lost = checks.post_crash_pass ? after.filter((r) => !kept.has(key(r))) : [];
    if (lost.length > 0) {
        reasons.push(`post-crash pass removed or changed segments ${lost.map(key).join(", ")}`);
    }
    return reasons;
}

export function recoveries(run: RunLogs): Recovery[] {
    return run.arms.flatMap((arm) => {
        const tl = timeline(arm, run.base_wall_ms);
        return arm.journal
            .filter((e) => e.kind === "FaultObserved" && INFRA.has(String(e.type)))
            .map((e): Recovery => {
                const evidence = (e.evidence ?? {}) as { skipped?: unknown; store?: StoreCheck };
                const base = { arm: arm.arm, fault: String(e.fault), type: String(e.type) };
                if (evidence.skipped !== undefined) {
                    const reasons = [`skipped: ${String(evidence.skipped)}`];
                    return { ...base, turns_to_first_clean: null, recovered: null, reasons };
                }
                const fired =
                    arm.journal.find((x) => x.kind === "FaultFired" && x.fault === e.fault) ?? e;
                const turns = turnsAfter(arm, fired, tl);
                const dirty = turns.map((t) => dirtyReasons(arm, t, tl));
                const index = dirty.findIndex((r) => r.length === 0);
                const reasons =
                    index < 0
                        ? turns.flatMap((t, i) => (dirty[i] ?? []).map((r) => `${t.event}: ${r}`))
                        : [];
                if (turns.length === 0) reasons.push("no later turn");
                const result = {
                    ...base,
                    turns_to_first_clean: index < 0 ? null : index + 1,
                    reasons,
                };
                if (!RESTARTS.has(base.type)) return { ...result, recovered: index >= 0 };
                const pass = arm.journal.find(
                    (x) => x.kind === "StoreChecked" && x.seq > fired.seq && x.fault === base.fault,
                );
                const checks: Checks = {
                    after_crash: evidence.store,
                    post_crash_pass: pass?.store as StoreCheck | undefined,
                    final: arm.finalStore,
                };
                const store = storeReasons(checks);
                const summary = Object.fromEntries(
                    Object.entries(checks).map(([k, c]) => [k, c?.integrity ?? "unchecked"]),
                );
                reasons.push(...store);
                return {
                    ...result,
                    reasons,
                    recovered: index >= 0 && store.length === 0,
                    store: summary,
                };
            });
    });
}
