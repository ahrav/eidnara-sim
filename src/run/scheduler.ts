import { canonicalJson, sha256Hex } from "../prereg/canonical";
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
    /** Called at every start of the driver's arm, before `reset`; the handle dies with the arm. */
    bind(arm: ArmHandle): void;
    reset(): Promise<void>;
    event(e: ScenarioEvent): Promise<{ failed?: string }>;
    fault(f: FaultEpisode): Promise<Record<string, unknown>>;
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

export interface ProxyControl {
    arm(id: string): void;
    disarm(id: string): void;
    /** Called at each arm's start, after the driver's reset, so every arm sees one fault schedule. */
    reset(): void;
}

export class HarnessFailure extends Error {}

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
    settleMs?: number;
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
    private generation = 0;
    private fatal: HarnessFailure | null = null;
    private failed: Promise<never> | null = null;
    private fail: ((error: HarnessFailure) => void) | null = null;

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
        const fatal = entries.find((e) => e.kind === "ItemState" && e.fatal === true);
        if (fatal) {
            const cause = fatal.fault
                ? `fault ${fatal.fault} failed`
                : "the daemon exited outside an outage window";
            throw new HarnessFailure(`run failed: ${cause}`);
        }
        const finished = new Set(entries.filter((e) => e.kind === "EndArm").map((e) => e.arm));
        const scenario = scenarioId(this.o.events, this.o.faults);
        const start = entries.find((e) => e.kind === "StartRun");
        if (start) {
            if (JSON.stringify(start.order) !== JSON.stringify(this.o.order)) {
                throw new Error(
                    `scheduler: run was started with arm order ${JSON.stringify(start.order)}`,
                );
            }
            if (start.scenario !== scenario) {
                throw new Error(`scheduler: run was started with scenario ${start.scenario}`);
            }
        }
        if (entries.some((e) => e.kind === "EndRun")) {
            const open = this.o.order.filter((arm) => !this.completed(entries, arm));
            if (!start || open.length > 0) {
                throw new Error(`journal: EndRun with unfinished arms ${JSON.stringify(open)}`);
            }
            return;
        }
        for (const arm of this.o.order) {
            if (!finished.has(arm) && !this.o.drivers[arm])
                throw new Error(`no driver for arm ${arm}`);
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
            this.clock = new Clock(mine.at(-1)?.scenario_ms ?? 0, this.o.journal);
            const driver = this.o.drivers[arm] as ArmDriver;
            try {
                driver.bind(this.handle(++this.generation, driver));
                if (!mine.some((e) => e.kind === "StartArm")) {
                    await driver.reset();
                    this.o.proxy?.reset();
                    this.log({ kind: "StartArm" });
                }
                this.resume(mine);
                const done = new Set(
                    this.o.journal.entries
                        .filter((e) => e.arm === arm && e.kind === "Event")
                        .map((e) => e.event as string),
                );
                try {
                    for (const e of this.o.events) {
                        if (!done.has(e.id)) await this.step(driver, e);
                    }
                    await this.quiesce();
                } finally {
                    await this.pendingKill?.catch(() => undefined);
                }
                this.log({ kind: "EndArm" });
            } finally {
                this.generation++;
                this.pendingKill = null;
                this.outage = null;
                this.session = null;
                this.arm = null;
                this.clock = null;
            }
        }
        if (this.fatal) throw this.fatal;
        this.log({ kind: "EndRun" });
    }

    /** An arm is complete when it started, ended, and journaled an `Event` for every event. */
    private completed(entries: Entry[], arm: string): boolean {
        const mine = entries.filter((e) => e.arm === arm);
        const kinds = new Set(mine.map((e) => e.kind));
        if (!kinds.has("StartArm") || !kinds.has("EndArm")) return false;
        const done = new Set(mine.filter((e) => e.kind === "Event").map((e) => e.event));
        return this.o.events.every((e) => done.has(e.id));
    }

    /**
     * Resolves with the driver call's result, or rejects as soon as a fatal daemon exit is
     * recorded, so a call the dead daemon never answers cannot hold the run.
     */
    private untilFatal<T>(call: Promise<T>): Promise<T> {
        if (this.fatal) return Promise.reject(this.fatal);
        this.failed ??= new Promise<never>((_, reject) => {
            this.fail = reject;
        });
        this.failed.catch(() => undefined);
        call.catch(() => undefined);
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
        } while (kill !== this.pendingKill);
        if (this.fatal) throw this.fatal;
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
            for (let i = 0; i < n; i++) {
                this.log({ kind: "EndJob", job, outcome: "failed(interrupted)" });
            }
        }
        for (const e of kinds("ItemState")) {
            if (e.state === "missed" && typeof e.fault === "string") {
                this.fired.add(`${this.arm}/${e.fault}`);
            }
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

    private async idle(): Promise<void> {
        while ((this.clock?.busyIds().length ?? 0) > 0) {
            if (this.fatal) throw this.fatal;
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
        if (f.seam.layer === PROXY_LAYER) this.o.proxy?.arm(f.id);
        this.log({ kind: "FaultFired", fault: f.id, type: f.type, layer: f.seam.layer });
        this.fired.add(`${this.arm}/${f.id}`);
        if (f.seam.layer === PROXY_LAYER) return;
        if (f.type === "laptop_sleep") return;
        if (OUTAGE.has(f.type)) this.outage = f.id;
        let evidence: Record<string, unknown>;
        try {
            evidence = await driver.fault(f);
        } catch (caught) {
            const error = caught instanceof Error ? caught.message : String(caught);
            this.log({ kind: "ItemState", fault: f.id, state: "failed", error, fatal: true });
            throw caught;
        }
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
        await this.quiesce();
        this.outage = null;
        const clock = this.clock as Clock;
        const sleep = this.sleepBefore(e);
        const arm = this.arm ?? "";
        const jumped = clock.now() < e.scenario_ms;
        clock.advanceTo(e.scenario_ms, arm, sleep ? { fault: sleep.id } : { next_event: e.id });
        this.session = e.session;
        if (sleep && !jumped) {
            this.log({ kind: "ItemState", fault: sleep.id, state: "missed" });
            this.fired.add(`${this.arm}/${sleep.id}`);
        } else if (sleep) {
            await this.fire(driver, sleep);
        }
        for (const f of this.faultsAt(e)) await this.fire(driver, f);
        let outcome: { failed?: string };
        if (e.kind === "user_turn") {
            const turn = `turn:${e.id}`;
            this.log({ kind: "BeginTurn", event: e.id, probe: e.probe ?? null });
            clock.begin(turn);
            try {
                outcome = await this.untilFatal(driver.event(e));
            } finally {
                clock.end(turn);
            }
            const state = outcome.failed === undefined ? "completed" : "failed";
            const item = e.probe ? { probe: e.probe, state } : {};
            this.log({ kind: "EndTurn", event: e.id, outcome: outcome.failed ?? "ok", ...item });
            await Bun.sleep(this.o.settleMs ?? 1_000);
        } else {
            outcome = await this.untilFatal(driver.event(e));
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

    private handle(generation: number, driver: ArmDriver): ArmHandle {
        const live = (): Clock => {
            if (generation !== this.generation || !this.clock) {
                throw new Error("scheduler: this arm has ended");
            }
            return this.clock;
        };
        return {
            jobStart: (id) => {
                live().begin(`job:${id}`);
                this.log({ kind: "RegisterJob", job: id });
            },
            jobEnd: (id) => {
                live().end(`job:${id}`);
                this.log({ kind: "EndJob", job: id });
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
            daemonExited: (detail) => {
                live();
                const expected = this.outage !== null;
                this.outage = null;
                this.log({ kind: "ItemState", daemon_exit: detail, expected, fatal: !expected });
                if (!expected) {
                    this.fatal ??= new HarnessFailure(
                        "daemon exited outside a scheduled outage window",
                    );
                    this.fail?.(this.fatal);
                    throw this.fatal;
                }
            },
        };
    }
}
