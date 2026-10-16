import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { tierInput } from "../src/report/observe";
import { loadGraded } from "../src/report/tier";
import { Children, SIGTERM_EXIT } from "../src/run/children";
import { resizeFromM } from "../src/run/resize";
import { loadScenario } from "../src/run/run";
import { compressFaults, profileJobs, type TierJob, tierPlan } from "../src/run/tier";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--resize-from <M tier dir>] [--plan-only]";
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

const resizing = join(out, `${tier}-resizing.json`);
const from = arg("resize-from");
if (prereg.resizing && from && !existsSync(resizing)) {
    const m = loadPrereg(prereg.resizing.source_tier);
    const mPlan = join(resolve(from), "tier-plan.json");
    if (!existsSync(mPlan)) fail(`${from} holds no tier-plan.json`);
    const main = (JSON.parse(readFileSync(mPlan, "utf8")).plan as TierJob[])
        .filter((j) => j.group === "main")
        .map((j) => j.dir);
    const ungraded = main.filter((d) => !existsSync(join(d, "grades.jsonl")));
    if (main.length === 0 || ungraded.length > 0)
        fail(`the ${m.tier} paired runs are not all graded: ${ungraded.join(", ") || "none"}`);
    const runs = main.map((d) => loadGraded(d, m));
    const sized = {
        recorded_at: new Date().toISOString(),
        runs: main,
        ...resizeFromM(prereg, tierInput(m, runs)),
    };
    writeFileSync(resizing, `${JSON.stringify(sized, null, 2)}\n`);
}
if (prereg.resizing && !existsSync(resizing))
    fail(`${tier} starts only after ${resizing} records the resizing; pass --resize-from`);
const items = prereg.resizing
    ? (JSON.parse(readFileSync(resizing, "utf8")) as { paired_items_per_probe_type: number })
          .paired_items_per_probe_type
    : undefined;

const scenarios = new Map<number, Scenario>();
for (const seed of prereg.seeds) {
    const dir = join(out, `scenarios-${seed}`);
    mkdirSync(dir, { recursive: true });
    scenarios.set(seed, await loadScenario({ config, tier, seed, out: dir }, items));
}
const plan: TierJob[] = [
    ...tierPlan(prereg, scenarios, hosts, out, turnMs),
    ...profileJobs(prereg, scenarios, hosts, out, turnMs),
];
writeFileSync(
    priorPlan,
    `${JSON.stringify({ tier, turn_ms: turnMs, items_per_type: items ?? null, plan }, null, 2)}\n`,
);
console.log(
    JSON.stringify(plan.map((j) => [j.group, j.dir, j.events, j.user_turns, j.arms.join(",")])),
);
const empty = plan.filter((j) => j.events === 0).map((j) => j.dir);
if (empty.length > 0) fail(`no session fits the wall budget for ${empty.join(", ")}`);
if (process.argv.includes("--plan-only")) process.exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const children = new Children(env);
const run = (args: string[], log: string, limitMs?: number) =>
    children.run([join(import.meta.dir, args[0] as string), ...args.slice(1)], log, limitMs);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
        await children.stopAll(signal);
        process.exit(signal === "SIGINT" ? 130 : SIGTERM_EXIT);
    });
}

const limit = Math.round(prereg.liveness_bounds.tier_wall_budget_ms * 1.25);
const started = Date.now();
const firstEntryMs = (dir: string) => {
    const path = join(dir, "journal.jsonl");
    if (!existsSync(path)) return null;
    return Number(JSON.parse(readFileSync(path, "utf8").split("\n")[0] || "{}").wall_ms ?? NaN);
};
const runJob = async (job: TierJob) => {
    mkdirSync(job.dir, { recursive: true });
    const scenario = scenarios.get(job.seed) as Scenario;
    if (!existsSync(join(job.dir, "scenario.json")))
        writeFileSync(join(job.dir, "scenario.json"), `${JSON.stringify(scenario)}\n`);
    const log = join(job.dir, "tier.log");
    const faults = compressFaults(scenario, job.events);
    const moved = JSON.stringify(faults) !== JSON.stringify(scenario.faults);
    if (moved) writeFileSync(join(job.dir, "faults.json"), `${JSON.stringify(faults)}\n`);
    const code = await run(
        [
            "run-tier.ts",
            ...["--tier", tier, "--seed", String(job.seed), "--out", job.dir, "--host", job.host],
            ...["--arms", job.arms.join(","), "--events", String(job.events), ...job.extra],
            ...(moved ? ["--faults", join(job.dir, "faults.json")] : []),
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
        start_ms: firstEntryMs(job.dir),
        run_exit: code,
        grade_exit: graded,
        aa_exit: aa,
        wall_ms: Date.now() - started,
    };
};
const groups = [...new Set(plan.map((j) => j.group))];
const results: Awaited<ReturnType<typeof runJob>>[] = [];
for (const group of groups) {
    results.push(...(await Promise.all(plan.filter((j) => j.group === group).map(runJob))));
}
const skew = (group: string) => {
    const starts = results
        .filter((r) => r.group === group && r.start_ms !== null)
        .map((r) => r.start_ms as number);
    return starts.length ? Math.max(...starts) - Math.min(...starts) : null;
};
const reports: Record<string, number | null> = {};
for (const group of groups) {
    const dirs = results
        .filter((r) => r.group === group && existsSync(join(r.dir, "manifest.json")))
        .map((r) => r.dir);
    const target = group === "main" ? out : join(out, group);
    reports[group] = dirs.length
        ? await run(["report.ts", ...dirs, "--out", target], join(out, "report.log"))
        : null;
}
const start_skew_ms = Object.fromEntries(groups.map((g) => [g, skew(g)]));
writeFileSync(
    join(out, "tier-result.json"),
    `${JSON.stringify({ tier, limit_ms: limit, start_skew_ms, reports, results }, null, 2)}\n`,
);
console.log(
    JSON.stringify({
        results: results.map((r) => [r.group, r.dir, r.run_exit, r.grade_exit, r.wall_ms]),
        reports,
    }),
);
const failed = results.some(
    (r) => r.run_exit !== 0 || r.grade_exit !== 0 || (r.aa_exit ?? 0) !== 0,
);
process.exit(failed || Object.values(reports).some((r) => r !== 0) ? 1 : 0);
