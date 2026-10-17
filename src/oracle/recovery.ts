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
    /** Scenario time the turn's log window opens: its start, or the fault inside it. */
    from: number;
    end: Entry;
    next: number;
}

/** The turns that end after the fault, starting with the one a mid-turn fault interrupted. */
function turnsAfter(arm: ArmLogs, fault: Entry): Turn[] {
    const begins = new Map<string, Entry>();
    const turns: Turn[] = [];
    for (const e of arm.journal) {
        if (e.kind === "BeginTurn") begins.set(String(e.event), e);
        const begin = begins.get(String(e.event));
        if (e.seq > fault.seq && e.kind === "EndTurn" && begin) {
            const from = Math.max(begin.scenario_ms, begin.seq < fault.seq ? fault.scenario_ms : 0);
            turns.push({ event: String(e.event), from, end: e, next: Number.POSITIVE_INFINITY });
        }
    }
    turns.forEach((t, i) => {
        t.next = turns[i + 1]?.from ?? Number.POSITIVE_INFINITY;
    });
    return turns;
}

function logMs(line: string): number | null {
    const stamp = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/.exec(line)?.[1];
    return stamp ? Date.parse(stamp) : null;
}

export function dirtyReasons(arm: ArmLogs, turn: Turn, base: number): string[] {
    const reasons: string[] = [];
    if (String(turn.end.outcome) !== "ok")
        reasons.push(`turn ended ${String(turn.end.outcome).slice(0, 80)}`);
    const calls = arm.calls.filter((c) => c.turn === turn.event);
    if (calls.some((c) => c.status >= 400 && c.status < 500)) reasons.push("gateway 4xx");
    if (calls.some((c) => OVERFLOW.test(c.error ?? ""))) reasons.push("overflow");
    const [from, to] = [base + turn.from, base + turn.next];
    const failOpen = arm.pluginLog.filter((l) => {
        const ms = logMs(l);
        return ms !== null && ms >= from && ms < to && FAIL_OPEN.test(l);
    });
    if (failOpen.length > 0) reasons.push(`${failOpen.length} fail-open publications`);
    return reasons;
}

type Checks = Record<"after_restart" | "post_crash_pass" | "final", StoreCheck | undefined>;

const key = (r: StoreCheck["ranges"][number]) => r.join("/");

/**
 * The wire contract's post-crash rule: the first pass after a crash folds from the surviving
 * history and removes nothing further, so each segment the restart left is still there after
 * the arm's next turn.
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
    const after = checks.after_restart?.ranges ?? [];
    const kept = new Set((checks.post_crash_pass?.ranges ?? []).map(key));
    const lost = checks.post_crash_pass ? after.filter((r) => !kept.has(key(r))) : [];
    if (lost.length > 0) {
        reasons.push(`post-crash pass removed or changed segments ${lost.map(key).join(", ")}`);
    }
    return reasons;
}

export function recoveries(run: RunLogs): Recovery[] {
    return run.arms.flatMap((arm) => [...observedRecoveries(run, arm), ...interrupted(arm)]);
}

/** Infrastructure faults a harness stop interrupted after `FaultFired`, each unrecovered. */
function interrupted(arm: ArmLogs): Recovery[] {
    const types = new Map(
        arm.journal
            .filter((e) => e.kind === "FaultFired")
            .map((e) => [String(e.fault), String(e.type)] as const),
    );
    const faults = new Set(
        arm.journal
            .filter(
                (e) =>
                    e.kind === "ItemState" &&
                    e.fault !== undefined &&
                    e.state === "failed(interrupted)",
            )
            .map((e) => String(e.fault)),
    );
    return [...faults]
        .map((fault) => ({ fault, type: types.get(fault) ?? "" }))
        .filter((f) => INFRA.has(f.type))
        .map((f) => ({
            arm: arm.arm,
            fault: f.fault,
            type: f.type,
            turns_to_first_clean: null,
            recovered: false,
            reasons: ["interrupted by a harness stop before its evidence"],
        }));
}

function observedRecoveries(run: RunLogs, arm: ArmLogs): Recovery[] {
    return arm.journal
        .filter((e) => e.kind === "FaultObserved" && INFRA.has(String(e.type)))
        .map((e): Recovery => {
            const evidence = (e.evidence ?? {}) as {
                skipped?: unknown;
                store?: StoreCheck;
                outcome?: unknown;
            };
            const base = { arm: arm.arm, fault: String(e.fault), type: String(e.type) };
            if (evidence.skipped !== undefined) {
                const reasons = [`skipped: ${String(evidence.skipped)}`];
                return { ...base, turns_to_first_clean: null, recovered: null, reasons };
            }
            const turns = turnsAfter(arm, e);
            const dirty = turns.map((t) => dirtyReasons(arm, t, run.base_wall_ms));
            const index = dirty.findIndex((r) => r.length === 0);
            const reasons =
                index < 0
                    ? turns.flatMap((t, i) => (dirty[i] ?? []).map((r) => `${t.event}: ${r}`))
                    : [];
            if (turns.length === 0) reasons.push("no later turn");
            const ownTurnFailed = evidence.outcome !== undefined && evidence.outcome !== "ok";
            if (ownTurnFailed) {
                reasons.push(`the fault's own turn ended ${String(evidence.outcome).slice(0, 80)}`);
            }
            const result = {
                ...base,
                turns_to_first_clean: index < 0 ? null : index + 1,
                reasons,
            };
            if (!RESTARTS.has(base.type)) {
                return { ...result, recovered: index >= 0 && !ownTurnFailed };
            }
            const pass = arm.journal.find(
                (x) => x.kind === "StoreChecked" && x.seq > e.seq && x.fault === base.fault,
            );
            const checks: Checks = {
                after_restart: evidence.store,
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
}
