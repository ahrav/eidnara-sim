import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import { readJournal } from "./journal";

export interface TierJob {
    host: "pi" | "opencode";
    seed: number;
    arms: string[];
    events: number;
    user_turns: number;
    dir: string;
    /** `main` for the tier's paired runs; a profile name for runs reported apart. */
    group: string;
    extra: string[];
}

/** Room left in the wall budget for setup, grading, and the turns' variance. */
const BUDGET_SHARE = 0.85;

export function restartFraction(
    flag: string | undefined,
    prior: { restart_at?: number } | null,
    tier: Preregistration["tier"],
): number {
    if (flag !== undefined) return /^\d*\.?\d+$/.test(flag) ? Number(flag) : Number.NaN;
    return prior?.restart_at ?? (tier === "XL" ? 0.4 : 0);
}

/**
 * The journal `Event` threshold for requesting a paired run's restart: the first count at or past
 * `restartAt` of the planned events across `arms`. Null when that count is the run's last event
 * or `restartAt` is 0.
 */
export function restartCut(restartAt: number, events: number, arms: number): number | null {
    const total = events * arms;
    const cut = Math.ceil(restartAt * total);
    return restartAt > 0 && cut < total ? cut : null;
}

/** The paired runs that began under a saved restart fraction the chosen one would change. */
export function restartConflicts(
    plan: TierJob[],
    saved: number | undefined,
    chosen: number,
): string[] {
    if (saved === undefined || saved === chosen) return [];
    return plan
        .filter((j) => j.group === "main" && existsSync(join(j.dir, "journal.jsonl")))
        .map((j) => `${j.dir} began under --restart-at ${saved}; the plan now says ${chosen}`);
}

/** The paired runs a positive `restartAt` has no cut for, named before the plan is saved. */
export function uncuttableRuns(plan: TierJob[], restartAt: number): string[] {
    if (!(restartAt > 0)) return [];
    return plan
        .filter(
            (j) => j.group === "main" && restartCut(restartAt, j.events, j.arms.length) === null,
        )
        .map((j) => j.dir);
}

/**
 * The longest prefix of the scenario that ends on a session end and whose user turns, run once
 * per arm at `turnMs` each, fit inside the tier's wall budget.
 */
export function capEvents(
    scenario: Scenario,
    arms: number,
    budgetMs: number,
    turnMs: number,
): { events: number; user_turns: number } {
    const room = Math.floor((BUDGET_SHARE * budgetMs) / (arms * turnMs));
    let [turns, best] = [0, { events: 0, user_turns: 0 }];
    scenario.events.forEach((e, i) => {
        if (e.kind === "user_turn") turns++;
        if (turns <= room && e.kind === "session_end") best = { events: i + 1, user_turns: turns };
    });
    return best;
}

/** Every pre-registered host and seed of a tier, each with its arms and A/A controls. */
export function tierPlan(
    prereg: Preregistration,
    scenarios: Map<number, Scenario>,
    hosts: ("pi" | "opencode")[],
    out: string,
    turnMs: number,
): TierJob[] {
    // The A/A controls ride on exactly `aa_controls.repeats` runs, which is what the campaign's
    // completeness check counts; seeds vary first so the controls spread across hosts.
    const repeats = prereg.aa_controls?.repeats ?? 0;
    const jobs = prereg.seeds.flatMap((seed, i) =>
        hosts.map((host) => ({
            host,
            seed,
            order: prereg.arms.order_by_seed[i] ?? prereg.arms.run,
        })),
    );
    const planned = jobs.map((job, n) => {
        const paired = new Set(
            (prereg.aa_controls?.pairs ?? [])
                .filter(([arm, twin]) => arm === twin)
                .map(([arm]) => arm as string),
        );
        // Each control follows its arm, the order armOrder() persists in the manifest.
        const arms = (job.order as string[]).flatMap((arm) =>
            n < repeats && paired.has(arm) ? [arm, `${arm}~aa`] : [arm],
        );
        return { ...job, arms };
    });
    // Every run shares the prefix that fits the run with the most arms.
    const widest = Math.max(...planned.map((j) => j.arms.length));
    const byHost = hosts.flatMap((host) => planned.filter((j) => j.host === host));
    return byHost.map(({ host, seed, arms }) => {
        const scenario = scenarios.get(seed) as Scenario;
        const cap = capEvents(scenario, widest, prereg.liveness_bounds.tier_wall_budget_ms, turnMs);
        const dir = `${out}/${prereg.tier}-${seed}-${host}`;
        return { host, seed, arms, ...cap, dir, group: "main", extra: [] };
    });
}

