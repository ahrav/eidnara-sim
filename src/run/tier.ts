import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";

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

/** The seed's pre-registered arm order plus an A/A control for each same-arm pair in it. */
function seedArms(prereg: Preregistration, i: number): string[] {
    const order = prereg.arms.order_by_seed[i] ?? prereg.arms.run;
    const controls = (prereg.aa_controls?.pairs ?? [])
        .filter(([arm, twin]) => arm === twin)
        .map(([arm]) => arm as string)
        .filter((arm) => order.includes(arm as never))
        .map((arm) => `${arm}~aa`);
    return [...order, ...controls];
}

/** Every pre-registered host and seed of a tier, each with its arms and A/A controls. */
export function tierPlan(
    prereg: Preregistration,
    scenarios: Map<number, Scenario>,
    hosts: ("pi" | "opencode")[],
    out: string,
    turnMs: number,
): TierJob[] {
    return hosts.flatMap((host) =>
        prereg.seeds.map((seed, i) => {
            const arms = seedArms(prereg, i);
            const scenario = scenarios.get(seed) as Scenario;
            const cap = capEvents(
                scenario,
                arms.length,
                prereg.liveness_bounds.tier_wall_budget_ms,
                turnMs,
            );
            const dir = `${out}/${prereg.tier}-${seed}-${host}`;
            return { host, seed, arms, ...cap, dir, group: "main", extra: [] };
        }),
    );
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
    const scenario = scenarios.get(seed) as Scenario;
    const budget = prereg.liveness_bounds.tier_wall_budget_ms;
    const cap = capEvents(scenario, seedArms(prereg, 0).length, budget, turnMs);
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
                    ["--side-model", prereg.user_sim.model],
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
    prefix.forEach((e, i) => {
        const before = prefix[i - 1];
        if (e.kind === "session_start" && before) {
            gap.set(String(e.session), Number(e.scenario_ms) - Number(before.scenario_ms));
        }
    });
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
    return scenario.faults.map((f, i) => {
        if (sessions.includes(f.trigger.session)) return f;
        const n = f.trigger.kind === "user_turn" ? (f.trigger.n ?? 1) : 0;
        const sleep = f.type === "laptop_sleep";
        const fits = (s: string) =>
            (f.trigger.kind !== "session_start" || s !== sessions[0]) &&
            (turns.get(s) ?? 0) >= Math.max(1, n) &&
            (f.trigger.kind !== "first_summarizer_call" || p90.has(s)) &&
            (!sleep || (gap.get(s) ?? 0) > 0);
        const start = Math.floor(((i + 1) * sessions.length) / (scenario.faults.length + 1));
        const order = [...sessions.slice(start), ...sessions.slice(0, start)];
        const session = order.find(fits);
        if (!session) return f;
        const params = sleep ? { ...f.params, duration_ms: gap.get(session) ?? 0 } : f.params;
        return { ...f, trigger: { ...f.trigger, session }, params };
    });
}
