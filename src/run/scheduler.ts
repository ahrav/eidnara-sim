import type { StoreCheck } from "../hosts/storecheck";
import type { FaultEpisode } from "../scenario/faults";
import { Clock } from "./clock";
import type { Entry, EntryKind, Journal } from "./journal";

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
    snapshot?: string;
    /** Store checks the arm owed daemon restarts, one `StoreChecked` entry each. */
    stores?: { fault: string; store: StoreCheck }[];
    /** The user turn the user-sim sent or skipped, journaled as `UserTurn`. */
    user?: Record<string, unknown>;
    /** The host never received the turn's text. */
    undelivered?: boolean;
}

export interface ArmDriver {
    reset(): Promise<void>;
    /**
     * Restores a started arm in a new harness process. `open` is the `session_start` of the
     * session the next event belongs to, or null between sessions.
     */
    resume?(open: ScenarioEvent | null): Promise<void>;
    event(e: ScenarioEvent): Promise<TurnOutcome>;
    fault(f: FaultEpisode): Promise<Record<string, unknown>>;
    /**
     * Stops everything the arm runs, after its last event and before `EndArm`; store checks it
     * still owed are journaled.
     */
    finish?(): Promise<TurnOutcome | undefined>;
}

export interface ProxyControl {
    arm(id: string): void;
    disarm(id: string): void;
}

export class HarnessFailure extends Error {}

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
    settleMs?: number;
    /**
     * Runs at each arm's start and at every clock jump. A returned number is the whole-second
     * clock offset the arm's processes now read, journaled as `offset_s`: on a `ClockOffset`
     * entry at the arm's start, and on the jump's own `AdvanceClock` entry otherwise.
     */
    onClock?: (arm: string, scenarioMs: number) => number | undefined;
    /** The arm's realised user-sim rates, journaled as `UserSimRates` before `EndArm`. */
    armSummary?: (arm: string) => object | undefined;
    /**
     * The user record of a turn a kill interrupted, from the driver's own log, journaled as
     * `UserTurn` with `recovered: true` ahead of the turn's `failed(interrupted)` event.
     */
    recoverTurn?: (event: string) => Record<string, unknown> | undefined;
}

const PROXY_LAYER = "proxy-sink";
const OUTAGE = new Set(["daemon_sigkill_mid_fold", "daemon_restart", "host_upgrade"]);

export class Scheduler {
    clock: Clock | null = null;
    private arm: string | null = null;

    /** The arm whose events are running, or null between arms. */
    get currentArm(): string | null {
        return this.arm;
    }
    private session: string | null = null;
    private outage: string | null = null;
    private readonly fired = new Set<string>();
    private pendingKill: Promise<unknown> | null = null;

