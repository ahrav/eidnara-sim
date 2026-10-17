import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { tierInput } from "../src/report/observe";
import { aaScale, loadGraded } from "../src/report/tier";
import { Children, SIGTERM_EXIT } from "../src/run/children";
import { releaseLease, takeLease } from "../src/run/journal";
import { gradedMainRuns, resizeFromM } from "../src/run/resize";
import { loadScenario } from "../src/run/run";
import {
    compressFaults,
    planConflicts,
    profileJobs,
    runSpan,
    type TierJob,
    tierPlan,
} from "../src/run/tier";
import { buildFaketime } from "../src/run/timeinject";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--resize-from <M tier dir>] [--plan-only]";
const fail = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    process.exit(2);
};
const FLAGS: Record<string, boolean> = {
    tier: true,
    out: true,
    hosts: true,
    "turn-ms": true,
    "resize-from": true,
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
const refuse = (why: string): never => {
    console.error(`${why}\n${USAGE}`);
    return exit(2);
};

const resizing = join(out, `${tier}-resizing.json`);
const from = arg("resize-from");
if (prereg.resizing && from && !existsSync(resizing)) {
    const m = loadPrereg(prereg.resizing.source_tier);
    for (const name of ["tier-plan.json", "tier-result.json"]) {
        if (!existsSync(join(resolve(from), name)))
            refuse(`${from} holds no ${name}; the ${m.tier} tier has not finished`);
    }
    const { main, ungraded } = (() => {
        try {
            return gradedMainRuns(resolve(from), m);
        } catch (caught) {
            return refuse(String((caught as Error).message));
        }
    })();
    if (main.length === 0 || ungraded.length > 0)
        refuse(`the ${m.tier} paired runs are not all graded: ${ungraded.join(", ") || "none"}`);
    const runs = main.map((d) => loadGraded(d, m));
    const sized = {
        recorded_at: new Date().toISOString(),
        runs: main,
        cusum_sd: aaScale(m, runs) ?? null,
        ...resizeFromM(prereg, tierInput(m, runs)),
    };
    writeFileSync(resizing, `${JSON.stringify(sized, null, 2)}\n`);
}
if (prereg.resizing && !existsSync(resizing))
    refuse(`${tier} starts only after ${resizing} records the resizing; pass --resize-from`);
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
const conflicts = planConflicts(plan);
if (conflicts.length > 0) {
    console.error(
        `${conflicts.join("\n")}\n--turn-ms must keep the prefix of a run that has a manifest`,
    );
    exit(2);
}
writeFileSync(
    priorPlan,
    `${JSON.stringify({ tier, turn_ms: turnMs, items_per_type: items ?? null, plan }, null, 2)}\n`,
);
console.log(
    JSON.stringify(plan.map((j) => [j.group, j.dir, j.events, j.user_turns, j.arms.join(",")])),
);
const empty = plan.filter((j) => j.events === 0).map((j) => j.dir);
if (empty.length > 0) {
    console.error(`no session fits the wall budget for ${empty.join(", ")}\n${USAGE}`);
    exit(2);
}
if (flags.has("plan-only")) exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const children = new Children(env);
const run = (args: string[], log: string, limitMs?: number) =>
    children.run([join(import.meta.dir, args[0] as string), ...args.slice(1)], log, limitMs);
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
const runJob = async (job: TierJob) => {
    mkdirSync(job.dir, { recursive: true });
    // A resumed run keeps the budget it started with: its wall time counts from its
    // journaled StartRun, and the child gets what remains of the limit. A run that
    // journaled EndRun is complete and is left as it finished.
    const launched = Date.now();
    const span = runSpan(job.dir, launched);
    const scenario = scenarios.get(job.seed) as Scenario;
    if (!existsSync(join(job.dir, "scenario.json")))
        writeFileSync(join(job.dir, "scenario.json"), `${JSON.stringify(scenario)}\n`);
    const log = join(job.dir, "tier.log");
    const faults = compressFaults(scenario, job.events);
    const moved = JSON.stringify(faults) !== JSON.stringify(scenario.faults);
    if (moved) writeFileSync(join(job.dir, "faults.json"), `${JSON.stringify(faults)}\n`);
    const code =
        span.ended !== undefined
            ? 0
            : await run(
                  [
                      "run-tier.ts",
                      ...["--tier", tier, "--seed", String(job.seed), "--out", job.dir],
                      ...["--host", job.host, "--arms", job.arms.join(",")],
                      ...["--events", String(job.events), ...job.extra],
                      ...(moved ? ["--faults", join(job.dir, "faults.json")] : []),
                  ],
                  log,
                  Math.max(1, limit - (launched - span.started)),
              );
    const run_wall_ms = (span.ended ?? Date.now()) - span.started;
    const start_ms = existsSync(join(job.dir, "journal.jsonl"))
        ? runSpan(job.dir, launched).started
        : null;
    return {
        ...job,
        log,
        start_ms,
        run_exit: code,
        run_wall_ms,
        over_budget: run_wall_ms > budget,
    };
};
const gradeJob = async (ran: Awaited<ReturnType<typeof runJob>>) => {
    const { log, ...job } = ran;
    const graded = existsSync(join(job.dir, "manifest.json"))
        ? await run(["grade-run.ts", job.dir], log, limit)
        : null;
    const aa =
        graded === 0 && job.arms.some((a) => a.includes("~"))
            ? await run(["aa-report.ts", job.dir], log, limit)
            : null;
    return { ...job, grade_exit: graded, aa_exit: aa, wall_ms: Date.now() - started };
};
const groups = [...new Set(plan.map((j) => j.group))];
type Result = Omit<Awaited<ReturnType<typeof gradeJob>>, "run_exit"> & {
    run_exit: number | null;
    skipped?: string;
};
const results: Result[] = [];
const tapeSource = (job: TierJob) => {
    const at = job.extra.indexOf("--tapes");
    return at < 0 ? null : dirname(job.extra[at + 1] as string);
};
const sourceFailed = (job: TierJob) => {
    const source = tapeSource(job);
    if (source === null) return null;
    const r = results.find((x) => x.dir === source);
    return r && r.run_exit === 0 && !r.over_budget ? null : `source run ${source} did not complete`;
};
const skipped = (job: TierJob, why: string): Result => ({
    ...job,
    start_ms: null,
    run_exit: null,
    run_wall_ms: 0,
    over_budget: false,
    grade_exit: null,
    aa_exit: null,
    wall_ms: Date.now() - started,
    skipped: why,
});
for (const group of groups) {
    const jobs = plan.filter((j) => j.group === group);
    if (group === "concurrent") {
        // Concurrent runs start together; a partly run group restarts only from removed directories.
        const begun = jobs.filter((j) => existsSync(join(j.dir, "journal.jsonl")));
        if (begun.length > 0 && jobs.some((j) => runSpan(j.dir, started).ended === undefined)) {
            await children.stopAll("SIGTERM");
            refuse(
                `the concurrent group is partly run (${begun.map((j) => j.dir).join(", ")}); remove its run directories to start it together`,
            );
        }
    }
    const held = jobs.map((j) => [j, sourceFailed(j)] as const);
    results.push(...held.flatMap(([j, why]) => (why ? [skipped(j, why)] : [])));
    const ran = await supervised(() =>
        Promise.all(held.filter(([, why]) => why === null).map(([j]) => runJob(j))),
    );
    results.push(...(await supervised(() => Promise.all(ran.map(gradeJob)))));
}
const skew = (group: string) => {
    const starts = results
        .filter((r) => r.group === group && r.start_ms !== null)
        .map((r) => r.start_ms as number);
    return starts.length ? Math.max(...starts) - Math.min(...starts) : null;
};
const reports: Record<string, number | null> = {};
const reported: string[] = [];
for (const group of groups) {
    const dirs = results
        .filter((r) => r.group === group && existsSync(join(r.dir, "manifest.json")))
        .map((r) => r.dir);
    const identities = new Set(
        results.filter((r) => dirs.includes(r.dir)).map((r) => `${r.host}/${r.seed}`),
    );
    const paired = identities.size === dirs.length;
    if (paired) reported.push(...dirs);
    const target = group === "main" ? out : join(out, group);
    reports[group] =
        dirs.length && paired
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
        results: results.map((r) => [
            r.group,
            r.dir,
            r.run_exit,
            r.over_budget,
            r.grade_exit,
            r.wall_ms,
        ]),
        reports,
        unreported: plan.map((j) => j.dir).filter((d) => !reported.includes(d)),
    }),
);
const failed = results.some(
    (r) => r.run_exit !== 0 || r.over_budget || r.grade_exit !== 0 || (r.aa_exit ?? 0) !== 0,
);
exit(failed || Object.values(reports).some((r) => r !== null && r !== 0) ? 1 : 0);
