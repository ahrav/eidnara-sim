import type { StoreCheck } from "../hosts/storecheck";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { FaultEpisode } from "../scenario/faults";
import { Clock } from "./clock";
import { withDeadline } from "./deadline";
import { type Entry, type EntryKind, HarnessFailure, type Journal } from "./journal";
import type { OffsetWrite } from "./timeinject";

export interface ScenarioEvent {
    id: string;
    kind: "session_start" | "user_turn" | "apply_diff" | "session_end";
    scenario_ms: number;
    session: string;
    index?: number;
    probe?: string;
    [field: string]: unknown;
}

export interface TurnOutcome {
    failed?: string;
    /** Wall time of the host's prompt call alone, journaled on `EndTurn`. */
    prompt_ms?: number;
    snapshot?: string;
    /** Store checks the arm owed daemon restarts, one `StoreChecked` entry each. */
    stores?: { fault: string; store: StoreCheck }[];
    /** The user turn the user-sim sent or skipped, journaled as `UserTurn`. */
    user?: Record<string, unknown>;
    /** The host never received the turn's text. */
    undelivered?: boolean;
}

export interface ArmDriver {
    /** Called at every start of the driver's arm, after `reset`; the handle dies with the arm. */
    bind?(arm: ArmHandle): void;
    reset(): Promise<void>;
    /**
     * Restores a started arm in a new harness process. `open` is the `session_start` of the
     * session the next event belongs to, or null between sessions; `interrupted` names the
     * faults the journal fired and never observed before the kill.
     */
    resume?(open: ScenarioEvent | null, interrupted?: readonly string[]): Promise<void>;
    /** Stops what a killed harness left running, before any fault is armed again. */
    reap?(): Promise<void>;
    /** Whether the driver has a mechanism for the fault; a run refuses an unsupported one before it starts. */
    supports?(f: FaultEpisode): boolean;
    event(e: ScenarioEvent): Promise<TurnOutcome>;
    /** `at` is the scenario event a fault fired at, when a compiled event triggered it. */
    fault(f: FaultEpisode, at?: ScenarioEvent): Promise<Record<string, unknown>>;
    /**
     * Runs the counterfactual deletions due before `e`, passing each to `log` as it returns,
     * which journals it before the next one starts; `done(probe)` holds for a deletion already
     * journaled at `e`, which a resumed arm skips.
     */
    prepare?(
        e: ScenarioEvent,
        log: (deletion: Record<string, unknown>) => void,
        done: (probe: string) => boolean,
    ): Promise<void>;
    /**
     * Stops everything the arm runs, after its last event and before `EndArm`; store checks it
     * still owed are journaled.
     */
    finish?(): Promise<TurnOutcome | undefined | void>;
}

/**
 * The scheduler as one arm sees it. Every call checks that its arm is the one running, so a
 * callback a finished arm left behind is refused instead of writing under the next arm.
 */
export interface ArmHandle {
    jobStart(id: string): void;
    jobEnd(id: string): void;
    observe(component: string): void;
    daemonExited(detail: Record<string, unknown>): void;
}

/** Proxy faults arm per arm, since each arm executes the schedule on its own. */
export interface ProxyControl {
    arm(id: string, arm: string): void;
    disarm(id: string, arm: string): void;
    /** Called at each arm's start, after the driver's reset, so every arm sees one fault schedule. */
    reset(): void;
}

export { HarnessFailure };

/** The identity `StartRun` records and a resume must present again. */
export function scenarioId(events: ScenarioEvent[], faults: FaultEpisode[]): string {
    return sha256Hex(canonicalJson([events, faults]));
}

export interface SchedulerOptions {
    events: ScenarioEvent[];
    faults: FaultEpisode[];
    journal: Journal;
    order: string[];
    drivers: Record<string, ArmDriver>;
    proxy?: ProxyControl;
    jobPollMs?: number;
    /** The longest the busy set may hold the clock before the run stops. */
    idleLimitMs?: number;
    /**
     * When true, every event waits for the busy set to empty, so each user turn starts after
     * all background work. When false (the default), a user turn within an open session starts
     * at its scheduled scenario time whether or not background work is still running, as a real
     * user replies at their own pace; session boundaries and other events still wait.
     */
    turnsAwaitJobs?: boolean;
    /** The longest a failed arm waits for a fault its driver still runs before finishing. */
    faultDrainMs?: number;
    settleMs?: number;
    /**
     * Runs at each arm's start and at every clock jump. A returned record carries the whole-second
     * clock offset the arm's processes now read and the wall instant it took effect, journaled as
     * `offset_s` and `offset_wall_ms`: on a `ClockOffset` entry at the arm's start, and on the
     * jump's own `AdvanceClock` entry otherwise.
     */
    onClock?: (arm: string, scenarioMs: number) => OffsetWrite | undefined;
    /** Runs before `EndArm` and `EndRun` are journaled; a throw leaves the arm or run open. */
    beforeEnd?: () => void;
    /** Runs before `EndArm` and before `EndRun`; a throw leaves the entry unwritten. */
    verify?: (point: "EndArm" | "EndRun") => void | Promise<void>;
    /** A reason to stop; the idle wait and each step check it and fail with `HarnessFailure`. */
    stopped?: () => string | null;
    /** Runs once an arm's `StartArm` is journaled (or its processes reaped), before its first step. */
    onArmReady?: (arm: string) => void;
    /** The arm's realised user-sim rates, journaled as `UserSimRates` before `EndArm`. */
    armSummary?: (arm: string) => object | undefined;
    /**
     * The user record of a turn a kill interrupted, from the driver's own log, journaled as
     * `UserTurn` with `recovered: true` ahead of the turn's `failed(interrupted)` state.
     */
    recoverTurn?: (event: string) => Record<string, unknown> | undefined;
}

const PROXY_LAYER = "proxy-sink";
const OUTAGE = new Set(["daemon_sigkill_mid_fold", "daemon_restart"]);

/**
 * The plain object a driver's record becomes on disk: `v` serialized to JSON and read back,
 * which must still be a non-array object, so the journaled shape and the in-memory one agree.
 */
function plainObject(v: unknown, what: string): Record<string, unknown> {
    let back: unknown;
    try {
        const json = JSON.stringify(v);
        back = json === undefined ? undefined : JSON.parse(json);
    } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        throw new Error(`${what} cannot be serialized: ${error}`);
    }
    if (typeof back !== "object" || back === null || Array.isArray(back)) {
        throw new Error(`${what} is ${describe(back)}`);
    }
    return back as Record<string, unknown>;
}

/** Names a driver's malformed result in an error message. */
function describe(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "an array";
    if (typeof v === "object") {
        const failed = (v as { failed: unknown }).failed;
        if (failed === "ok") return 'an object with failed: "ok", the success literal';
        return `an object with failed: ${typeof failed}`;
    }
    return typeof v;
}

export class Scheduler {
    clock: Clock | null = null;
    private arm: string | null = null;
    private session: string | null = null;
    private outage: string | null = null;
    private readonly fired = new Set<string>();
    private pendingKill: Promise<unknown> | null = null;
    private generation = 0;
    /** The driver's latest fault call, which the fatal channel can cut while it still runs. */
    private faultCall: Promise<unknown> | null = null;
    /** Faults the journal fired and never observed on the arm being resumed. */
    private interrupted: string[] = [];
    /** The running arm's handle; the public job, observe, and exit calls route through it. */
    private current: ArmHandle | null = null;
    /** Counts every job start and end, so a job that begins and ends between two polls still resets the quiet window. */
    private jobActivity = 0;
    /** Each live job's `RegisterJob` on the monotonic clock, for its own idle deadline. */
    private readonly jobStarted = new Map<string, number>();
    private fatal: HarnessFailure | null = null;
    private failed: Promise<never> | null = null;
    private fail: ((error: HarnessFailure) => void) | null = null;