    constructor(private readonly o: SchedulerOptions) {
        const seen = new Set<string>();
        for (const f of o.faults) {
            if (typeof f.id !== "string" || f.id === "") {
                throw new Error(`fault id must be a non-empty string, got ${JSON.stringify(f.id)}`);
            }
            if (seen.has(f.id)) throw new Error(`fault id ${f.id} is scheduled twice`);
            seen.add(f.id);
            const duration = f.params.duration_ms;
            const positive =
                typeof duration === "number" && Number.isFinite(duration) && duration > 0;
            if (f.type === "laptop_sleep" && !positive) {
                throw new Error(`laptop_sleep ${f.id} needs a positive duration_ms`);
            }
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
            if (!already) this.log({ kind: "StoreChecked", event, ...s });
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
        const entries = this.o.journal.entries;
        if (!entries.some((e) => e.kind === "StartRun")) {
            this.log({ kind: "StartRun", order: this.o.order });
        }
        for (const arm of this.o.order) {
            const mine = entries.filter((e) => e.arm === arm);
            if (mine.some((e) => e.kind === "EndArm")) continue;
            this.arm = arm;
            const start = mine.at(-1)?.scenario_ms ?? 0;
            const offsetAt = (ms: number) => {
                const offset_s = this.o.onClock?.(arm, ms);
                return typeof offset_s === "number" ? { offset_s } : {};
            };
            this.clock = new Clock(start, this.o.journal, Date.now, offsetAt);
            const initial = offsetAt(start);
            if (initial.offset_s !== undefined) this.log({ kind: "ClockOffset", ...initial });
            const driver = this.o.drivers[arm];
            if (!driver) throw new Error(`no driver for arm ${arm}`);
            const started = mine.some((e) => e.kind === "StartArm");
            if (!started) {
                await driver.reset();
                this.log({ kind: "StartArm" });
            }
            this.resume(mine);
            const done = new Set(
                this.o.journal.entries
                    .filter((e) => e.arm === arm && e.kind === "Event")
                    .map((e) => e.event as string),
            );
            const pending = this.o.events.filter((e) => !done.has(e.id));
            if (started) await driver.resume?.(this.openSession(pending[0], done));
            for (const e of pending) await this.step(driver, e);
            await this.idle();
            await this.pendingKill;
            const last = await driver.finish?.();
            this.logStores(last?.stores, null);
            // A kill between the summary and EndArm resumes here; the arm keeps its one summary.
            const summarised = mine.some((e) => e.kind === "UserSimRates");
            const rates = summarised ? undefined : this.o.armSummary?.(arm);
            if (rates) this.log({ kind: "UserSimRates", ...rates });
            this.log({ kind: "EndArm" });
        }
        this.arm = null;
        this.log({ kind: "EndRun" });
    }

    private resume(mine: Entry[]): void {
        const kinds = (k: string) => mine.filter((e) => e.kind === k);
        const done = new Set(kinds("Event").map((e) => e.event));
        const ended = new Set(kinds("EndTurn").map((e) => e.event));
        const begun = new Set(kinds("BeginTurn").map((e) => e.event));
        for (const e of kinds("EndTurn").filter((x) => !done.has(x.event))) {
            this.snapshotTurn(e);
            this.log({ kind: "Event", event: e.event, outcome: e.outcome });
        }
        const journaled = new Set(kinds("UserTurn").map((e) => e.event));
        const interrupted = kinds("BeginTurn").filter(
            (x) => !ended.has(x.event) && !done.has(x.event),
        );
        for (const e of interrupted) {
            const user = journaled.has(e.event)
                ? undefined
                : this.o.recoverTurn?.(e.event as string);
            if (user) this.log({ kind: "UserTurn", event: e.event, ...user, recovered: true });
            this.log({ kind: "ItemState", event: e.event, state: "failed(interrupted)" });
            this.log({ kind: "Event", event: e.event, outcome: "failed(interrupted)" });
        }
        const closed = new Set(kinds("EndJob").map((e) => e.job));
        for (const e of kinds("RegisterJob").filter((x) => !closed.has(x.job))) {
            this.log({ kind: "EndJob", job: e.job, interrupted: true });
        }
        const observed = new Set(kinds("FaultObserved").map((e) => e.fault));
        const firedIds = new Set(kinds("FaultFired").map((e) => e.fault));
        // A sleep's jump is journaled before its FaultFired; a jump without one has fired.
        for (const jump of kinds("AdvanceClock").filter((e) => e.fault !== undefined)) {
            const f = this.o.faults.find((x) => x.id === jump.fault);
            if (!f || firedIds.has(f.id)) continue;
            this.fired.add(`${this.arm}/${f.id}`);
            this.log({ kind: "FaultFired", fault: f.id, type: f.type, layer: f.seam.layer });
            const evidence = { clock_advanced_ms: jump.scenario_ms - Number(jump.from_ms) };
            this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
        }
        for (const fired of kinds("FaultFired")) {
            const f = this.o.faults.find((x) => x.id === fired.fault);
            this.fired.add(`${this.arm}/${fired.fault}`);
            if (!f) continue;
            if (f.seam.layer !== PROXY_LAYER) {
                if (!observed.has(f.id) && f.type !== "laptop_sleep") {
                    this.log({ kind: "ItemState", fault: f.id, state: "failed(interrupted)" });
                }
                continue;
            }
            const end = this.o.events.find(
                (e) => e.kind === "session_end" && e.session === f.trigger.session,
            );
            if (end && done.has(end.id)) continue;
            const t = f.trigger;
            const target = this.o.events.find(
                (e) => t.kind === "user_turn" && e.session === t.session && e.index === t.n - 1,
            );
            if (f.strategy === "persistent" || (target && !begun.has(target.id)))
                this.o.proxy?.arm(f.id);
        }
    }

    private openSession(next: ScenarioEvent | undefined, done: Set<string>): ScenarioEvent | null {
        if (!next || next.kind === "session_start") return null;
        const start = this.o.events.find(
            (e) => e.kind === "session_start" && e.session === next.session,
        );
        if (!start || !done.has(start.id)) return null;
        this.session = next.session;
        return start;
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
            this.log({ kind: "SnapshotArtefacts", item, snapshot });
        }
    }

