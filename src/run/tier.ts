import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";

export interface TierJob {
    host: "pi" | "opencode";
    seed: number;
    arms: string[];
    events: number;
    user_turns: number;
    dir: string;
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
            const order = prereg.arms.order_by_seed[i] ?? prereg.arms.run;
            const controls = (prereg.aa_controls?.pairs ?? [])
                .map(([arm]) => arm as string)
                .filter((arm) => order.includes(arm as never))
                .map((arm) => `${arm}~aa`);
            const arms = [...order, ...controls];
            const scenario = scenarios.get(seed) as Scenario;
            const cap = capEvents(
                scenario,
                arms.length,
                prereg.liveness_bounds.tier_wall_budget_ms,
                turnMs,
            );
            return { host, seed, arms, ...cap, dir: `${out}/${prereg.tier}-${seed}-${host}` };
        }),
    );
}
