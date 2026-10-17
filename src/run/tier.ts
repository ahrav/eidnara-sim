import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Preregistration } from "../prereg/schema";
import type { Scenario } from "../scenario/compile";
import { readJournal } from "./journal";

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
                .filter(([arm, twin]) => arm === twin)
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

/** When the run began: its journaled `StartRun`, or `now` for a run with no journal yet. */
export function runStartedMs(dir: string, now: number): number {
    const path = join(dir, "journal.jsonl");
    if (!existsSync(path)) return now;
    const start = readJournal(path).find((e) => e.kind === "StartRun");
    return start ? start.wall_ms : now;
}

/** Jobs whose planned prefix differs from the events their existing manifest ran. */
export function planConflicts(plan: TierJob[]): string[] {
    return plan.flatMap((job) => {
        const path = join(job.dir, "manifest.json");
        if (!existsSync(path)) return [];
        const ran = Number(JSON.parse(readFileSync(path, "utf8")).events);
        return ran === job.events
            ? []
            : [`${job.dir} ran ${ran} events, the plan says ${job.events}`];
    });
}