    constructor(private readonly o: SchedulerOptions) {
        if (!o.proxy && o.faults.some((f) => f.seam.layer === PROXY_LAYER)) {
            throw new Error("scheduler: proxy faults are scheduled but no proxy control was given");
        }
        const seen = new Set<string>();
        // The jump across a session's idle gap carries at most one sleep.
        const sleepers = new Map<string, string>();
        for (const f of o.faults) {
            if (typeof f.id !== "string" || f.id === "") {
                throw new Error(`fault id must be a non-empty string, got ${JSON.stringify(f.id)}`);
            }
            if (seen.has(f.id)) throw new Error(`fault id ${f.id} is scheduled twice`);
            seen.add(f.id);
            const duration = f.params.duration_ms;
            // A sleep's duration bounds its jump: a whole count of milliseconds the journal can hold.
            const positive =
                typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0;
            if (f.type === "laptop_sleep" && !positive) {
                throw new Error(`laptop_sleep ${f.id} needs a positive duration_ms`);
            }
            if (f.type === "laptop_sleep") {
                const session = String(f.trigger.session);
                const other = sleepers.get(session);
                if (other !== undefined) {
                    throw new Error(
                        `laptop_sleep ${f.id} targets session ${session}, which ${other} already sleeps before`,
                    );
                }
                sleepers.set(session, f.id);
            }
        }
    }

    /**
     * A journal append that must land has failed: the failure is fatal for this process, and the
     * run directory is marked failed on disk so a later process cannot resume past it.
     */
    private poison(what: string, caught: unknown): void {
        const error = caught instanceof Error ? caught.message : String(caught);
        this.fatal ??= new HarnessFailure(`${what}: ${error}`);
        this.fail?.(this.fatal);
        this.o.journal.poison(`${what}: ${error}`);
    }

    /**
     * Appends a record that must land: when the append fails the run is poisoned under `what`
     * before the failure propagates, so a later process cannot resume past the gap.
     */
    private record(entry: { kind: EntryKind; [field: string]: unknown }, what: string): Entry {
        try {
            return this.log(entry);
        } catch (caught) {
            this.poison(`${what}: its record could not be journaled`, caught);
            throw caught;
        }
    }

    /**
     * Appends the record of a failure that is fatal for the run, then rejects the fatal channel
     * so every in-flight driver call is cut: the record lands first, so the paths the channel
     * wakes find it on disk, and a record that cannot land has already poisoned the run.
     */
    private recordFatal(entry: { kind: EntryKind; [field: string]: unknown }, what: string): void {
        try {
            this.record(entry, what);
        } catch {
            return;
        } finally {
            if (this.fatal) this.fail?.(this.fatal);
        }
    }

    /**
     * Journals the store checks an outcome returned, one `StoreChecked` per fault per arm: a
     * resumed driver can take a check again for a fault whose entry already landed.
     */
    private logStores(stores: TurnOutcome["stores"], event: string | null): void {
        for (const s of stores ?? []) {
            const already = this.o.journal.entries.some(
                (e) => e.kind === "StoreChecked" && e.arm === this.arm && e.fault === s.fault,
            );
            if (!already) {
                this.record({ kind: "StoreChecked", event, ...s }, `store check for ${s.fault}`);
            }
        }
    }

    private log(entry: { kind: EntryKind; [field: string]: unknown }): Entry {
        return this.o.journal.append({
            ...entry,
            arm: this.arm,
            scenario_ms: this.clock?.now() ?? 0,
        });
    }

    async run(): Promise<void> {
        if (new Set(this.o.order).size !== this.o.order.length) {
            throw new Error(`scheduler: arm order ${JSON.stringify(this.o.order)} repeats an arm`);
        }
        const preflights = this.o.journal.entries.filter((e) => e.kind === "Preflight");
        const scoped = preflights.find((e) => e.arm !== null || e.scenario_ms !== 0);
        if (scoped) throw new Error(`journal: Preflight carries an arm scope (seq ${scoped.seq})`);
        // The run's counterfactual sample is a run-level entry the runner journals before
        // `StartRun`, unscoped like a Preflight.
        const sample = this.o.journal.entries.filter((e) => e.kind === "CounterfactualSample");
        const misplaced = sample.find((e) => e.arm !== null || e.scenario_ms !== 0);
        if (misplaced) {
            throw new Error(
                `journal: CounterfactualSample carries an arm scope (seq ${misplaced.seq})`,
            );
        }
        if (sample.length > 1) throw new Error("journal: CounterfactualSample appears twice");
        // Lifecycle replay requires `StartRun` as the first lifecycle entry.
        const entries = this.o.journal.entries.filter(
            (e) => e.kind !== "Preflight" && e.kind !== "CounterfactualSample",
        );
        const fatal = entries.find((e) => e.kind === "ItemState" && e.fatal === true);
        if (fatal) {
            const cause = fatal.fault
                ? `fault ${fatal.fault} failed`
                : fatal.event
                  ? `event ${fatal.event} failed`
                  : "the daemon exited outside an outage window";
            throw new HarnessFailure(`run failed: ${cause}`);
        }
        const finished = new Set(entries.filter((e) => e.kind === "EndArm").map((e) => e.arm));
        const scenario = scenarioId(this.o.events, this.o.faults);
        const start = entries[0]?.kind === "StartRun" ? entries[0] : undefined;
        if (!start && entries.length > 0) {
            throw new Error("journal: StartRun is not the first entry");
        }
        this.checkJournal(entries, scenario);
        if (entries.at(-1)?.kind === "EndRun") return;
        for (const arm of this.o.order) {
            if (!finished.has(arm) && !this.o.drivers[arm])
                throw new Error(`no driver for arm ${arm}`);
        }
        for (const arm of this.o.order) {
            if (finished.has(arm)) continue;
            const driver = this.o.drivers[arm];
            const owned = this.o.faults.filter((f) => f.seam.layer !== PROXY_LAYER);
            const refused = owned.find((f) => driver?.supports?.(f) === false);
            if (refused) {
                throw new HarnessFailure(
                    `scheduler: arm ${arm} has no mechanism for fault type ${refused.type} (${refused.id})`,
                );
            }
        }
        if (!start) {
            this.log({ kind: "StartRun", order: this.o.order, scenario });
        } else {
            this.log({ kind: "ResumeRun", order: this.o.order, scenario });
        }
        for (const arm of this.o.order) {
            const mine = entries.filter((e) => e.arm === arm);
            if (mine.some((e) => e.kind === "EndArm")) continue;
            this.arm = arm;
            const started = mine.some((e) => e.kind === "StartArm");
            const startMs = started ? (mine.at(-1)?.scenario_ms ?? 0) : 0;
            const onClock = (ms: number): Partial<OffsetWrite> => this.o.onClock?.(arm, ms) ?? {};
            const clock = new Clock(startMs, this.o.journal, undefined, onClock);
            // The offset in effect until the first jump rides on a `ClockOffset` entry.
            const logOffset = (written: Partial<OffsetWrite>) => {
                if (written.offset_s !== undefined) {
                    this.record({ kind: "ClockOffset", ...written }, `clock offset of ${arm}`);
                }
            };
            this.clock = clock;
            this.jobStarted.clear();
            const driver = this.o.drivers[arm] as ArmDriver;
            let ended = false;
            let finishing = false;
            let priorJobs = new Set<string>();
            try {
                this.session = this.openSession(mine);
                for (const e of mine) {
                    const restored =
                        e.kind === "FaultFired" || (e.kind === "ItemState" && e.state === "missed");
                    if (restored && typeof e.fault === "string") {
                        this.fired.add(`${arm}/${e.fault}`);
                    }
                }
                try {
                    // The arm's time begins at StartArm, so a fresh arm's clock holds through its
                    // reset; on a resume, the killed harness's processes, which read the shared
                    // clock too, are reaped before the restored time is published.
                    if (!started) clock.hold();
                    try {
                        if (started) {
                            if (driver.reap) await this.untilFatal(driver.reap());
                            logOffset(onClock(startMs));
                        } else {
                            const initial = onClock(startMs);
                            await this.untilFatal(driver.reset());
                            this.log({ kind: "StartArm" });
                            logOffset(initial);
                        }
                    } finally {
                        clock.release();
                    }
                    this.o.proxy?.reset();
                    const answered = this.resume(mine);
                    const handle = this.handle(++this.generation, driver);
                    this.current = handle;
                    driver.bind?.(handle);
                    this.o.onArmReady?.(arm);
                    // A resume restores the driver's recorded daemon and owed store checks, and
                    // reopens the session the next pending event belongs to; a pending
                    // `session_end` closes nothing the killed harness still had open, and an arm
                    // with no event left resumes with no session, so its finish still checks
                    // the restored store.
                    const delivered = new Set(
                        this.o.journal.entries
                            .filter((e) => e.arm === arm && e.kind === "Event")
                            .map((e) => e.event as string),
                    );
                    const next = this.o.events.find((e) => !delivered.has(e.id));
                    if (started && driver.resume) {
                        const open =
                            !next || next.kind === "session_end"
                                ? null
                                : this.openStart(this.session);
                        await this.untilFatal(driver.resume(open, this.interrupted));
                    }
                    if (answered.length > 0) {
                        await this.untilFatal(Bun.sleep(this.o.settleMs ?? 1_000));
                    }
                    await this.pendingKill;
                    if (this.fatal) throw this.fatal;
                    for (const e of answered) {
                        this.snapshotTurn(e);
                        this.record(
                            { kind: "Event", event: e.event, outcome: e.outcome },
                            `recovered event ${e.event}`,
                        );
                    }
                    const done = new Set(
                        this.o.journal.entries
                            .filter((e) => e.arm === arm && e.kind === "Event")
                            .map((e) => e.event as string),
                    );
                    for (const e of this.o.events) {
                        if (!done.has(e.id)) await this.step(driver, e);
                    }
                    await this.quiesce();
                    // A job the shutdown itself starts holds the clock too; it ends before the
                    // arm does.
                    finishing = true;
                    priorJobs = new Set(this.clock?.busyIds() ?? []);
                    if (driver.finish) {
                        const last = await this.untilFatal(driver.finish());
                        this.logStores(last ? last.stores : undefined, null);
                    }
                    await this.idle();
                } catch (caught) {
                    // A failed arm still stops what it runs, so nothing it started outlives it;
                    // a job the finish itself starts ends before the failure surfaces, and one
                    // the failed work left open is the resume's to close, as after a kill.
                    await this.pendingKill?.catch(() => undefined);
                    // A fault the fatal channel cut still runs in the driver; it settles before
                    // the finish, so a restart cannot start a daemon after the arm stopped it.
                    if (this.faultCall) {
                        const settled = this.faultCall.catch(() => undefined);
                        await withDeadline(settled, this.o.faultDrainMs ?? 30_000);
                    }
                    if (!finishing) {
                        priorJobs = new Set(this.clock?.busyIds() ?? []);
                        await driver.finish?.().catch(() => undefined);
                    }
                    await this.drainNew(priorJobs);
                    throw caught;
                } finally {
                    await this.pendingKill?.catch(() => undefined);
                }
                this.o.beforeEnd?.();
                await this.o.verify?.("EndArm");
                this.checkStop();
                // A kill between the summary and EndArm resumes here; the arm keeps its one summary.
                const summarised = this.o.journal.entries.some(
                    (e) => e.arm === arm && e.kind === "UserSimRates",
                );
                const rates = summarised ? undefined : this.o.armSummary?.(arm);
                if (rates) this.log({ kind: "UserSimRates", ...rates });
                this.log({ kind: "EndArm" });
                ended = true;
            } finally {
                this.generation++;
                this.current = null;
                this.faultCall = null;
                this.pendingKill = null;
                this.outage = null;
                this.session = null;
                this.arm = null;
                this.clock = null;
                if (!ended) {
                    for (const f of this.o.faults) {
                        if (f.seam.layer === PROXY_LAYER) this.o.proxy?.disarm(f.id, arm);
                    }
                }
            }
        }
        if (this.fatal) throw this.fatal;
        this.o.beforeEnd?.();
        await this.o.verify?.("EndRun");
        this.checkStop();
        this.log({ kind: "EndRun" });
    }

