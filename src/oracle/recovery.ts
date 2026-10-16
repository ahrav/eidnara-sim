import type { StoreCheck } from "../hosts/storecheck";
import type { Entry } from "../run/journal";
import { INFRA_FAULTS } from "../scenario/faults";
import type { ArmLogs, RunLogs } from "./logs";
import { OVERFLOW } from "./oracles";

const INFRA = new Set<string>([...INFRA_FAULTS, "host_upgrade", "two_hosts_one_daemon"]);
const RESTARTS = new Set(["daemon_sigkill_mid_fold", "daemon_restart"]);
/**
 * A failed pass, not a policy decline such as `declined:invocation_budget`, which also serves raw.
 * The plugin logs one as a warning and then as its pass record; the record counts, and the
 * warning stands in when a window holds warnings alone.
 */
const FAIL_OPEN_RECORD = /decision=error/;
const FAIL_OPEN_WARNING = /serving the input unchanged/;

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

type Call = ArmLogs["calls"][number];

/** One timeline for journal entries, call completions, and plugin log stamps. */
interface Timeline {
    at(e: Entry): number;
    /** When a call completed. */
    done(c: Call): number;
    /** The timeline positions a log line's stamp can denote; empty for an unstamped line. */
    stamps(line: string): number[];
}

function logMs(line: string): number | null {
    const stamp = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(line)?.[1];
    return stamp ? Date.parse(stamp) : null;
}

/**
 * Hosts and plugins stamp logs with wall time plus the whole-second offset the harness wrote at
 * the arm's start (`ClockOffset`) and at each clock jump (`AdvanceClock`, `offset_s`), so a stamp
 * maps back to wall time through each offset whose span contains the result. Two spans claim one
 * stamp when an offset shrank; such a line counts in every turn it can belong to. A journal
 * without offsets is read on scenario time, taking stamps as `base_wall_ms + scenario_ms`; one
 * whose turns began before its first offset has a prefix neither reading covers, so it is refused.
 */
function timeline(arm: ArmLogs, base: number): Timeline {
    const offsets = arm.journal.filter((e) => typeof e.offset_s === "number");
    const first = offsets[0];
    if (first && arm.journal.some((e) => e.kind === "BeginTurn" && e.seq < first.seq)) {
        throw new Error(
            `${arm.arm}: clock journal mixes turns before its first clock offset with offsets after; the run was resumed under a harness that journals offsets`,
        );
    }
    if (offsets.length === 0) {
        const stamps = (line: string) => {
            const ms = logMs(line);
            if (ms === null) return [];
            if (!Number.isFinite(base)) {
                throw new Error(
                    `${arm.arm}: the journal carries no clock offsets and the manifest's base_wall_ms is not a finite number, so log stamps cannot be placed`,
                );
            }
            return [ms - base];
        };
        return {
            at: (e) => e.scenario_ms,
            done: (c) => c.scenario_ms + (c.wall_ms - c.started_wall_ms),
            stamps,
        };
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
    return { at: (e) => e.wall_ms, done: (c) => c.wall_ms, stamps };
}

/** A turn's end: its `EndTurn`, or the `Event` a resume writes for a turn a harness kill cut. */
const endsTurn = (e: Entry) =>
    e.kind === "EndTurn" || (e.kind === "Event" && e.outcome === "failed(interrupted)");

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
        if (e.seq > fault.seq && endsTurn(e) && begin) {
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
    // The turn's calls, from where its window opens: a mid-turn fault excludes the calls before it.
    const calls = arm.calls.filter((c) => c.turn === turn.event && tl.done(c) >= turn.from);
    if (calls.some((c) => c.status >= 400 && c.status < 500)) reasons.push("gateway 4xx");
    if (calls.some((c) => OVERFLOW.test(c.error ?? ""))) reasons.push("overflow");
    const inWindow = (l: string) => tl.stamps(l).some((t) => t >= turn.from && t < turn.next);
    const records = arm.pluginLog.filter((l) => FAIL_OPEN_RECORD.test(l) && inWindow(l)).length;
    const warnings = arm.pluginLog.filter((l) => FAIL_OPEN_WARNING.test(l) && inWindow(l)).length;
    const failOpen = records > 0 ? records : warnings;
    if (failOpen > 0) reasons.push(`${failOpen} fail-open publications`);
    return reasons;
}

type Checks = Record<"after_crash" | "post_crash_pass" | "final", StoreCheck | undefined>;

const key = (r: StoreCheck["ranges"][number]) => r.join("/");

/**
 * The wire contract's post-crash rule: the first pass after a crash folds from the surviving
 * history and removes nothing further, so each segment the kill left, inspected before the
 * replacement daemon starts, is still there, bounds and contents, after that pass.
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
    const compared = [...after, ...(checks.post_crash_pass?.ranges ?? [])];
    // Checks recorded before ranges carried digests compare bounds only, which cannot certify
    // the rule, so they withhold recovery while still reporting what they can.
    if (compared.some((r) => r.length < 5)) reasons.push("store ranges lack content digests");
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
        const observations = new Map(
            arm.journal.filter((e) => e.kind === "FaultObserved").map((e) => [e.fault, e]),
        );
        // Each infrastructure fault once, anchored at its FaultFired when the journal has one.
        const anchors = new Map<unknown, Entry>();
        for (const e of arm.journal) {
            const anchored = anchors.get(e.fault);
            if (e.kind === "FaultFired" && INFRA.has(String(e.type))) anchors.set(e.fault, e);
            else if (e.kind === "FaultObserved" && INFRA.has(String(e.type)) && !anchored)
                anchors.set(e.fault, e);
        }
        return [...anchors.values()].map((fired): Recovery => {
            // A sleep's evidence is its clock jump; the scheduler observes it in the same tick.
            const observed =
                observations.get(fired.fault) ??
                (fired.type === "laptop_sleep" ? fired : undefined);
            const evidence = (observed?.evidence ?? {}) as {
                skipped?: unknown;
                store?: StoreCheck;
            };
            const base = { arm: arm.arm, fault: String(fired.fault), type: String(fired.type) };
            if (evidence.skipped !== undefined) {
                const reasons = [`skipped: ${String(evidence.skipped)}`];
                return { ...base, turns_to_first_clean: null, recovered: null, reasons };
            }
            const turns = turnsAfter(arm, fired, tl);
            const dirty = turns.map((t) => dirtyReasons(arm, t, tl));
            const index = dirty.findIndex((r) => r.length === 0);
            const reasons =
                index < 0
                    ? turns.flatMap((t, i) => (dirty[i] ?? []).map((r) => `${t.event}: ${r}`))
                    : [];
            if (turns.length === 0) reasons.push("no later turn");
            // A kill between FaultFired and FaultObserved leaves the fault without evidence.
            if (!observed) reasons.push("fault not observed: harness interrupted");
            const clean = index >= 0 && observed !== undefined;
            const result = {
                ...base,
                turns_to_first_clean: index < 0 ? null : index + 1,
                reasons,
            };
            if (!RESTARTS.has(base.type)) return { ...result, recovered: clean };
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
                recovered: clean && store.length === 0,
                store: summary,
            };
        });
    });
}
