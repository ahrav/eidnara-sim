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
        return { host, seed, arms, ...cap, dir: `${out}/${prereg.tier}-${seed}-${host}` };
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
