import { createHash } from "node:crypto";
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
    event(e: ScenarioEvent): Promise<{ failed?: string }>;
    fault(f: FaultEpisode): Promise<Record<string, unknown>>;
    /** Stops everything the arm runs, after its last event and before `EndArm`. */
    finish?(): Promise<void>;
}

export interface ProxyControl {
    arm(id: string): void;
    disarm(id: string): void;
}

export class HarnessFailure extends Error {}

/** The identity `StartRun` records and a resume must present again. */
export function scenarioId(events: ScenarioEvent[], faults: FaultEpisode[]): string {
    return createHash("sha256")
        .update(JSON.stringify([events, faults]))
        .digest("hex");
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
    settleMs?: number;
    onClock?: (arm: string, scenarioMs: number) => void;
}

const PROXY_LAYER = "proxy-sink";
const OUTAGE = new Set(["daemon_sigkill_mid_fold", "daemon_restart", "host_upgrade"]);

export class Scheduler {
    clock: Clock | null = null;
    private arm: string | null = null;
    private session: string | null = null;
    private outage: string | null = null;
    private readonly fired = new Set<string>();
    private readonly jobStarted = new Map<string, number>();
    private pendingKill: Promise<unknown> | null = null;

    constructor(private readonly o: SchedulerOptions) {
        if (!o.proxy && o.faults.some((f) => f.seam.layer === PROXY_LAYER)) {
            throw new Error("scheduler: proxy faults are scheduled but no proxy control was given");
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
        if (entries.some((e) => e.kind === "EndRun")) return;
        const finished = new Set(entries.filter((e) => e.kind === "EndArm").map((e) => e.arm));
        for (const arm of this.o.order) {
            if (!finished.has(arm) && !this.o.drivers[arm])
                throw new Error(`no driver for arm ${arm}`);
        }
        const scenario = scenarioId(this.o.events, this.o.faults);
        const start = entries.find((e) => e.kind === "StartRun");
        if (!start) {
            this.log({ kind: "StartRun", order: this.o.order, scenario });
        } else {
            if (JSON.stringify(start.order) !== JSON.stringify(this.o.order)) {
                throw new Error(
                    `scheduler: run was started with arm order ${JSON.stringify(start.order)}`,
                );
            }
            if (start.scenario !== scenario) {
                throw new Error(`scheduler: run was started with scenario ${start.scenario}`);
            }
            this.log({ kind: "ResumeRun", order: this.o.order, scenario });
        }
        for (const arm of this.o.order) {
            const mine = entries.filter((e) => e.arm === arm);
            if (mine.some((e) => e.kind === "EndArm")) continue;
            this.arm = arm;
            const start = mine.at(-1)?.scenario_ms ?? 0;
            const onClock = (ms: number) => this.o.onClock?.(arm, ms);
            this.clock = new Clock(start, this.o.journal, undefined, onClock);
            onClock(start);
            const driver = this.o.drivers[arm] as ArmDriver;
            const started = mine.some((e) => e.kind === "StartArm");
            if (!started) {
                await this.orFinish(driver, () => driver.reset());
                this.log({ kind: "StartArm" });
            }
            this.resume(mine);
            const done = new Set(
                this.o.journal.entries
                    .filter((e) => e.arm === arm && e.kind === "Event")
                    .map((e) => e.event as string),
            );
            const pending = this.o.events.filter((e) => !done.has(e.id));
            await this.runArm(driver, started, pending, done);
            this.pendingKill = null;
            this.outage = null;
            this.session = null;
            this.log({ kind: "EndArm" });
        }
        this.arm = null;
        this.log({ kind: "EndRun" });
    }

    /** Resume continues a failed arm whose journal ends before `EndArm`. */
    private async runArm(
        driver: ArmDriver,
        started: boolean,
        pending: ScenarioEvent[],
        done: Set<string>,
    ): Promise<void> {
        await this.orFinish(driver, async () => {
            if (started) await driver.resume?.(this.openSession(pending[0], done));
            for (const e of pending) await this.step(driver, e);
            await this.pendingKill;
            await this.idle();
        });
        await driver.finish?.();
    }

    /** A failure waits for a mid-fold restart in flight, finishes the driver, and surfaces as itself. */
    private async orFinish<T>(driver: ArmDriver, work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (caught) {
            await this.pendingKill?.catch(() => undefined);
            await driver.finish?.().catch(() => undefined);
            throw caught;
        }
    }

    /** Existing Event and failed(interrupted) entries make recovery writes idempotent across resumes. */
    private resume(mine: Entry[]): void {
        const kinds = (k: string) => mine.filter((e) => e.kind === k);
        const done = new Set(kinds("Event").map((e) => e.event));
        const ended = new Set(kinds("EndTurn").map((e) => e.event));
        const begun = new Set(kinds("BeginTurn").map((e) => e.event));
        const interrupted = kinds("ItemState").filter((e) => e.state === "failed(interrupted)");
        const marked = new Set(interrupted.map((e) => e.event ?? e.fault));
        for (const e of kinds("EndTurn").filter((x) => !done.has(x.event))) {
            this.log({ kind: "Event", event: e.event, outcome: e.outcome });
        }
        for (const e of kinds("BeginTurn").filter(
            (x) => !ended.has(x.event) && !done.has(x.event),
        )) {
            if (!marked.has(e.event)) {
                this.log({ kind: "ItemState", event: e.event, state: "failed(interrupted)" });
            }
            this.log({ kind: "Event", event: e.event, outcome: "failed(interrupted)" });
        }
        const open = new Map<unknown, number>();
        for (const e of mine) {
            if (e.kind === "RegisterJob") open.set(e.job, (open.get(e.job) ?? 0) + 1);
            if (e.kind === "EndJob") open.set(e.job, (open.get(e.job) ?? 0) - 1);
        }
        for (const [job, n] of open) {
            if (n > 0) this.log({ kind: "EndJob", job, outcome: "failed(interrupted)" });
        }
        const observed = new Set(kinds("FaultObserved").map((e) => e.fault));
        for (const fired of kinds("FaultFired")) {
            const f = this.o.faults.find((x) => x.id === fired.fault);
            this.fired.add(`${this.arm}/${fired.fault}`);
            if (!f) continue;
            if (f.seam.layer !== PROXY_LAYER) {
                if (!observed.has(f.id) && !marked.has(f.id) && f.type !== "laptop_sleep") {
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

    /** The busy set may hold the clock for `idleLimitMs` of wall time from its oldest `RegisterJob`. */
    private async idle(): Promise<void> {
        const limitMs = this.o.idleLimitMs ?? Number.POSITIVE_INFINITY;
        const entered = Date.now();
        while ((this.clock?.busyIds().length ?? 0) > 0) {
            const oldest = Math.min(entered, ...this.jobStarted.values());
            if (Date.now() > oldest + limitMs) {
                const busy = this.clock?.busyIds().join(", ");
                throw new HarnessFailure(
                    `busy set held the clock past ${this.o.idleLimitMs} ms: ${busy}`,
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

    private async step(driver: ArmDriver, e: ScenarioEvent): Promise<void> {
        await this.pendingKill;
        await this.idle();
        this.outage = null;
        const clock = this.clock as Clock;
        const sleep = this.sleepBefore(e);
        const arm = this.arm ?? "";
        clock.advanceTo(e.scenario_ms, arm, sleep ? { fault: sleep.id } : { next_event: e.id });
        this.session = e.session;
        if (sleep) await this.fire(driver, sleep);
        for (const f of this.faultsAt(e)) await this.fire(driver, f);
        let outcome: { failed?: string };
        if (e.kind === "user_turn") {
            const turn = `turn:${e.id}`;
            this.log({ kind: "BeginTurn", event: e.id, probe: e.probe ?? null });
            clock.begin(turn);
            try {
                outcome = await driver.event(e);
            } finally {
                clock.end(turn);
            }
            const state = outcome.failed ? "failed" : "completed";
            const item = e.probe ? { probe: e.probe, state } : {};
            this.log({ kind: "EndTurn", event: e.id, outcome: outcome.failed ?? "ok", ...item });
            await Bun.sleep(this.o.settleMs ?? 1_000);
        } else {
            outcome = await driver.event(e);
        }
        if (e.kind === "session_end") {
            for (const f of this.o.faults) {
                if (f.trigger.session === e.session && f.seam.layer === PROXY_LAYER)
                    this.o.proxy?.disarm(f.id);
            }
            this.session = null;
        }
        await this.pendingKill;
        this.log({ kind: "Event", event: e.id, outcome: outcome.failed ?? "ok" });
    }

    jobStart(id: string): void {
        this.jobStarted.set(id, Date.now());
        this.clock?.begin(`job:${id}`);
        this.log({ kind: "RegisterJob", job: id });
    }

    jobEnd(id: string): void {
        this.jobStarted.delete(id);
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