    /**
     * Refuses a journal whose entries contradict the scheduler's lifecycle, replayed in order:
     * `StartRun` first and once, every `ResumeRun` naming this run's arm order and scenario,
     * `EndRun` last and only after every arm ended; arms started in the configured order, one
     * at a time, each `StartArm` preceding all of its arm's evidence and each `EndArm` following
     * an `Event` for every scheduled event with no job open; `Event` records in the configured
     * order, each timestamped no earlier than its schedule, a turn's `Event` preceded by its
     * `EndTurn` or interruption marker; one `BeginTurn` per turn, for the turn next due, and one
     * `EndTurn` after it; an interruption marker closing an open turn or an unobserved fault;
     * `EndJob` only for an open registration; `FaultFired` once per configured fault, at its
     * trigger's place in the event sequence; `FaultObserved` after its `FaultFired`; a missed
     * sleep or a fault-tagged jump only for a laptop sleep at its place; and a daemon exit
     * marked expected only inside a replayed outage window. Runs before any recovery entry is
     * written, so a corrupt journal is refused unchanged.
     */
    private checkJournal(entries: Entry[], scenario: string): void {
        const events = this.o.events;
        const turns = new Set(events.filter((e) => e.kind === "user_turn").map((e) => e.id));
        const fail = (what: string, e: Entry) => new Error(`journal: ${what} (seq ${e.seq})`);
        const identity = (e: Entry) => {
            if (JSON.stringify(e.order) !== JSON.stringify(this.o.order)) {
                throw new Error(
                    `scheduler: run was started with arm order ${JSON.stringify(e.order)}`,
                );
            }
            if (e.scenario !== scenario) {
                throw new Error(`scheduler: run was started with scenario ${e.scenario}`);
            }
        };
        let next = 0;
        let open: string | null = null;
        let begun = new Set<unknown>();
        let ended = new Set<unknown>();
        let outcomes = new Map<unknown, unknown>();
        let jumped = new Set<unknown>();
        let checked = new Set<unknown>();
        let fired = new Set<unknown>();
        let observed = new Set<unknown>();
        let marked = new Set<unknown>();
        let jobs = new Map<unknown, number>();
        let snapshots = new Set<unknown>();
        let users = new Set<unknown>();
        let summarised = false;
        let done = 0;
        let outage: string | null = null;
        let clockMs = 0;
        let session: string | null = null;
        const scheduled = this.o.faults.filter((f) => f.trigger.kind !== "first_summarizer_call");
        const holdsClock = new Set<unknown>(
            this.o.faults
                .filter((f) => f.seam.layer !== PROXY_LAYER && f.type !== "laptop_sleep")
                .map((f) => f.id),
        );
        entries.forEach((e, i) => {
            if (e.kind === "StartRun" || e.kind === "ResumeRun" || e.kind === "EndRun") {
                if (e.arm !== null || e.scenario_ms !== 0) {
                    throw fail(`${e.kind} carries an arm scope`, e);
                }
            }
            if (e.kind === "StartRun") {
                if (i > 0) throw fail("StartRun is not the first entry", e);
                identity(e);
                return;
            }
            if (e.kind === "ResumeRun") {
                identity(e);
                return;
            }
            if (e.kind === "EndRun") {
                if (i !== entries.length - 1) throw fail("entries follow EndRun", e);
                if (open !== null || next < this.o.order.length) {
                    const left = this.o.order.slice(next - (open === null ? 0 : 1));
                    throw fail(`EndRun with unfinished arms ${JSON.stringify(left)}`, e);
                }
                return;
            }
            if (e.kind === "StartArm") {
                if (open !== null) throw fail(`StartArm for ${e.arm} while ${open} is open`, e);
                if (e.arm !== this.o.order[next]) {
                    throw fail(`StartArm for ${e.arm} out of arm order`, e);
                }
                if (e.scenario_ms !== 0) throw fail(`StartArm for ${e.arm} starts past zero`, e);
                open = e.arm;
                next++;
                begun = new Set();
                ended = new Set();
                outcomes = new Map();
                jumped = new Set();
                checked = new Set();
                fired = new Set();
                observed = new Set();
                marked = new Set();
                jobs = new Map();
                snapshots = new Set();
                users = new Set();
                summarised = false;
                done = 0;
                outage = null;
                clockMs = 0;
                session = null;
                return;
            }
            if (open === null || e.arm !== open) {
                throw fail(`${e.kind} for arm ${e.arm} outside its arm`, e);
            }
            // A fired fault's mechanism holds the clock as a turn does, from its `FaultFired`
            // until its `FaultObserved` or interruption marker; proxy faults and laptop sleeps
            // have no mechanism here, so they hold nothing.
            const holding = [...fired].find(
                (id) => !observed.has(id) && !marked.has(id) && holdsClock.has(id),
            );
            const busy =
                holding !== undefined ||
                [...begun].some((t) => !ended.has(t)) ||
                [...jobs].some(([, n]) => n > 0);
            if (e.kind !== "AdvanceClock") {
                if (busy ? e.scenario_ms < clockMs : e.scenario_ms !== clockMs) {
                    throw fail(`${e.kind} is stamped away from the replayed clock`, e);
                }
                clockMs = e.scenario_ms;
            }
            const due = events[done];
            const cursorOf = (fault: unknown) => {
                const f = this.o.faults.find((x) => x.id === fault);
                if (!f) throw fail(`${e.kind} for unknown fault ${fault}`, e);
                return { f, range: this.triggerCursor(f) };
            };
            switch (e.kind) {
                case "EndArm": {
                    if (done < events.length) {
                        throw fail(`arm ${open} has EndArm before its events completed`, e);
                    }
                    const busy = [...jobs].filter(([, n]) => n > 0).map(([job]) => job);
                    if (busy.length > 0) {
                        throw fail(
                            `arm ${open} has EndArm with jobs open ${JSON.stringify(busy)}`,
                            e,
                        );
                    }
                    const pending = [...jumped].find((f) => !fired.has(f));
                    if (pending !== undefined) {
                        throw fail(`arm ${open} has EndArm with sleep ${pending} unfired`, e);
                    }
                    open = null;
                    return;
                }
                case "Event": {
                    if (!due || e.event !== due.id) {
                        throw fail(`Event for ${e.event} is out of scenario order`, e);
                    }
                    if (e.scenario_ms < due.scenario_ms) {
                        throw fail(`Event for ${e.event} precedes its schedule`, e);
                    }
                    if (turns.has(due.id) && !ended.has(due.id)) {
                        throw fail(`Event for ${e.event} has no EndTurn`, e);
                    }
                    if (typeof e.outcome !== "string") {
                        throw fail(`Event for ${e.event} has no outcome`, e);
                    }
                    if (turns.has(due.id) && e.outcome !== outcomes.get(due.id)) {
                        throw fail(`Event for ${e.event} contradicts its EndTurn outcome`, e);
                    }
                    if (holding !== undefined) {
                        throw fail(`Event for ${e.event} while fault ${holding} is unresolved`, e);
                    }
                    done++;
                    if (due.kind === "session_end") session = null;
                    else if (due.kind !== "apply_diff") session = due.session;
                    for (const f of this.o.faults) {
                        if (done > this.triggerCursor(f)[1] && !fired.has(f.id)) {
                            throw fail(`fault ${f.id} passed its trigger unhandled`, e);
                        }
                    }
                    outage = null;
                    return;
                }
                case "BeginTurn": {
                    if (!turns.has(e.event as string)) {
                        throw fail(`BeginTurn for ${e.event} is not a user turn`, e);
                    }
                    if (!due || e.event !== due.id) {
                        throw fail(`BeginTurn for ${e.event} is not due`, e);
                    }
                    if (begun.has(e.event)) throw fail(`BeginTurn for ${e.event} repeats`, e);
                    if (e.scenario_ms < due.scenario_ms) {
                        throw fail(`BeginTurn for ${e.event} precedes its schedule`, e);
                    }
                    const working = [...jobs].find(([, n]) => n > 0);
                    const openSession = due.session === session;
                    // A turn with a fault keyed to it waits for the busy set, as the runtime does.
                    const keyed = scheduled.some(
                        (f) =>
                            f.trigger.kind === "user_turn" &&
                            f.trigger.session === due.session &&
                            f.trigger.n === (due.index ?? -1) + 1,
                    );
                    if (working !== undefined && (this.o.turnsAwaitJobs || !openSession || keyed)) {
                        throw fail(`BeginTurn for ${e.event} while job ${working[0]} is open`, e);
                    }
                    for (const f of scheduled) {
                        const [lo, hi] = this.triggerCursor(f);
                        if (lo !== done || hi !== done || f.type === "laptop_sleep") continue;
                        if (!fired.has(f.id)) {
                            throw fail(`BeginTurn for ${e.event} before fault ${f.id} fired`, e);
                        }
                        const terminal = observed.has(f.id) || marked.has(f.id);
                        if (f.seam.layer !== PROXY_LAYER && !terminal) {
                            throw fail(
                                `BeginTurn for ${e.event} while fault ${f.id} is unresolved`,
                                e,
                            );
                        }
                    }
                    begun.add(e.event);
                    outage = null;
                    return;
                }
                case "EndTurn": {
                    if (!turns.has(e.event as string)) {
                        throw fail(`EndTurn for ${e.event} is not a user turn`, e);
                    }
                    if (!begun.has(e.event))
                        throw fail(`EndTurn for ${e.event} has no BeginTurn`, e);
                    if (ended.has(e.event)) throw fail(`EndTurn for ${e.event} repeats`, e);
                    if (typeof e.outcome !== "string") {
                        throw fail(`EndTurn for ${e.event} has no outcome`, e);
                    }
                    const ms = e.prompt_ms;
                    if (
                        ms !== undefined &&
                        ms !== null &&
                        !(Number.isSafeInteger(ms) && Number(ms) >= 0)
                    ) {
                        throw fail(`EndTurn for ${e.event} has a prompt_ms that is no duration`, e);
                    }
                    const probe = events.find((x) => x.id === e.event)?.probe;
                    if (probe !== undefined) {
                        const state = e.outcome === "ok" ? "completed" : "failed";
                        if (e.probe !== probe || e.state !== state) {
                            throw fail(`EndTurn for ${e.event} misreports its probe`, e);
                        }
                    }
                    ended.add(e.event);
                    outcomes.set(e.event, e.outcome);
                    return;
                }
                case "RegisterJob": {
                    if (typeof e.job !== "string" || e.job === "") {
                        throw fail("RegisterJob names no job", e);
                    }
                    if ((jobs.get(e.job) ?? 0) > 0) {
                        throw fail(`RegisterJob for ${e.job} while it is open`, e);
                    }
                    jobs.set(e.job, 1);
                    return;
                }
                case "EndJob": {
                    if (typeof e.job !== "string" || e.job === "") {
                        throw fail("EndJob names no job", e);
                    }
                    const n = jobs.get(e.job) ?? 0;
                    if (n <= 0) throw fail(`EndJob for ${e.job} has no RegisterJob`, e);
                    jobs.set(e.job, n - 1);
                    return;
                }
                case "FaultFired": {
                    const { f, range } = cursorOf(e.fault);
                    if (fired.has(f.id)) throw fail(`FaultFired for ${f.id} repeats`, e);
                    if (done < range[0] || done > range[1]) {
                        throw fail(`FaultFired for ${f.id} is away from its trigger`, e);
                    }
                    if (f.type === "laptop_sleep" && !jumped.has(f.id)) {
                        throw fail(`FaultFired for sleep ${f.id} has no jump`, e);
                    }
                    if (e.type !== f.type || e.layer !== f.seam.layer) {
                        throw fail(`FaultFired for ${f.id} misreports its episode`, e);
                    }
                    fired.add(f.id);
                    if (OUTAGE.has(f.type)) outage = f.id;
                    return;
                }
                case "FaultObserved": {
                    if (!fired.has(e.fault)) {
                        throw fail(`FaultObserved for ${e.fault} has no FaultFired`, e);
                    }
                    if (observed.has(e.fault)) {
                        throw fail(`FaultObserved for ${e.fault} repeats`, e);
                    }
                    if (marked.has(e.fault)) {
                        throw fail(`FaultObserved for ${e.fault} after its interruption`, e);
                    }
                    const { f } = cursorOf(e.fault);
                    if (e.type !== f.type) {
                        throw fail(`FaultObserved for ${f.id} misreports its type`, e);
                    }
                    if (
                        typeof e.evidence !== "object" ||
                        e.evidence === null ||
                        Array.isArray(e.evidence)
                    ) {
                        throw fail(`FaultObserved for ${f.id} carries no evidence`, e);
                    }
                    observed.add(e.fault);
                    if (outage === e.fault) outage = null;
                    return;
                }
                case "AdvanceClock": {
                    if (e.fault !== undefined) {
                        const { f, range } = cursorOf(e.fault);
                        if (f.type !== "laptop_sleep" || done !== range[0] || fired.has(f.id)) {
                            throw fail(`AdvanceClock for ${f.id} is away from its sleep`, e);
                        }
                        if (jumped.has(f.id)) throw fail(`AdvanceClock for ${f.id} repeats`, e);
                    }
                    if (busy) throw fail("AdvanceClock while the clock is busy", e);
                    if (!due || e.scenario_ms !== due.scenario_ms) {
                        throw fail("AdvanceClock lands away from the event due", e);
                    }
                    if (typeof e.from_ms !== "number" || e.from_ms >= e.scenario_ms) {
                        throw fail("AdvanceClock jumps nowhere", e);
                    }
                    if (e.from_ms !== clockMs)
                        throw fail("AdvanceClock starts away from the clock", e);
                    clockMs = e.scenario_ms;
                    if ((e.fault === undefined) === (e.next_event === undefined)) {
                        throw fail("AdvanceClock names neither one sleep nor one event", e);
                    }
                    if (e.fault !== undefined) jumped.add(e.fault);
                    else if (e.next_event !== due.id) {
                        throw fail("AdvanceClock names an event other than the one due", e);
                    }
                    outage = null;
                    return;
                }
                case "SnapshotArtefacts": {
                    if (typeof e.item !== "string" || typeof e.snapshot !== "string") {
                        throw fail("SnapshotArtefacts names no item or snapshot", e);
                    }
                    if (snapshots.has(e.item)) {
                        throw fail(`SnapshotArtefacts for ${e.item} repeats`, e);
                    }
                    const turn = events.find((x) => x.probe === e.item && ended.has(x.id));
                    if (!turn) throw fail(`SnapshotArtefacts for ${e.item} has no EndTurn`, e);
                    snapshots.add(e.item);
                    return;
                }
                case "StoreChecked": {
                    if (typeof e.fault !== "string") {
                        throw fail(`StoreChecked for ${e.event} names no fault`, e);
                    }
                    const { f } = cursorOf(e.fault);
                    if (!OUTAGE.has(f.type) || !fired.has(f.id)) {
                        throw fail(`StoreChecked for ${f.id} follows no daemon restart`, e);
                    }
                    if (checked.has(f.id)) throw fail(`StoreChecked for ${f.id} repeats`, e);
                    // A check lands inside the turn that earned it, after that turn's EndTurn, at
                    // the non-turn event being delivered, or unattached at a fault or the finish.
                    const placed =
                        e.event === null ||
                        begun.has(e.event) ||
                        (due !== undefined && e.event === due.id && due.kind !== "user_turn");
                    if (!placed) throw fail(`StoreChecked for ${f.id} is away from ${e.event}`, e);
                    checked.add(f.id);
                    return;
                }
                case "ClockOffset": {
                    if (!Number.isInteger(e.offset_s)) {
                        throw fail("ClockOffset carries no whole-second offset", e);
                    }
                    return;
                }
                case "UserTurn": {
                    // The user record lands inside its turn: before EndTurn, or, recovered from
                    // the pairing log, before the turn's interruption.
                    if (!begun.has(e.event) || ended.has(e.event)) {
                        throw fail(`${e.kind} for ${e.event} lies outside its open turn`, e);
                    }
                    if (users.has(e.event)) throw fail(`${e.kind} for ${e.event} repeats`, e);
                    users.add(e.event);
                    return;
                }
                case "DeleteMemoryObject": {
                    // The runner journals each note a deletion targets before the deletion runs.
                    if (!due || e.event !== due.id || begun.has(e.event)) {
                        throw fail(`DeleteMemoryObject before ${e.event} is not due`, e);
                    }
                    if (typeof e.target_item_id !== "string" || !Number.isInteger(e.object_id)) {
                        throw fail(`DeleteMemoryObject before ${e.event} names no note`, e);
                    }
                    return;
                }
                case "CounterfactualDeletion": {
                    if (!due || e.event !== due.id || begun.has(e.event)) {
                        throw fail(`CounterfactualDeletion before ${e.event} is not due`, e);
                    }
                    if (typeof e.probe !== "string") {
                        throw fail(`CounterfactualDeletion before ${e.event} names no probe`, e);
                    }
                    return;
                }
                case "UserSimRates": {
                    if (done < events.length) {
                        throw fail(`arm ${open} has UserSimRates before its events completed`, e);
                    }
                    if (summarised) throw fail(`arm ${open} has UserSimRates twice`, e);
                    summarised = true;
                    return;
                }
                case "ItemState": {
                    if (e.daemon_exit !== undefined) {
                        const detail = e.daemon_exit;
                        if (
                            typeof detail !== "object" ||
                            detail === null ||
                            Array.isArray(detail)
                        ) {
                            throw fail("daemon exit carries no detail", e);
                        }
                        if (e.expected !== true || e.fatal !== false || outage === null) {
                            throw fail("daemon exit outside a replayed outage window", e);
                        }
                        outage = null;
                        return;
                    }
                    if (e.state === "missed") {
                        const { f, range } = cursorOf(e.fault);
                        const summarizer = f.trigger.kind === "first_summarizer_call";
                        const place = summarizer ? range[1] : range[0];
                        const stray = (f.type !== "laptop_sleep" && !summarizer) || done !== place;
                        if (stray || fired.has(f.id) || jumped.has(f.id)) {
                            throw fail(`missed ${f.id} away from its place`, e);
                        }
                        fired.add(f.id);
                        marked.add(f.id);
                        return;
                    }
                    if (e.state === "failed(interrupted)" && e.event !== undefined) {
                        if (!begun.has(e.event) || ended.has(e.event)) {
                            throw fail(`interruption of ${e.event} closes no open turn`, e);
                        }
                        ended.add(e.event);
                        outcomes.set(e.event, "failed(interrupted)");
                        return;
                    }
                    if (e.state === "failed(interrupted)" && e.fault !== undefined) {
                        if (!fired.has(e.fault) || observed.has(e.fault) || marked.has(e.fault)) {
                            throw fail(`interruption of ${e.fault} closes no open fault`, e);
                        }
                        marked.add(e.fault);
                        if (outage === e.fault) outage = null;
                        return;
                    }
                    throw fail("ItemState of unknown shape", e);
                }
                default:
                    throw fail(`${e.kind} is not a journal kind`, e);
            }
        });
    }

