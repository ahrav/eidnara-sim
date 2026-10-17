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

export interface ArmDriver {
    reset(): Promise<void>;
    /**
     * Restores a started arm in a new harness process. `open` is the `session_start` of the
     * session the next event belongs to, or null between sessions.
     */
    resume?(open: ScenarioEvent | null): Promise<void>;
    event(e: ScenarioEvent): Promise<{ failed?: string; snapshot?: string }>;
    fault(f: FaultEpisode): Promise<Record<string, unknown>>;
    /** Stops everything the arm runs, after its last event and before `EndArm`. */
    finish?(): Promise<void>;
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
    onClock?: (arm: string, scenarioMs: number) => void;
    /** Runs before `EndArm` and `EndRun` are journaled; a throw leaves the arm or run open. */
    beforeEnd?: () => void;
}

const PROXY_LAYER = "proxy-sink";
const OUTAGE = new Set(["daemon_sigkill_mid_fold", "daemon_restart", "host_upgrade"]);

export class Scheduler {
    clock: Clock | null = null;
    private arm: string | null = null;
    private session: string | null = null;
    private outage: string | null = null;
    private readonly fired = new Set<string>();
    private pendingKill: Promise<unknown> | null = null;

    constructor(private readonly o: SchedulerOptions) {}

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
            const onClock = (ms: number) => this.o.onClock?.(arm, ms);
            this.clock = new Clock(start, this.o.journal, Date.now, onClock);
            onClock(start);
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
            await driver.finish?.();
            this.o.beforeEnd?.();
            this.log({ kind: "EndArm" });
        }
        this.arm = null;
        this.o.beforeEnd?.();
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
        const interrupted = kinds("BeginTurn").filter(
            (x) => !ended.has(x.event) && !done.has(x.event),
        );
        for (const e of interrupted) {
            this.log({ kind: "ItemState", event: e.event, state: "failed(interrupted)" });
            this.log({ kind: "Event", event: e.event, outcome: "failed(interrupted)" });
        }
        const closed = new Set(kinds("EndJob").map((e) => e.job));
        for (const e of kinds("RegisterJob").filter((x) => !closed.has(x.job))) {
            this.log({ kind: "EndJob", job: e.job, interrupted: true });
        }
        const observed = new Set(kinds("FaultObserved").map((e) => e.fault));
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
        const limit = Date.now() + (this.o.idleLimitMs ?? Number.POSITIVE_INFINITY);
        await this.quiesce(() => this.clock?.busyIds() ?? [], limit);
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
        await Bun.sleep(settle);
        await this.quiesce(jobs, limit);
        let quietSince = Date.now();
        let activity = this.jobActivity;
        while (Date.now() - quietSince < settle) {
            await Bun.sleep(this.o.jobPollMs ?? 50);
            if (this.jobActivity !== activity || jobs().length > 0) {
                await this.quiesce(jobs, limit);
                activity = this.jobActivity;
                quietSince = Date.now();
            }
        }
    }

    /** Counts every job start and end, so a job that begins and ends between two polls still resets the quiet window. */
    private jobActivity = 0;

    private async quiesce(pending: () => string[], limit: number): Promise<void> {
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
        if (f.type === "laptop_sleep") return;
        if (OUTAGE.has(f.type)) this.outage = f.id;
        const evidence = await driver.fault(f);
        this.log({ kind: "FaultObserved", fault: f.id, type: f.type, evidence });
    }

    private async step(driver: ArmDriver, e: ScenarioEvent): Promise<void> {
        await this.idle();
        await this.pendingKill;
        this.outage = null;
        const clock = this.clock as Clock;
        const faults = this.faultsAt(e);
        const sleep = faults.find((f) => f.type === "laptop_sleep");
        const arm = this.arm ?? "";
        if (sleep)
            clock.advanceTo(clock.now() + (sleep.params.duration_ms ?? 0), arm, {
                fault: sleep.id,
            });
        clock.advanceTo(e.scenario_ms, arm, { next_event: e.id });
        this.session = e.session;
        for (const f of faults) await this.fire(driver, f);
        if (e.kind === "user_turn") {
            const turn = `turn:${e.id}`;
            this.log({ kind: "BeginTurn", event: e.id, probe: e.probe ?? null });
            clock.begin(turn);
            let outcome: { failed?: string; snapshot?: string };
            try {
                outcome = await driver.event(e);
            } finally {
                clock.end(turn);
            }
            const state = outcome.failed ? "failed" : "completed";
            const item = e.probe ? { probe: e.probe, state } : {};
            const snapshot = outcome.snapshot ? { snapshot: outcome.snapshot } : {};
            const end = { event: e.id, outcome: outcome.failed ?? "ok", ...item, ...snapshot };
            this.log({ kind: "EndTurn", ...end });
            this.snapshotTurn(end);
            await Bun.sleep(this.o.settleMs ?? 1_000);
        } else {
            await driver.event(e);
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
        this.jobActivity++;
        this.clock?.begin(`job:${id}`);
        this.log({ kind: "RegisterJob", job: id });
    }

    jobEnd(id: string): void {
        this.jobActivity++;
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
