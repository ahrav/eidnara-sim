import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { Children, SIGTERM_EXIT } from "../src/run/children";
import { releaseLease, takeLease } from "../src/run/journal";
import { loadScenario, writeAtomic } from "../src/run/run";
import { planConflicts, runSpan, tierPlan } from "../src/run/tier";
import { buildFaketime } from "../src/run/timeinject";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--plan-only]";
const fail = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    process.exit(2);
};
const FLAGS: Record<string, boolean> = {
    tier: true,
    out: true,
    hosts: true,
    "turn-ms": true,
    "plan-only": false,
};
const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const name = token.startsWith("--") ? token.slice(2) : "";
    const takesValue = FLAGS[name];
    if (takesValue === undefined) fail(`unknown argument ${token}`);
    if (flags.has(name)) fail(`${token} given twice`);
    const value = takesValue ? argv[++i] : "";
    if (value === undefined || value.startsWith("--")) fail(`${token} needs a value`);
    flags.set(name, value as string);
}
const arg = (name: string) => flags.get(name);
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
if (!Number.isInteger(turnMs) || turnMs <= 0) fail("--turn-ms must be a positive integer");
if (new Set(hosts).size !== hosts.length || !hosts.every((h) => prereg.hosts.includes(h)))
    fail(`--hosts must name distinct hosts from ${prereg.hosts.join(",")}`);
mkdirSync(out, { recursive: true });
// One invocation per output directory: a second would resume runs the first still drives and
// grade their directories while they change.
try {
    takeLease(out);
} catch (caught) {
    fail(String((caught as Error).message));
}
const exit = (code: number): never => {
    releaseLease(out);
    process.exit(code);
};

const scenarios = new Map<number, Scenario>();
for (const seed of prereg.seeds) {
    const dir = join(out, `scenarios-${seed}`);
    mkdirSync(dir, { recursive: true });
    scenarios.set(seed, await loadScenario({ config, tier, seed, out: dir }));
}
const plan = tierPlan(prereg, scenarios, hosts, out, turnMs);
const conflicts = planConflicts(plan);
if (conflicts.length > 0) {
    console.error(
        `${conflicts.join("\n")}\n--turn-ms must keep the prefix of a run that has a manifest`,
    );
    exit(2);
}
writeFileSync(
    join(out, "tier-plan.json"),
    `${JSON.stringify({ tier, turn_ms: turnMs, plan }, null, 2)}\n`,
);
console.log(JSON.stringify(plan.map((j) => [j.dir, j.events, j.user_turns, j.arms.join(",")])));
const empty = plan.filter((j) => j.events === 0).map((j) => j.dir);
if (empty.length > 0) {
    console.error(`no session fits the wall budget for ${empty.join(", ")}\n${USAGE}`);
    exit(2);
}
if (flags.has("plan-only")) exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const children = new Children(env);
const script = (name: string) => join(import.meta.dir, name);
const run = (args: string[], log: string, limitMs?: number) =>
    children.run([script(args[0] as string), ...args.slice(1)], log, limitMs);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
        await children.stopAll(signal);
        exit(signal === "SIGINT" ? 130 : SIGTERM_EXIT);
    });
}

// Every run's preflight wants the vendored libfaketime; one build here keeps the parallel runs
// from each extracting and compiling into the same directory.
await buildFaketime();
const budget = prereg.liveness_bounds.tier_wall_budget_ms;
const limit = Math.round(budget * 1.25);
const started = Date.now();
// A job that throws in orchestration stops the sibling runs before the command exits, so no
// run outlives the lease on this directory.
const supervised = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (caught) {
        console.error(caught);
        await children.stopAll("SIGTERM");
        return exit(1);
    }
};
const results = await supervised(() =>
    Promise.all(
        plan.map(async (job) => {
            mkdirSync(job.dir, { recursive: true });
            // A resumed run keeps the budget it started with: its wall time counts from its
            // journaled StartRun, and the child gets what remains of the limit. A run that
            // journaled EndRun is complete and is left as it finished.
            const span = runSpan(job.dir, started);
            const runStarted = span.started;
            if (!existsSync(join(job.dir, "scenario.json"))) {
                writeAtomic(
                    join(job.dir, "scenario.json"),
                    `${JSON.stringify(scenarios.get(job.seed))}\n`,
                );
            }
            const log = join(job.dir, "tier.log");
            const args = [
                "run-tier.ts",
                "--tier",
                tier,
                "--seed",
                String(job.seed),
                "--out",
                job.dir,
            ];
            const code =
                span.ended !== undefined
                    ? 0
                    : await run(
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
                          Math.max(1, limit - (started - runStarted)),
                      );
            const run_wall_ms = (span.ended ?? Date.now()) - runStarted;
            const ran = existsSync(join(job.dir, "manifest.json"));
            const graded = ran ? await run(["grade-run.ts", job.dir], log, limit) : null;
            const aa =
                graded === 0 && job.arms.some((a) => a.includes("~"))
                    ? await run(["aa-report.ts", job.dir], log, limit)
                    : null;
            return {
                ...job,
                run_exit: code,
                run_wall_ms,
                over_budget: run_wall_ms > budget,
                grade_exit: graded,
                aa_exit: aa,
                wall_ms: Date.now() - started,
            };
        }),
    ),
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
        results: results.map((r) => [r.dir, r.run_exit, r.over_budget, r.grade_exit, r.wall_ms]),
        report,
        unreported: plan.map((j) => j.dir).filter((d) => !reported.includes(d)),
    }),
);
const failed = results.some(
    (r) => r.run_exit !== 0 || r.over_budget || r.grade_exit !== 0 || (r.aa_exit ?? 0) !== 0,
);
exit(failed || report !== 0 ? 1 : 0);