    /**
     * The range of completed-event counts at which `f` can fire: a session-start or user-turn
     * trigger fires while its event is the next one due (a laptop sleep on the session's first
     * event), and a summarizer-call trigger fires any time its session is open.
     */
    private triggerCursor(f: FaultEpisode): [number, number] {
        const events = this.o.events;
        const t = f.trigger;
        const at = (pred: (e: ScenarioEvent) => boolean) => {
            const i = events.findIndex(pred);
            return i < 0 ? events.length : i;
        };
        if (t.kind === "first_summarizer_call") {
            const start = at((e) => e.kind === "session_start" && e.session === t.session);
            const end = at((e) => e.kind === "session_end" && e.session === t.session);
            return [start, end];
        }
        if (f.type === "laptop_sleep") {
            const first = at((e) => e.session === t.session);
            return [first, first];
        }
        const i =
            t.kind === "session_start"
                ? at((e) => e.kind === "session_start" && e.session === t.session)
                : at(
                      (e) =>
                          e.kind === "user_turn" && e.session === t.session && e.index === t.n - 1,
                  );
        return [i, i];
    }

    /**
     * Resolves with the driver call's result, or rejects as soon as a fatal daemon exit is
     * recorded, so a call the dead daemon never answers cannot hold the run.
     */
    private untilFatal<T>(call: Promise<T>): Promise<T> {
        call.catch(() => undefined);
        if (this.fatal) return Promise.reject(this.fatal);
        this.failed ??= new Promise<never>((_, reject) => {
            this.fail = reject;
        });
        this.failed.catch(() => undefined);
        return Promise.race([call, this.failed]);
    }

