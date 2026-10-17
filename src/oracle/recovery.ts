import { parseStoreCheck, type StoreCheck } from "../hosts/storecheck";
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

/**
 * The instant a plugin log line's leading stamp names, or null when the line has none or the
 * stamp names no calendar instant (`Date.parse` would move an impossible day into the next month).
 */
function logMs(line: string): number | null {
    const m = /^\[(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?Z\]/.exec(line);
    if (!m) return null;
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as number[];
    const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
    const date = new Date(
        Date.UTC(year as number, (month as number) - 1, day, hour, minute, second, ms),
    );
    const roundTrips =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month &&
        date.getUTCDate() === day &&
        date.getUTCHours() === hour &&
        date.getUTCMinutes() === minute &&
        date.getUTCSeconds() === second;
    return roundTrips ? date.getTime() : null;
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
    // An entry that anchors a window or a span needs finite coordinates; a malformed one refuses
    // the arm rather than placing every log line outside its windows.
    const finite = (e: Entry, field: "seq" | "wall_ms" | "scenario_ms" | "offset_s"): number => {
        const value = e[field];
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(
                `${arm.arm}: journal entry ${String(e.seq)} (${e.kind}) has no finite ${field}`,
            );
        }
        return value;
    };
    const offsets = arm.journal.filter((e) => e.offset_s !== undefined);
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
            at: (e) => {
                finite(e, "seq");
                return finite(e, "scenario_ms");
            },
            done: (c) => c.scenario_ms + (c.wall_ms - c.started_wall_ms),
            stamps,
        };
    }
    const spans = offsets.map((e, i) => ({
        offset: finite(e, "offset_s") * 1000,
        from: finite(e, "wall_ms"),
        to: offsets[i + 1] ? finite(offsets[i + 1] as Entry, "wall_ms") : Number.POSITIVE_INFINITY,
    }));
    // Two offsets written in one millisecond leave the earlier span empty; the newer owns the instant.
    for (const [i, span] of spans.entries()) {
        if (span.to < span.from) {
            throw new Error(
                `${arm.arm}: clock offset ${String(offsets[i]?.seq)} has a later offset at an earlier wall_ms, so its span runs backward`,
            );
        }
    }
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
    const at = (e: Entry) => {
        finite(e, "seq");
        return finite(e, "wall_ms");
    };
    return { at, done: (c) => c.wall_ms, stamps };
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
    for (const t of turns) {
        if (t.next < t.from) {
            throw new Error(
                `${arm.arm}: turn ${t.event}'s window closes before it opens; its wall times run backward`,
            );
        }
    }
    return turns;
}

/** A fail-open line placed on the timeline; a stamp two offset spans claim appears once per span. */
interface FailOpen {
    at: number;
    /** Log order, so a record pairs with the warning the same pass logged before it. */
    line: number;
    record: boolean;
}

/**
 * The arm's evidence indexed once per arm: calls by turn, and fail-open lines sorted by position,
 * so each turn reads a slice instead of rescanning the run.
 */
interface Evidence {
    callsByTurn: Map<string, Call[]>;
    failOpen: FailOpen[];
}

function indexEvidence(arm: ArmLogs, tl: Timeline): Evidence {
    const callsByTurn = new Map<string, Call[]>();
    for (const c of arm.calls) {
        const turn = String(c.turn);
        callsByTurn.set(turn, [...(callsByTurn.get(turn) ?? []), c]);
    }
    const failOpen: FailOpen[] = [];
    arm.pluginLog.forEach((l, line) => {
        const record = FAIL_OPEN_RECORD.test(l);
        if (!record && !FAIL_OPEN_WARNING.test(l)) return;
        const stamps = tl.stamps(l);
        // A fail-open line the timeline cannot place is evidence the oracle cannot weigh.
        if (stamps.length === 0) {
            throw new Error(
                `${arm.arm}: plugin log line ${line + 1} is a fail-open record without a placeable stamp`,
            );
        }
        for (const at of stamps) failOpen.push({ at, line, record });
    });
    failOpen.sort((a, b) => a.at - b.at || a.line - b.line);
    return { callsByTurn, failOpen };
}