/**
 * The tier's extra profiles. M adds a model-factor run per host with Eidnara's side calls on
 * the user-sim's Haiku model, and one Pi run with the judge's `gpt-5.6-luna` as the user-sim.
 * L adds the concurrent-arms load-stress profile: each arm of the first seed in its own run,
 * all started together. Every profile run takes the first seed's paired-run prefix, so it
 * covers the same items as the paired runs it is set beside.
 */
export function profileJobs(
    prereg: Preregistration,
    scenarios: Map<number, Scenario>,
    hosts: ("pi" | "opencode")[],
    out: string,
    turnMs: number,
): TierJob[] {
    const seed = prereg.seeds[0] as number;
    const paired = tierPlan(prereg, scenarios, hosts, out, turnMs).find((j) => j.seed === seed);
    const cap = { events: paired?.events ?? 0, user_turns: paired?.user_turns ?? 0 };
    const job = (
        host: "pi" | "opencode",
        group: string,
        arms: string[],
        extra: string[],
        dir: string,
    ) => ({ host, seed, arms, ...cap, dir, group, extra });
    const base = (host: string) => `${out}/${prereg.tier}-${seed}-${host}`;
    if (prereg.tier === "M") {
        const pair = ["host", prereg.arms.default];
        return [
            ...hosts.map((h) =>
                job(
                    h,
                    "side-haiku",
                    pair,
                    ["--side-model", prereg.user_sim.model, "--tapes", `${base(h)}/tape.jsonl`],
                    `${base(h)}-side-haiku`,
                ),
            ),
            ...(hosts.includes("pi")
                ? [
                      job(
                          "pi",
                          "usersim-luna",
                          pair,
                          ["--user-sim-model", prereg.grading.judge.model],
                          `${base("pi")}-usersim-luna`,
                      ),
                  ]
                : []),
        ];
    }
    if (prereg.load_stress?.arms_concurrent) {
        const order = prereg.arms.order_by_seed[0] ?? prereg.arms.run;
        return hosts.flatMap((h) =>
            order.map((arm) => job(h, "concurrent", [arm], [], `${base(h)}-concurrent/${arm}`)),
        );
    }
    return [];
}

/**
 * The scenario's fault schedule moved inside a capped prefix: each fault whose trigger session
 * lies past the prefix moves to a prefix session spread evenly by its order, the first one with
 * enough user turns for a turn-triggered fault and the first that folds for a summarizer
 * trigger. A fault no prefix session can host keeps its trigger and stays untriggered.
 */