    /**
     * Waits until every pending kill has returned its evidence and the busy set is empty at the
     * same time: a kill fired by a job during the idle wait, or a job registered during a kill,
     * starts the wait over.
     */
    private async quiesce(): Promise<void> {
        let kill: Promise<unknown> | null;
        do {
            kill = this.pendingKill;
            await kill;
            await this.idle();
        } while (kill !== this.pendingKill || (this.clock?.busyIds().length ?? 0) > 0);
        if (this.fatal) throw this.fatal;
    }

    /**
     * The session the journal left open: the one of the last delivered or begun event, unless
     * its `session_end` already has an `Event`.
     */
    private openSession(mine: Entry[]): string | null {
        const opened = new Set(
            this.o.events.filter((e) => e.kind !== "apply_diff").map((e) => e.id),
        );
        const last = [...mine]
            .reverse()
            .find(
                (e) =>
                    (e.kind === "Event" || e.kind === "BeginTurn") && opened.has(e.event as string),
            );
        const event = this.o.events.find((e) => e.id === last?.event);
        if (!event) return null;
        const end = this.o.events.find(
            (e) => e.kind === "session_end" && e.session === event.session,
        );
        const done = new Set(mine.filter((e) => e.kind === "Event").map((e) => e.event));
        return end && done.has(end.id) ? null : event.session;
    }