/** The first index in `sorted` whose position is past `at`. */
function upperBound(sorted: FailOpen[], at: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((sorted[mid] as FailOpen).at <= at) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** The first index in `sorted` whose position is at or past `at`. */
function lowerBound(sorted: FailOpen[], at: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((sorted[mid] as FailOpen).at < at) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Fail-open publications in a window: each pass logs a warning and then its record, so a record
 * pairs with the latest unpaired warning before it, and a warning left unpaired (a pass cut off
 * before its record) counts on its own.
 */
function failOpenCount(evidence: Evidence, from: number, to: number): number {
    // A line stamped at the instant the next turn begins is ambiguous at millisecond resolution
    // and counts against both turns, so the upper bound is inclusive.
    const lines = evidence.failOpen
        .slice(lowerBound(evidence.failOpen, from), upperBound(evidence.failOpen, to))
        .sort((a, b) => a.line - b.line);
    let records = 0;
    let unpaired = 0;
    for (const l of lines) {
        if (!l.record) unpaired++;
        else {
            records++;
            if (unpaired > 0) unpaired--;
        }
    }
    return records + unpaired;
}

export function dirtyReasons(evidence: Evidence, turn: Turn, tl: Timeline): string[] {
    const reasons: string[] = [];
    if (String(turn.end.outcome) !== "ok")
        reasons.push(`turn ended ${String(turn.end.outcome).slice(0, 80)}`);
    // The turn's calls, from where its window opens: a mid-turn fault excludes the calls before it.
    const calls = (evidence.callsByTurn.get(turn.event) ?? []).filter(
        (c) => tl.done(c) >= turn.from,
    );
    if (calls.some((c) => c.status >= 400 && c.status < 500)) reasons.push("gateway 4xx");
    if (calls.some((c) => OVERFLOW.test(c.error ?? ""))) reasons.push("overflow");
    const failOpen = failOpenCount(evidence, turn.from, turn.next);
    if (failOpen > 0) reasons.push(`${failOpen} fail-open publications`);
    return reasons;
}

type Checks = Partial<Record<"after_crash" | "post_crash_pass" | "final", StoreCheck | undefined>>;

/** A range's identity; bounds alone when either side of a comparison predates digests. */
const key = (r: StoreCheck["ranges"][number], digests: boolean) =>
    r.slice(0, digests ? 5 : 4).join("/");

/**
 * The wire contract's post-crash rule: the first pass after a crash folds from the surviving
 * history and removes nothing further, so each segment the kill left, inspected before the
 * replacement daemon starts, is still there, bounds and contents, after that pass.
 */
function storeReasons(checks: Checks, postCrash = true): string[] {
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
    if (!postCrash) return reasons;
    const after = checks.after_crash?.ranges ?? [];
    const compared = [...after, ...(checks.post_crash_pass?.ranges ?? [])];
    // Checks recorded before ranges carried digests compare bounds only, which cannot certify
    // the rule, so they withhold recovery while still reporting what they can.
    const digests = compared.every((r) => r.length === 5);
    if (!digests) reasons.push("store ranges lack content digests");
    const kept = new Set((checks.post_crash_pass?.ranges ?? []).map((r) => key(r, digests)));
    const lost = checks.post_crash_pass ? after.filter((r) => !kept.has(key(r, digests))) : [];
    if (lost.length > 0) {
        const names = lost.map((r) => key(r, digests)).join(", ");
        reasons.push(`post-crash pass removed or changed segments ${names}`);
    }
    return reasons;
}

export function recoveries(run: RunLogs): Recovery[] {
    return run.arms.flatMap((arm) => {
        const observations = new Map(
            arm.journal.filter((e) => e.kind === "FaultObserved").map((e) => [e.fault, e]),
        );
        // Each infrastructure fault once, anchored at its FaultFired when the journal has one.
        const anchors = new Map<unknown, Entry>();
        for (const e of arm.journal) {
            const anchored = anchors.get(e.fault);
            if (e.kind === "FaultFired" && INFRA.has(String(e.type))) {
                // The scheduler fires each fault once; a second firing is a malformed journal.
                if (anchored?.kind === "FaultFired") {
                    throw new Error(`${arm.arm}: fault ${String(e.fault)} is fired twice`);
                }
                anchors.set(e.fault, e);
            } else if (e.kind === "FaultObserved" && INFRA.has(String(e.type)) && !anchored)
                anchors.set(e.fault, e);
        }
        if (anchors.size === 0) return [];
        // A journaled fault must be the scheduled one: same id, same type.
        for (const anchor of anchors.values()) {
            const scheduled = run.faultTypes?.get(String(anchor.fault));
            if (run.faultTypes && scheduled === undefined) {
                throw new Error(
                    `${arm.arm}: fault ${String(anchor.fault)} is not in the run's schedule`,
                );
            }
            if (scheduled !== undefined && scheduled !== String(anchor.type)) {
                throw new Error(
                    `${arm.arm}: fault ${String(anchor.fault)} is journaled as ${String(anchor.type)} but scheduled as ${scheduled}`,
                );
            }
        }
        // The timeline and evidence index are built once the first fault needs a verdict.
        let built: { tl: Timeline; indexed: Evidence } | null = null;
        const evidenceOf = () => {
            if (built) return built;
            // An arm whose verdicts depend on the plugin log needs that log on disk; the host
            // control arm runs no plugin, so its faults are judged on its calls and turns alone.
            if (arm.pluginLogMissing && arm.arm !== "host") {
                throw new Error(
                    `${arm.arm}: r/eidnara.log is missing, so fail-open evidence cannot be read`,
                );
            }
            const tl = timeline(arm, run.base_wall_ms ?? Number.NaN);
            built = { tl, indexed: indexEvidence(arm, tl) };
            return built;
        };
        return [...anchors.values()].map((fired): Recovery => {
            // A sleep's evidence is its recorded clock jump: a fault-tagged AdvanceClock that moved
            // the clock forward with the busy set empty, by the scheduled duration when known.
            const scheduledMs = run.sleeps?.get(String(fired.fault));
            const jumped = arm.journal.some((e) => {
                const delta = e.scenario_ms - Number(e.from_ms);
                return (
                    e.kind === "AdvanceClock" &&
                    e.fault === fired.fault &&
                    (scheduledMs === undefined ? delta > 0 : delta === scheduledMs) &&
                    Array.isArray(e.busy) &&
                    e.busy.length === 0
                );
            });
            const observed =
                fired.type === "laptop_sleep"
                    ? jumped
                        ? (observations.get(fired.fault) ?? fired)
                        : undefined
                    : observations.get(fired.fault);
            const evidence = (observed?.evidence ?? {}) as {
                skipped?: unknown;
                store?: StoreCheck;
            };
            const base = { arm: arm.arm, fault: String(fired.fault), type: String(fired.type) };
            if (evidence.skipped !== undefined) {
                // The driver skips with a reason in words; any other shape is malformed evidence.
                if (typeof evidence.skipped !== "string" || evidence.skipped === "") {
                    throw new Error(
                        `${arm.arm}: ${base.fault} FaultObserved has a skipped field that is not a reason`,
                    );
                }
                const reasons = [`skipped: ${evidence.skipped}`];
                return { ...base, turns_to_first_clean: null, recovered: null, reasons };
            }
            const { tl, indexed } = evidenceOf();
            const turns = turnsAfter(arm, fired, tl);
            const dirty = turns.map((t) => dirtyReasons(indexed, t, tl));
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
            const parsed = (value: unknown, where: string) =>
                value === undefined ? undefined : parseStoreCheck(value, where);
            if (base.type === "store_full") {
                // The driver observes a full store as its mount and zero free space.
                const full = evidence as { mount?: unknown; avail_kb?: unknown };
                if (observed && (typeof full.mount !== "string" || full.avail_kb !== 0)) {
                    throw new Error(
                        `${arm.arm}: ${base.fault} store_full evidence does not show a full mount`,
                    );
                }
                // The seam's surviving state: the store stays readable, which the final check shows.
                const final = parsed(arm.finalStore, `${arm.arm}: store-check.json`);
                const store = storeReasons({ final }, false);
                reasons.push(...store);
                return {
                    ...result,
                    reasons,
                    recovered: clean && store.length === 0,
                    store: { final: final?.integrity ?? "unchecked" },
                };
            }
            if (!RESTARTS.has(base.type)) return { ...result, recovered: clean };
            const pass = arm.journal.find(
                (x) => x.kind === "StoreChecked" && x.seq > fired.seq && x.fault === base.fault,
            );
            const checks: Checks = {
                after_crash: parsed(evidence.store, `${arm.arm}: ${base.fault} FaultObserved`),
                post_crash_pass: parsed(pass?.store, `${arm.arm}: ${base.fault} StoreChecked`),
                final: parsed(arm.finalStore, `${arm.arm}: store-check.json`),
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
