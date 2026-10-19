import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { tierInput } from "../src/report/observe";
import { loadGraded } from "../src/report/tier";
import { writeAtomic } from "../src/run/atomic";
import { Children, SIGTERM_EXIT } from "../src/run/children";
import { leaseHeld, releaseLease, takeLease } from "../src/run/journal";
import { resizeFromM } from "../src/run/resize";
import { loadScenario } from "../src/run/run";
import {
    compressFaults,
    planConflicts,
    profileJobs,
    runSpan,
    type TierJob,
    tierPlan,
} from "../src/run/tier";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--resize-from <M tier dir>] [--restart-at <fraction>] [--plan-only]";
const fail = (why: string): never => {
    console.error(`${why}\n${USAGE}`);
    process.exit(2);
};
const FLAGS: Record<string, boolean> = {
    tier: true,
    out: true,
    hosts: true,
    "turn-ms": true,
    "resize-from": true,
    "restart-at": true,
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
const priorTurnMs = (): unknown => {
    if (!existsSync(priorPlan)) return 75_000;
    try {
        return JSON.parse(readFileSync(priorPlan, "utf8")).turn_ms;
    } catch {
        return fail(`${priorPlan} is unreadable; pass --turn-ms to replace it`);
    }
};
const turnMs = Number(arg("turn-ms") ?? priorTurnMs());
if (!Number.isInteger(turnMs) || turnMs <= 0) fail("--turn-ms must be a positive integer");
const restartAt = Number(arg("restart-at") ?? (tier === "XL" ? 0.4 : 0));
if (!(restartAt >= 0 && restartAt < 1)) fail("--restart-at must be a fraction in [0, 1)");
if (new Set(hosts).size !== hosts.length || !hosts.every((h) => prereg.hosts.includes(h)))
    fail(`--hosts must name distinct hosts from ${prereg.hosts.join(",")}`);
// The tier never writes under the Eidnara checkout (AGENTS.md); the check precedes the first
// directory it would create.
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
// Symlinks resolve too: the deepest existing ancestor of each path gives its real location.
const real = (path: string): string => {
    let existing = path;
    const rest: string[] = [];
    while (!existsSync(existing)) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    return join(realpathSync(existing), ...rest);
};
if (inside(real(out), real(resolve(config.eidnara_checkout))))
    fail(`--out ${out} is inside the Eidnara checkout ${config.eidnara_checkout}`);
mkdirSync(out, { recursive: true });
// One invocation per output directory: a second would resume runs the first still drives and
// grade their directories while they change.
let lease: ReturnType<typeof takeLease>;
try {
    lease = takeLease(out);
} catch (caught) {
    fail(String((caught as Error).message));
}
const exit = (code: number): never => {
    releaseLease(out, lease);
    process.exit(code);
};
const refuse = (why: string): never => {
    console.error(`${why}\n${USAGE}`);
    return exit(2);
};
// Setup after the lease (scenario compilation, the plan, the faketime build) runs at top level;
// a thrown error there releases the lease on the way out, so a retry from another host is not
// held off by a dead invocation.
process.on("uncaughtException", (caught) => {
    console.error(caught);
    exit(1);
});
process.on("unhandledRejection", (caught) => {
    console.error(caught);
    exit(1);
});
// A signal during setup releases the lease too; once the runs start, the handlers below stop
// the children first.
let stopChildren: ((signal: NodeJS.Signals) => Promise<void>) | null = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
        await stopChildren?.(signal);
        exit(signal === "SIGINT" ? 130 : SIGTERM_EXIT);
    });
}

// A generated directory the command writes into is its own: an existing symlink there is
// refused rather than followed.
const ownDir = (dir: string) => {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
        refuse(`${dir} is a symlink; the tier writes only into directories of its own`);
    mkdirSync(dir, { recursive: true });
};

const resizing = join(out, `${tier}-resizing.json`);
const from = arg("resize-from");
if (prereg.resizing && from && !existsSync(resizing)) {
    const m = loadPrereg(prereg.resizing.source_tier);
    const mPlan = join(resolve(from), "tier-plan.json");
    if (!existsSync(mPlan)) refuse(`${from} holds no tier-plan.json`);
    const main = (JSON.parse(readFileSync(mPlan, "utf8")).plan as TierJob[])
        .filter((j) => j.group === "main")
        .map((j) => j.dir);
    const ungraded = main.filter((d) => !existsSync(join(d, "grades.jsonl")));
    if (main.length === 0 || ungraded.length > 0)
        refuse(`the ${m.tier} paired runs are not all graded: ${ungraded.join(", ") || "none"}`);
    const runs = main.map((d) => loadGraded(d, m));
    const sized = {
        recorded_at: new Date().toISOString(),
        runs: main,
        ...resizeFromM(prereg, tierInput(m, runs)),
    };
    writeAtomic(resizing, `${JSON.stringify(sized, null, 2)}\n`);
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
    ownDir(dir);
    scenarios.set(seed, await loadScenario({ config, tier, seed, out: dir }, items));
}
const plan: TierJob[] = [
    ...tierPlan(prereg, scenarios, hosts, out, turnMs),
    ...profileJobs(prereg, scenarios, hosts, out, turnMs),
];
const main = plan.filter((j) => j.group === "main");
const repeats = prereg.aa_controls?.repeats ?? 0;
if (main.length < repeats) {
    refuse(
        `${repeats} A/A repeats are registered, and these hosts and seeds plan ${main.length} runs`,
    );
}
const conflicts = planConflicts(plan);
if (conflicts.length > 0) {
    refuse(`${conflicts.join("\n")}\n--turn-ms must keep the prefix of a run that has a manifest`);
}
writeAtomic(
    priorPlan,
    `${JSON.stringify({ tier, turn_ms: turnMs, items_per_type: items ?? null, plan }, null, 2)}\n`,
);
console.log(
    JSON.stringify(plan.map((j) => [j.group, j.dir, j.events, j.user_turns, j.arms.join(",")])),
);
const empty = plan.filter((j) => j.events === 0).map((j) => j.dir);
if (empty.length > 0) refuse(`no session fits the wall budget for ${empty.join(", ")}`);
if (flags.has("plan-only")) exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const children = new Children(env);
const run = (args: string[], log: string, limitMs?: number, stopWhen?: () => boolean) =>
    children.run(
        [join(import.meta.dir, args[0] as string), ...args.slice(1)],
        log,
        limitMs,
        stopWhen,
    );