    /**
     * Returns the answered turns whose `Event` is still to be written; the caller settles first
     * so a job such a turn started can register, then journals them.
     */
    private resume(mine: Entry[]): Entry[] {
        const kinds = (k: string) => mine.filter((e) => e.kind === k);
        const done = new Set(kinds("Event").map((e) => e.event));
        const ended = new Set(kinds("EndTurn").map((e) => e.event));
        const begun = new Set(kinds("BeginTurn").map((e) => e.event));
        const interrupted = kinds("ItemState").filter((e) => e.state === "failed(interrupted)");
        const marked = new Set(interrupted.map((e) => e.event ?? e.fault));
        const seen = new Set<unknown>();
        const answered = kinds("EndTurn").filter((x) => {
            if (done.has(x.event) || seen.has(x.event)) return false;
            seen.add(x.event);
            return true;
        });
        const open = new Map<unknown, number>();
        for (const e of mine) {
            if (e.kind === "RegisterJob") open.set(e.job, (open.get(e.job) ?? 0) + 1);
            if (e.kind === "EndJob") open.set(e.job, (open.get(e.job) ?? 0) - 1);
        }
        for (const [job, n] of open) {
            for (let i = 0; i < n; i++) {
                this.log({ kind: "EndJob", job, outcome: "failed(interrupted)" });
            }
        }
        const firedIds = new Set(kinds("FaultFired").map((e) => e.fault));
        for (const jump of kinds("AdvanceClock")) {
            if (typeof jump.fault === "string" && !firedIds.has(jump.fault)) {
                const f = this.o.faults.find((x) => x.id === jump.fault);
                if (f) {
                    this.log({
                        kind: "FaultFired",
                        fault: f.id,
                        type: f.type,
                        layer: f.seam.layer,
                    });
                    this.fired.add(`${this.arm}/${f.id}`);
                }
            }
        }
        const observed = new Set(kinds("FaultObserved").map((e) => e.fault));
        // A sleep's evidence is its jump, so a sleep the kill left unobserved is observed from it.
        for (const jump of kinds("AdvanceClock")) {
            const f = this.o.faults.find((x) => x.id === jump.fault);
            if (f?.type !== "laptop_sleep" || observed.has(f.id)) continue;
            const evidence = { clock_advanced_ms: jump.scenario_ms - Number(jump.from_ms) };
            this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
            observed.add(f.id);
        }
        this.interrupted = [];
        for (const fired of kinds("FaultFired")) {
            const f = this.o.faults.find((x) => x.id === fired.fault);
            if (!f) continue;
            if (f.seam.layer !== PROXY_LAYER) {
                if (!observed.has(f.id) && f.type !== "laptop_sleep") {
                    this.interrupted.push(f.id);
                    if (!marked.has(f.id)) {
                        this.log({ kind: "ItemState", fault: f.id, state: "failed(interrupted)" });
                    }
                }
                continue;
            }
            const end = this.o.events.find(
                (e) => e.kind === "session_end" && e.session === f.trigger.session,
            );
            if (end && done.has(end.id)) continue;
            const t = f.trigger;
            const index = t.kind === "user_turn" ? t.n - 1 : 0;
            const target = this.o.events.find(
                (e) => e.kind === "user_turn" && e.session === t.session && e.index === index,
            );
            if (f.strategy === "persistent" || (target && !begun.has(target.id))) {
                this.o.proxy?.arm(f.id, this.arm as string);
            } else if (!marked.has(f.id)) {
                this.log({ kind: "ItemState", fault: f.id, state: "failed(interrupted)" });
            }
        }
        const journaled = new Set(kinds("UserTurn").map((e) => e.event));
        for (const e of kinds("BeginTurn").filter(
            (x) => !ended.has(x.event) && !done.has(x.event),
        )) {
            const user = journaled.has(e.event)
                ? undefined
                : this.o.recoverTurn?.(e.event as string);
            if (user) this.log({ kind: "UserTurn", event: e.event, ...user, recovered: true });
            if (!marked.has(e.event)) {
                this.log({ kind: "ItemState", event: e.event, state: "failed(interrupted)" });
            }
            this.log({ kind: "Event", event: e.event, outcome: "failed(interrupted)" });
        }
        return answered;
    }

    /** The `session_start` event of `session`, the one a resumed arm reopens, or null. */
    private openStart(session: string | null): ScenarioEvent | null {
        if (session === null) return null;
        return (
            this.o.events.find((e) => e.kind === "session_start" && e.session === session) ?? null
        );
    }

    private snapshotted(item: string): boolean {
        return this.o.journal.entries.some(
            (x) => x.kind === "SnapshotArtefacts" && x.arm === this.arm && x.item === item,
        );
    }

    /**
     * Journals the first `SnapshotArtefacts` of a probe item from the snapshot its `EndTurn`
     * names. A resume replays it from the `EndTurn` entry, so a kill between the two leaves
     * the snapshot id in the journal once the run continues.
     */
    private snapshotTurn(end: Record<string, unknown>): void {
        const item = typeof end.probe === "string" ? end.probe : null;
        const snapshot = typeof end.snapshot === "string" ? end.snapshot : null;
        if (item && snapshot && !this.snapshotted(item)) {
            this.record({ kind: "SnapshotArtefacts", item, snapshot }, `snapshot of ${item}`);
        }
    }

    /**
     * Each live job may hold the clock for `idleLimitMs` of wall time from its own `RegisterJob`,
     * on the monotonic clock; other busy ids count from the start of the wait.
     */
    private async idle(): Promise<void> {
        const limitMs = this.o.idleLimitMs ?? Number.POSITIVE_INFINITY;
        const entered = performance.now();
        const busy = () => this.clock?.busyIds() ?? [];
        while (busy().length > 0) {
            if (this.fatal) throw this.fatal;
            this.checkStop();
            const live = busy().map((id) =>
                id.startsWith("job:") ? (this.jobStarted.get(id.slice(4)) ?? entered) : entered,
            );
            if (performance.now() > Math.min(...live) + limitMs) {
                throw new HarnessFailure(
                    `busy set held the clock past ${this.o.idleLimitMs} ms: ${busy().join(", ")}`,
                );
            }
            await Bun.sleep(this.o.jobPollMs ?? 50);
        }
    }

    /**
     * Waits the settle window, in which a background call the host dispatched after its answer
     * registers its job, then waits for the background jobs in the busy set, with the turn
     * itself still open.
     */
    async quiesceJobs(): Promise<void> {
        const settle = this.o.settleMs ?? 1_000;
        const jobs = () => (this.clock?.busyIds() ?? []).filter((id) => id.startsWith("job:"));
        const limit = Date.now() + (this.o.idleLimitMs ?? Number.POSITIVE_INFINITY);
        await this.untilFatal(Bun.sleep(settle));
        await this.waitFor(jobs, limit);
        let quietSince = Date.now();
        let activity = this.jobActivity;
        while (Date.now() - quietSince < settle) {
            await this.untilFatal(Bun.sleep(this.o.jobPollMs ?? 50));
            if (Date.now() > limit) {
                throw new HarnessFailure(
                    `background jobs kept the quiet window open past ${this.o.idleLimitMs} ms`,
                );
            }
            if (this.jobActivity !== activity || jobs().length > 0) {
                await this.waitFor(jobs, limit);
                activity = this.jobActivity;
                quietSince = Date.now();
            }
        }
    }

