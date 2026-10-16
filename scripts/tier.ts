import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { Children, SIGTERM_EXIT } from "../src/run/children";
import { loadScenario } from "../src/run/run";
import { tierPlan } from "../src/run/tier";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--plan-only]";
const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};
const tier = arg("tier") as Tier;
const outArg = arg("out");
if (!TIERS.includes(tier) || !outArg) {
    console.error(USAGE);
    process.exit(2);
}
const out = resolve(outArg);
const config = loadConfig();
const prereg = loadPrereg(tier);
const hosts = (arg("hosts") ?? prereg.hosts.join(",")).split(",") as ("pi" | "opencode")[];
const priorPlan = join(out, "tier-plan.json");
const turnMs = Number(
    arg("turn-ms") ??
        (existsSync(priorPlan) ? JSON.parse(readFileSync(priorPlan, "utf8")).turn_ms : 75_000),
);
const fail = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    process.exit(2);
};
if (!Number.isInteger(turnMs) || turnMs <= 0) fail("--turn-ms must be a positive integer");
if (new Set(hosts).size !== hosts.length || !hosts.every((h) => prereg.hosts.includes(h)))
    fail(`--hosts must name distinct hosts from ${prereg.hosts.join(",")}`);
mkdirSync(out, { recursive: true });

const scenarios = new Map<number, Scenario>();
for (const seed of prereg.seeds) {
    const dir = join(out, `scenarios-${seed}`);
    mkdirSync(dir, { recursive: true });
    scenarios.set(seed, await loadScenario({ config, tier, seed, out: dir }));
}
const plan = tierPlan(prereg, scenarios, hosts, out, turnMs);
writeFileSync(
    join(out, "tier-plan.json"),
    `${JSON.stringify({ tier, turn_ms: turnMs, plan }, null, 2)}\n`,
);
console.log(JSON.stringify(plan.map((j) => [j.dir, j.events, j.user_turns, j.arms.join(",")])));
const empty = plan.filter((j) => j.events === 0).map((j) => j.dir);
if (empty.length > 0) fail(`no session fits the wall budget for ${empty.join(", ")}`);
if (process.argv.includes("--plan-only")) process.exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const children = new Children(env);
const script = (name: string) => join(import.meta.dir, name);
const run = (args: string[], log: string, limitMs?: number) =>
    children.run([script(args[0] as string), ...args.slice(1)], log, limitMs);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
        await children.stopAll(signal);
        process.exit(signal === "SIGINT" ? 130 : SIGTERM_EXIT);
    });
}

const limit = Math.round(prereg.liveness_bounds.tier_wall_budget_ms * 1.25);
const started = Date.now();
const results = await Promise.all(
    plan.map(async (job) => {
        mkdirSync(job.dir, { recursive: true });
        if (!existsSync(join(job.dir, "scenario.json"))) {
            writeFileSync(
                join(job.dir, "scenario.json"),
                `${JSON.stringify(scenarios.get(job.seed))}\n`,
            );
        }
        const log = join(job.dir, "tier.log");
        const args = ["run-tier.ts", "--tier", tier, "--seed", String(job.seed), "--out", job.dir];
        const code = await run(
            [
                ...args,
                "--host",
                job.host,
                "--arms",
                job.arms.join(","),
                "--events",
                String(job.events),
            ],
            log,
            limit,
        );
        const ran = existsSync(join(job.dir, "manifest.json"));
        const graded = ran ? await run(["grade-run.ts", job.dir], log) : null;
        const aa =
            graded === 0 && job.arms.some((a) => a.includes("~"))
                ? await run(["aa-report.ts", job.dir], log)
                : null;
        return {
            ...job,
            run_exit: code,
            grade_exit: graded,
            aa_exit: aa,
            wall_ms: Date.now() - started,
        };
    }),
);
writeFileSync(
    join(out, "tier-result.json"),
    `${JSON.stringify({ tier, limit_ms: limit, results }, null, 2)}\n`,
);
const reported = results.filter((r) => existsSync(join(r.dir, "manifest.json"))).map((r) => r.dir);
const report = reported.length
    ? await run(["report.ts", ...reported, "--out", out], join(out, "report.log"))
    : null;
console.log(
    JSON.stringify({
        results: results.map((r) => [r.dir, r.run_exit, r.grade_exit, r.wall_ms]),
        report,
        unreported: plan.map((j) => j.dir).filter((d) => !reported.includes(d)),
    }),
);
const failed = results.some(
    (r) => r.run_exit !== 0 || r.grade_exit !== 0 || (r.aa_exit ?? 0) !== 0,
);
process.exit(failed || report !== 0 ? 1 : 0);