export function compressFaults(scenario: Scenario, events: number): FaultEpisode[] {
    const prefix = scenario.events.slice(0, events);
    const gap = new Map<string, number>();
    let lastEnd: number | null = null;
    for (const e of prefix) {
        if (e.kind === "session_start" && lastEnd !== null) {
            gap.set(String(e.session), Number(e.scenario_ms) - lastEnd);
        }
        if (e.kind === "session_end") lastEnd = Number(e.scenario_ms);
    }
    const ended = new Set(
        prefix.filter((e) => e.kind === "session_end").map((e) => String(e.session)),
    );
    const turns = new Map<string, number>();
    for (const e of prefix) {
        if (e.kind === "user_turn" && ended.has(String(e.session))) {
            turns.set(String(e.session), (turns.get(String(e.session)) ?? 0) + 1);
        }
    }
    const sessions = [...turns.keys()];
    const p90 = new Set(scenario.sessions.filter((s) => s.forced_p90).map((s) => s.id));
    if (!sessions.some((s) => p90.has(s)) && sessions.length > 0) {
        const longest = sessions.reduce((a, b) =>
            (turns.get(b) ?? 0) > (turns.get(a) ?? 0) ? b : a,
        );
        p90.add(longest);
    }
    const slot = (t: FaultEpisode["trigger"], s = t.session) =>
        t.kind === "user_turn" ? `${s}/${t.n ?? 1}` : null;
    const taken = new Set(
        scenario.faults
            .filter((f) => sessions.includes(f.trigger.session))
            .flatMap((f) => slot(f.trigger) ?? []),
    );
    return scenario.faults.map((f, i) => {
        if (sessions.includes(f.trigger.session)) return f;
        const n = f.trigger.kind === "user_turn" ? (f.trigger.n ?? 1) : 0;
        const sleep = f.type === "laptop_sleep";
        const fits = (s: string) =>
            (f.trigger.kind !== "session_start" || s !== sessions[0]) &&
            (turns.get(s) ?? 0) >= Math.max(1, n) &&
            (f.trigger.kind !== "first_summarizer_call" || p90.has(s)) &&
            (!sleep || (gap.get(s) ?? 0) > 0) &&
            !taken.has(slot(f.trigger, s) ?? "");
        const start = Math.floor(((i + 1) * sessions.length) / (scenario.faults.length + 1));
        const order = [...sessions.slice(start), ...sessions.slice(0, start)];
        const session = order.find(fits);
        if (!session) return f;
        const used = slot(f.trigger, session);
        if (used) taken.add(used);
        const params = sleep ? { ...f.params, duration_ms: gap.get(session) ?? 0 } : f.params;
        return { ...f, trigger: { ...f.trigger, session }, params };
    });
}

/**
 * When the run began and, for a completed run, ended: its journaled `StartRun` and `EndRun`,
 * with `now` standing in for a run with no journal yet.
 */
export function runSpan(dir: string, now: number): { started: number; ended?: number } {
    const path = join(dir, "journal.jsonl");
    if (!existsSync(path)) return { started: now };
    const entries = readJournal(path);
    const wall = (kind: string) => {
        const e = entries.find((x) => x.kind === kind);
        if (e === undefined) return undefined;
        if (!Number.isFinite(e.wall_ms))
            throw new Error(`${path}: ${kind} wall_ms is not a number`);
        return e.wall_ms;
    };
    const started = wall("StartRun") ?? now;
    const ended = wall("EndRun");
    if (ended !== undefined && ended < started)
        throw new Error(`${path}: EndRun at ${ended} is before StartRun at ${started}`);
    return ended === undefined ? { started } : { started, ended };
}

/**
 * Completed or begun runs whose manifest records another fault schedule than the plan compresses
 * their prefix to; `null` faults means the scenario's own schedule.
 */
export function scheduleConflicts(plan: [TierJob, FaultEpisode[] | null][]): string[] {
    return plan.flatMap(([job, faults]) => {
        const path = join(job.dir, "manifest.json");
        if (!existsSync(path)) return [];
        const ran = JSON.parse(readFileSync(path, "utf8")).fault_override ?? null;
        return JSON.stringify(ran) === JSON.stringify(faults)
            ? []
            : [`${job.dir} ran another fault schedule than the plan compresses to`];
    });
}

/** Jobs whose planned prefix differs from the events their existing manifest ran. */
export function planConflicts(plan: TierJob[]): string[] {
    return plan.flatMap((job) => {
        const path = join(job.dir, "manifest.json");
        if (!existsSync(path)) return [];
        const m = JSON.parse(readFileSync(path, "utf8")) as {
            events: number;
            order?: string[];
            host?: string;
            seed?: number;
        };
        const out: string[] = [];
        if (Number(m.events) !== job.events)
            out.push(`${job.dir} ran ${m.events} events, the plan says ${job.events}`);
        if (m.order && m.order.join(",") !== job.arms.join(","))
            out.push(
                `${job.dir} ran arms ${m.order.join(",")}, the plan says ${job.arms.join(",")}`,
            );
        if (
            (m.host !== undefined && m.host !== job.host) ||
            (m.seed !== undefined && m.seed !== job.seed)
        )
            out.push(
                `${job.dir} ran host ${m.host} seed ${m.seed}, the plan says ${job.host} ${job.seed}`,
            );
        return out;
    });
}