    /** Waits, bounded by the liveness deadline, for the busy ids outside `prior` to end. */
    private async drainNew(prior: ReadonlySet<string>): Promise<void> {
        const limit = Date.now() + (this.o.idleLimitMs ?? Number.POSITIVE_INFINITY);
        const fresh = () => (this.clock?.busyIds() ?? []).filter((id) => !prior.has(id));
        while (fresh().length > 0 && Date.now() <= limit) {
            await Bun.sleep(this.o.jobPollMs ?? 50);
        }
    }

    private async waitFor(pending: () => string[], limit: number): Promise<void> {
        while (pending().length > 0) {
            if (this.fatal) throw this.fatal;
            this.checkStop();
            if (Date.now() > limit) {
                throw new HarnessFailure(
                    `busy set held the clock past ${this.o.idleLimitMs} ms: ${pending().join(", ")}`,
                );
            }
            await Bun.sleep(this.o.jobPollMs ?? 50);
        }
    }

    private faultsAt(e: ScenarioEvent): FaultEpisode[] {
        return this.o.faults.filter((f) => {
            const t = f.trigger;
            if (t.session !== e.session || this.fired.has(`${this.arm}/${f.id}`)) return false;
            if (e.kind === "session_start") return t.kind === "session_start";
            return e.kind === "user_turn" && t.kind === "user_turn" && t.n === (e.index ?? -1) + 1;
        });
    }

    private async fire(driver: ArmDriver, f: FaultEpisode, at?: ScenarioEvent): Promise<void> {
        if (f.seam.layer === PROXY_LAYER) this.o.proxy?.arm(f.id, this.arm as string);
        try {
            this.log({ kind: "FaultFired", fault: f.id, type: f.type, layer: f.seam.layer });
        } catch (caught) {
            if (f.seam.layer === PROXY_LAYER) this.o.proxy?.disarm(f.id, this.arm as string);
            throw caught;
        }
        this.fired.add(`${this.arm}/${f.id}`);
        if (f.seam.layer === PROXY_LAYER) return;
        if (f.type === "laptop_sleep") return;
        if (OUTAGE.has(f.type)) this.outage = f.id;
        let evidence: Record<string, unknown>;
        let owed: TurnOutcome["stores"];
        try {
            const where = at ? structuredClone(at) : undefined;
            // The fault's mechanism holds the clock as a turn does, so a second client's prompt
            // advances scenario time and no jump lands while it runs.
            const owner = `fault:${f.id}`;
            this.clock?.begin(owner);
            let got: unknown;
            try {
                const call = driver.fault(structuredClone(f), where);
                this.faultCall = call;
                got = await this.untilFatal(call);
            } finally {
                this.clock?.end(owner);
            }
            const { stores, ...rest } = plainObject(got, "fault evidence");
            // Store checks an earlier restart owed, settled before this fault took the daemon down.
            owed = stores as TurnOutcome["stores"];
            evidence = rest;
        } catch (caught) {
            if (caught === this.fatal) {
                try {
                    this.record(
                        { kind: "ItemState", fault: f.id, state: "failed(interrupted)" },
                        `fault ${f.id} was cut`,
                    );
                } catch {
                    throw caught;
                }
                throw caught;
            }
            const error = caught instanceof Error ? caught.message : String(caught);
            this.fatal ??= new HarnessFailure(`fault ${f.id} failed: ${error}`);
            this.recordFatal(
                { kind: "ItemState", fault: f.id, state: "failed", error, fatal: true },
                `fault ${f.id} failed`,
            );
            throw caught;
        }
        this.logStores(owed, null);
        try {
            this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
        } catch (caught) {
            this.poison(`fault ${f.id} evidence could not be journaled`, caught);
            throw caught;
        }
        if (this.outage === f.id) this.outage = null;
    }

    /**
     * The idle clock advance onto a session's first event is the jump across the gap before
     * that session, so a laptop sleep scheduled for the session fires there, whatever kind of
     * event opens it.
     */
    private sleepBefore(e: ScenarioEvent): FaultEpisode | undefined {
        return this.o.faults.find(
            (f) =>
                f.type === "laptop_sleep" &&
                f.trigger.session === e.session &&
                !this.fired.has(`${this.arm}/${f.id}`),
        );
    }

    private checkStop(): void {
        const reason = this.o.stopped?.();
        if (reason) throw new HarnessFailure(`run stopping: ${reason}`);
    }

    /**
     * A user turn in the session already open, with no fault due at it, waits only for the
     * clock, which runs at wall speed while background work holds it, to reach the turn's
     * scheduled time, and for every pending mid-fold kill; background work keeps running into
     * the turn. Each job's deadline still counts from its `RegisterJob`, as in `idle()`. Every
     * other event, a turn whose fault is due included, waits for the busy set to empty, so a
     * fault's mechanism never cuts the preceding turn's background work.
     */
    private async awaitDue(e: ScenarioEvent): Promise<void> {
        const concurrent =
            !this.o.turnsAwaitJobs &&
            e.kind === "user_turn" &&
            this.session === e.session &&
            this.faultsAt(e).length === 0;
        if (!concurrent) return this.quiesce();
        const limitMs = this.o.idleLimitMs ?? Number.POSITIVE_INFINITY;
        const entered = performance.now();
        for (;;) {
            await this.settleKills();
            this.checkStop();
            const clock = this.clock as Clock;
            const busy = clock.busyIds();
            const live = busy.map((id) =>
                id.startsWith("job:") ? (this.jobStarted.get(id.slice(4)) ?? entered) : entered,
            );
            if (busy.length > 0 && performance.now() > Math.min(...live) + limitMs) {
                throw new HarnessFailure(
                    `busy set held the clock past ${this.o.idleLimitMs} ms: ${busy.join(", ")}`,
                );
            }
            if (busy.length === 0 || clock.now() >= e.scenario_ms) return;
            await Bun.sleep(this.o.jobPollMs ?? 50);
        }
    }

    /**
     * Waits until no mid-fold kill is pending, a kill that starts while an earlier one runs
     * included, so whatever follows opens with every outage window closed by its own mechanism.
     */
    private async settleKills(): Promise<void> {
        let kill: Promise<unknown> | null;
        do {
            kill = this.pendingKill;
            await kill;
        } while (kill !== this.pendingKill);
        if (this.fatal) throw this.fatal;
    }