    private async idle(): Promise<void> {
        await this.quiesce(() => this.clock?.busyIds() ?? []);
    }

    /**
     * Waits the settle window, in which a background call the host dispatched after its answer
     * registers its job, then waits for the background jobs in the busy set, with the turn
     * itself still open.
     */
    async quiesceJobs(): Promise<void> {
        await Bun.sleep(this.o.settleMs ?? 1_000);
        await this.quiesce(() =>
            (this.clock?.busyIds() ?? []).filter((id) => id.startsWith("job:")),
        );
    }

    private async quiesce(pending: () => string[]): Promise<void> {
        const limit = Date.now() + (this.o.idleLimitMs ?? Number.POSITIVE_INFINITY);
        while (pending().length > 0) {
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

    private async fire(driver: ArmDriver, f: FaultEpisode): Promise<void> {
        this.fired.add(`${this.arm}/${f.id}`);
        this.log({ kind: "FaultFired", fault: f.id, type: f.type, layer: f.seam.layer });
        if (f.seam.layer === PROXY_LAYER) {
            this.o.proxy?.arm(f.id);
            return;
        }
        if (f.type === "laptop_sleep") {
            const evidence = { clock_advanced_ms: f.params.duration_ms ?? 0 };
            this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
            return;
        }
        if (OUTAGE.has(f.type)) this.outage = f.id;
        const { stores, ...evidence } = await driver.fault(f);
        // Store checks an earlier restart owed, settled before this fault took the daemon down.
        this.logStores(stores as TurnOutcome["stores"], null);
        this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
    }

    private async step(driver: ArmDriver, e: ScenarioEvent): Promise<void> {
        await this.idle();
        await this.pendingKill;
        this.outage = null;
        const clock = this.clock as Clock;
        const faults = this.faultsAt(e);
        const arm = this.arm ?? "";
        // Every sleep keyed on this event jumps the clock by its own duration, one entry each.
        for (const sleep of faults.filter((f) => f.type === "laptop_sleep")) {
            clock.advanceTo(clock.now() + (sleep.params.duration_ms ?? 0), arm, {
                fault: sleep.id,
            });
        }
        clock.advanceTo(e.scenario_ms, arm, { next_event: e.id });
        this.session = e.session;
        for (const f of faults) await this.fire(driver, f);
        if (e.kind === "user_turn") {
            const turn = `turn:${e.id}`;
            this.log({ kind: "BeginTurn", event: e.id, probe: e.probe ?? null });
            clock.begin(turn);
            let outcome: TurnOutcome;
            try {
                outcome = await driver.event(e);
            } finally {
                clock.end(turn);
            }
            const state = outcome.failed ? "failed" : "completed";
            const item = e.probe ? { probe: e.probe, state } : {};
            // The checks and the user record go first: a kill before EndTurn replays the turn
            // with them on record, and a resume reads a turn's EndTurn as the whole turn.
            this.logStores(outcome.stores, e.id);
            if (outcome.user) this.log({ kind: "UserTurn", event: e.id, ...outcome.user });
            const snapshot = outcome.snapshot ? { snapshot: outcome.snapshot } : {};
            const end = { event: e.id, outcome: outcome.failed ?? "ok", ...item, ...snapshot };
            this.log({ kind: "EndTurn", ...end });
            this.snapshotTurn(end);
            await Bun.sleep(this.o.settleMs ?? 1_000);
        } else {
            const outcome = await driver.event(e);
            this.logStores(outcome.stores, e.id);
        }
        if (e.kind === "session_end") {
            for (const f of this.o.faults) {
                const mine = f.trigger.session === e.session && f.seam.layer === PROXY_LAYER;
                if (mine && f.strategy === "persistent") this.o.proxy?.disarm(f.id);
            }
            this.session = null;
        }
        this.log({ kind: "Event", event: e.id, outcome: "ok" });
    }

    jobStart(id: string): void {
        this.clock?.begin(`job:${id}`);
        this.log({ kind: "RegisterJob", job: id });
    }

    jobEnd(id: string): void {
        this.log({ kind: "EndJob", job: id });
        this.clock?.end(`job:${id}`);
    }

    observe(component: string, driver: ArmDriver): void {
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
    }

    daemonExited(detail: Record<string, unknown>): void {
        const expected = this.outage !== null;
        this.log({ kind: "ItemState", daemon_exit: detail, expected });
        if (!expected) throw new HarnessFailure("daemon exited outside a scheduled outage window");
    }
}