stopChildren = (signal) => children.stopAll(signal);

// Every run's preflight wants the vendored libfaketime; one supervised build here keeps the
// parallel runs from each compiling it, and a signal to the command ends the build with them.
const built = await run(["build-faketime.ts"], join(out, "faketime.log"), 1_800_000);
if (built !== 0) {
    console.error(`libfaketime build exited ${built}; see ${join(out, "faketime.log")}`);
    exit(1);
}
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
const eventsRun = (dir: string) => {
    const path = join(dir, "journal.jsonl");
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.includes('"kind":"Event"')).length;
};
const runJob = async (job: TierJob) => {
    const held = leaseHeld(job.dir);
    const span = runSpan(job.dir, started);
    const scenario = scenarios.get(job.seed) as Scenario;
    if (!held && !existsSync(join(job.dir, "scenario.json")))
        writeAtomic(join(job.dir, "scenario.json"), `${JSON.stringify(scenario)}\n`);
    const log = join(job.dir, "tier.log");
    const faults = compressFaults(scenario, job.events);
    const moved = JSON.stringify(faults) !== JSON.stringify(scenario.faults);
    if (!held && moved) writeAtomic(join(job.dir, "faults.json"), `${JSON.stringify(faults)}\n`);
    const args = [
        "run-tier.ts",
        ...["--tier", tier, "--seed", String(job.seed), "--out", job.dir, "--host", job.host],
        ...["--arms", job.arms.join(","), "--events", String(job.events), ...job.extra],
        ...(moved ? ["--faults", join(job.dir, "faults.json")] : []),
    ];
    const marker = join(job.dir, "restarted");
    const due = restartAt * job.events * job.arms.length;
    const cut = restartAt > 0 && job.group === "main" && !existsSync(marker);
    const remaining = () => Math.max(1, limit - (Date.now() - span.started));
    let code: number;
    if (held) code = SIGTERM_EXIT;
    else if (span.ended !== undefined) code = 0;
    else {
        code = await run(args, log, remaining(), cut ? () => eventsRun(job.dir) >= due : undefined);
        if (cut && code === SIGTERM_EXIT && eventsRun(job.dir) >= due && remaining() > 1) {
            writeAtomic(marker, `${new Date().toISOString()}\n`);
            code = await run(args, log, remaining());
        }
    }
    const restarted = existsSync(marker);
    const after = runSpan(job.dir, started);
    const run_wall_ms = (after.ended ?? Date.now()) - after.started;
    const heldNow = held || leaseHeld(job.dir);
    const ran = existsSync(join(job.dir, "manifest.json")) && !heldNow;
    const graded = ran ? await run(["grade-run.ts", job.dir], log, limit) : null;
    const aa =
        graded === 0 && job.arms.some((a) => a.includes("~"))
            ? await run(["aa-report.ts", job.dir], log, limit)
            : null;
    return {
        ...job,
        start_ms: after.started,
        restarted,
        run_exit: code,
        leased_elsewhere: heldNow,
        run_wall_ms,
        over_budget: run_wall_ms > budget,
        grade_exit: graded,
        aa_exit: aa,
        wall_ms: Date.now() - started,
    };
};
// Every run directory is checked before any run starts, so a refusal exits with nothing
// launched.
for (const job of plan) ownDir(job.dir);
const groups = [...new Set(plan.map((j) => j.group))];
const results: Awaited<ReturnType<typeof runJob>>[] = [];
for (const group of groups) {
    const jobs = plan.filter((j) => j.group === group);
    results.push(...(await supervised(() => Promise.all(jobs.map(runJob)))));
}
const skew = (group: string) => {
    const starts = results.filter((r) => r.group === group).map((r) => r.start_ms);
    return starts.length ? Math.max(...starts) - Math.min(...starts) : null;
};
const reports: Record<string, number | null> = {};
const reported = results
    .filter((r) => !r.leased_elsewhere && existsSync(join(r.dir, "manifest.json")))
    .map((r) => r.dir);
for (const group of groups) {
    const dirs = results.filter((r) => r.group === group && reported.includes(r.dir));
    const target = group === "main" ? out : join(out, group);
    reports[group] = dirs.length
        ? await run(
              ["report.ts", ...dirs.map((r) => r.dir), "--out", target],
              join(out, "report.log"),
              limit,
          )
        : null;
}
const start_skew_ms = Object.fromEntries(groups.map((g) => [g, skew(g)]));
writeAtomic(
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
const unrestarted = results
    .filter((r) => restartAt > 0 && r.group === "main" && !r.restarted)
    .map((r) => r.dir);
if (unrestarted.length > 0) console.error(`no harness restart in ${unrestarted.join(", ")}`);
const failed =
    unrestarted.length > 0 ||
    results.some(
        (r) =>
            r.run_exit !== 0 ||
            r.over_budget ||
            r.leased_elsewhere ||
            r.grade_exit !== 0 ||
            (r.aa_exit ?? 0) !== 0,
    );
exit(failed || Object.values(reports).some((r) => r !== 0) ? 1 : 0);