    private async step(driver: ArmDriver, e: ScenarioEvent): Promise<void> {
        await this.awaitDue(e);
        // A job that registered after the wait leaves the clock busy short of the schedule, so
        // the wait runs again before the clock may jump.
        for (;;) {
            const clock = this.clock as Clock;
            if (clock.busyIds().length === 0 || clock.now() >= e.scenario_ms) break;
            await this.awaitDue(e);
        }
        this.checkStop();
        this.outage = null;
        const clock = this.clock as Clock;
        const sleep = this.sleepBefore(e);
        const arm = this.arm ?? "";
        const fromMs = clock.now();
        const jumped = fromMs < e.scenario_ms;
        if (jumped) {
            clock.advanceTo(e.scenario_ms, arm, sleep ? { fault: sleep.id } : { next_event: e.id });
        }
        if (e.kind !== "apply_diff") this.session = e.session;
        if (sleep && !jumped) {
            this.log({ kind: "ItemState", fault: sleep.id, state: "missed" });
            this.fired.add(`${this.arm}/${sleep.id}`);
        } else if (sleep) {
            await this.fire(driver, sleep);
            const evidence = { clock_advanced_ms: e.scenario_ms - fromMs };
            this.record(
                { kind: "FaultObserved", fault: sleep.id, type: sleep.type, evidence },
                `sleep ${sleep.id}`,
            );
        }
        const due = this.faultsAt(e);
        for (const f of due) await this.fire(driver, f, e);
        if (due.length > 0) await this.quiesce();
        if (driver.prepare) {
            const deleted = (probe: string) =>
                this.o.journal.entries.some(
                    (x) =>
                        x.kind === "CounterfactualDeletion" &&
                        x.arm === this.arm &&
                        x.event === e.id &&
                        x.probe === probe,
                );
            const logDeletion = (d: Record<string, unknown>) =>
                this.record(
                    { kind: "CounterfactualDeletion", event: e.id, ...d },
                    `deletion before ${e.id}`,
                );
            await this.untilFatal(driver.prepare(structuredClone(e), logDeletion, deleted));
        }
        const deliver = async (): Promise<TurnOutcome> => {
            let got: unknown;
            try {
                got = await this.untilFatal(driver.event(structuredClone(e)));
                const failed = (got as { failed?: unknown } | null)?.failed;
                const wellFormed =
                    typeof got === "object" &&
                    got !== null &&
                    !Array.isArray(got) &&
                    (failed === undefined || (typeof failed === "string" && failed !== "ok"));
                if (!wellFormed) throw new Error(`driver outcome is ${describe(got)}`);
            } catch (caught) {
                if (caught === this.fatal) throw caught;
                const error = caught instanceof Error ? caught.message : String(caught);
                this.fatal ??= new HarnessFailure(`event ${e.id} failed: ${error}`);
                this.recordFatal(
                    { kind: "ItemState", event: e.id, state: "failed", error, fatal: true },
                    `event ${e.id} failed`,
                );
                throw caught;
            }
            const outcome = plainObject(got, "driver outcome") as TurnOutcome;
            if (outcome.failed === undefined) delete outcome.failed;
            return outcome;
        };
        let outcome: TurnOutcome;
        if (e.kind === "user_turn") {
            // Background work running into the turn can start a mid-fold kill while the
            // preparation runs; the turn opens only after it, with no yield in between.
            await this.settleKills();
            const turn = `turn:${e.id}`;
            this.log({ kind: "BeginTurn", event: e.id, probe: e.probe ?? null });
            clock.begin(turn);
            try {
                outcome = await deliver();
            } finally {
                clock.end(turn);
            }
            const state = outcome.failed === undefined ? "completed" : "failed";
            const item = e.probe ? { probe: e.probe, state } : {};
            // The checks and the user record go first: a kill before EndTurn replays the turn
            // with them on record, and a resume reads a turn's EndTurn as the whole turn.
            this.logStores(outcome.stores, e.id);
            if (outcome.user) {
                this.record(
                    { kind: "UserTurn", event: e.id, ...outcome.user },
                    `user turn ${e.id}`,
                );
            }
            const snapshot = outcome.snapshot ? { snapshot: outcome.snapshot } : {};
            const end = {
                event: e.id,
                outcome: outcome.failed ?? "ok",
                prompt_ms: outcome.prompt_ms ?? null,
                ...item,
                ...snapshot,
            };
            try {
                this.log({ kind: "EndTurn", ...end });
            } catch (caught) {
                this.poison(`turn ${e.id} ended but its record could not be journaled`, caught);
                throw caught;
            }
            this.snapshotTurn(end);
            await this.untilFatal(Bun.sleep(this.o.settleMs ?? 1_000));
        } else {
            outcome = await deliver();
            this.logStores(outcome.stores, e.id);
        }
        if (e.kind === "session_end") {
            for (const f of this.o.faults) {
                if (f.trigger.session === e.session && f.seam.layer === PROXY_LAYER)
                    this.o.proxy?.disarm(f.id, this.arm as string);
            }
            await this.pendingKill;
            for (const f of this.o.faults) {
                const unfired = !this.fired.has(`${this.arm}/${f.id}`);
                if (f.trigger.kind !== "first_summarizer_call" || f.trigger.session !== e.session)
                    continue;
                if (unfired) {
                    this.record(
                        { kind: "ItemState", fault: f.id, state: "missed" },
                        `missed ${f.id}`,
                    );
                    this.fired.add(`${this.arm}/${f.id}`);
                }
            }
            this.session = null;
        }
        await this.pendingKill;
        if (this.fatal) throw this.fatal;
        this.record(
            { kind: "Event", event: e.id, outcome: outcome.failed ?? "ok" },
            `event ${e.id}`,
        );
    }

    private handle(generation: number, driver: ArmDriver): ArmHandle {
        const live = (): Clock => {
            if (generation !== this.generation || !this.clock) {
                throw new Error("scheduler: this arm has ended");
            }
            return this.clock;
        };
        return {
            jobStart: (id) => {
                const clock = live();
                if (typeof id !== "string" || id === "") {
                    throw new Error(`job id is ${describe(id)}, which is not a name`);
                }
                if (clock.busyIds().includes(`job:${id}`)) {
                    throw new Error(`clock: job:${id} is already busy`);
                }
                try {
                    this.log({ kind: "RegisterJob", job: id });
                } catch (caught) {
                    this.poison(`job ${id} could not be registered`, caught);
                    throw caught;
                }
                clock.begin(`job:${id}`);
                this.jobStarted.set(id, performance.now());
                this.jobActivity++;
            },
            jobEnd: (id) => {
                const clock = live();
                if (typeof id !== "string" || id === "") {
                    throw new Error(`job id is ${describe(id)}, which is not a name`);
                }
                if (!clock.busyIds().includes(`job:${id}`)) {
                    throw new Error(`clock: job:${id} is not busy`);
                }
                let ended: Entry;
                try {
                    ended = this.log({ kind: "EndJob", job: id });
                } catch (caught) {
                    this.poison(`job ${id} could not be ended`, caught);
                    this.jobStarted.delete(id);
                    clock.end(`job:${id}`);
                    throw caught;
                }
                const started = this.jobStarted.get(id);
                this.jobStarted.delete(id);
                clock.end(`job:${id}`, ended.scenario_ms);
                this.jobActivity++;
                // A job can end while a later turn runs beside it, where no wait watches its
                // deadline; one that ends past it stops the run as a wait would have.
                const limitMs = this.o.idleLimitMs ?? Number.POSITIVE_INFINITY;
                if (started !== undefined && performance.now() > started + limitMs) {
                    this.fatal ??= new HarnessFailure(
                        `busy set held the clock past ${this.o.idleLimitMs} ms: job:${id}`,
                    );
                    this.fail?.(this.fatal);
                }
            },
            observe: (component) => {
                live();
                if (component !== "history_summarizer") return;
                const f = this.o.faults.find(
                    (x) =>
                        x.trigger.kind === "first_summarizer_call" &&
                        x.trigger.session === this.session &&
                        !this.fired.has(`${this.arm}/${x.id}`),
                );
                if (!f) return;
                const kill = this.fire(driver, f);
                kill.catch(() => undefined);
                this.pendingKill = kill;
            },
            daemonExited: (raw) => {
                live();
                const detail = plainObject(raw, "daemon exit detail");
                const expected = this.outage !== null;
                this.outage = null;
                if (!expected) {
                    this.fatal ??= new HarnessFailure(
                        "daemon exited outside a scheduled outage window",
                    );
                }
                try {
                    this.record(
                        { kind: "ItemState", daemon_exit: detail, expected, fatal: !expected },
                        "daemon exit",
                    );
                } finally {
                    if (!expected && this.fatal) this.fail?.(this.fatal);
                }
                if (this.fatal && !expected) throw this.fatal;
            },
        };
    }

    /** The arm whose events the scheduler is delivering, or null between arms. */
    runningArm(): string | null {
        return this.current ? this.arm : null;
    }

    /** The arm the scheduler is starting, resuming, or running, or null between arms. */
    get currentArm(): string | null {
        return this.arm;
    }

    private live(): ArmHandle {
        if (!this.current) throw new Error("scheduler: no arm is running");
        return this.current;
    }

    /** Registers a background job that holds the running arm's clock until `jobEnd`. */
    jobStart(id: string): void {
        this.live().jobStart(id);
    }

    jobEnd(id: string): void {
        this.live().jobEnd(id);
    }

    /** A classified model call of the running arm; a history summarizer call can fire the mid-fold kill. */
    observe(component: string): void {
        this.live().observe(component);
    }

    daemonExited(detail: Record<string, unknown>): void {
        this.live().daemonExited(detail);
    }
}
