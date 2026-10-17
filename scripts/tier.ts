import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { tierInput } from "../src/report/observe";
import { aaScale, loadGraded } from "../src/report/tier";
import { Children, SIGTERM_EXIT, type StopReason } from "../src/run/children";
import { leaseHeld, releaseLease, takeLease } from "../src/run/journal";
import { gradedMainRuns, resizeFromM } from "../src/run/resize";
import { loadScenario, writeAtomic } from "../src/run/run";
import {
    compressFaults,
    planConflicts,
    profileJobs,
    restartConflicts,
    restartCut,
    restartFraction,
    runSpan,
    type TierJob,
    tierPlan,
    uncuttableRuns,
} from "../src/run/tier";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const USAGE =
    "usage: bun scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N] [--resize-from <M tier dir>] [--models a,b] [--restart-at <fraction>] [--plan-only]";
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
    models: true,
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
type PriorPlan = { tier?: Tier; turn_ms?: number; restart_at?: number; plan?: TierJob[] };
// The saved plan supplies turn_ms and restart_at. Explicit flags for both (restart_at only
// matters at XL) replace an unreadable plan; a plan from another tier is refused.
const prior = ((): PriorPlan | null => {
    if (!existsSync(priorPlan)) return null;
    const replaced =
        arg("turn-ms") !== undefined && (tier !== "XL" || arg("restart-at") !== undefined);
    let parsed: PriorPlan;
    try {
        parsed = JSON.parse(readFileSync(priorPlan, "utf8"));
    } catch {
        if (replaced) return null;
        return fail(
            `${priorPlan} is unreadable; pass --turn-ms${tier === "XL" ? " and --restart-at" : ""} to replace it`,
        );
    }
    if (parsed.tier !== undefined && parsed.tier !== tier) {
        return fail(`${priorPlan} belongs to tier ${parsed.tier}; use another --out for ${tier}`);
    }
    return parsed;
})();
const turnMs = Number(arg("turn-ms") ?? prior?.turn_ms ?? 75_000);
if (!Number.isInteger(turnMs) || turnMs <= 0) fail("--turn-ms must be a positive integer");
const restartAt = restartFraction(arg("restart-at"), prior, tier);
if (!(restartAt >= 0 && restartAt < 1)) fail("--restart-at must be a fraction in [0, 1)");
if (new Set(hosts).size !== hosts.length || !hosts.every((h) => prereg.hosts.includes(h)))
    fail(`--hosts must name distinct hosts from ${prereg.hosts.join(",")}`);
// The tier never writes under the Eidnara checkout (AGENTS.md); the check precedes the first
// directory it would create.
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
if (inside(out, resolve(config.eidnara_checkout)))
    fail(`--out ${out} is inside the Eidnara checkout ${config.eidnara_checkout}`);
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
interface ResizingRecord {
    source_dir: string;
    source_prereg_sha256: string;
    target_prereg_sha256: string;
    paired_items_per_probe_type: number;
}
const recorded = (): ResizingRecord | null =>
    existsSync(resizing) ? (JSON.parse(readFileSync(resizing, "utf8")) as ResizingRecord) : null;
if (prereg.resizing && from && !existsSync(resizing)) {
    const m = loadPrereg(prereg.resizing.source_tier);
    for (const name of ["tier-plan.json", "tier-result.json"]) {
        if (!existsSync(join(resolve(from), name)))
            refuse(`${from} holds no ${name}; the ${m.tier} tier has not finished`);
    }
    if (leaseHeld(resolve(from))) refuse(`${from} is leased; resize once that invocation finishes`);
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
    const input = tierInput(m, runs);
    const open = (input.incomplete ?? []).filter((x) => !x.startsWith("CUSUM "));
    if (open.length > 0) refuse(`the ${m.tier} campaign is incomplete: ${open.join("; ")}`);
    const sized = {
        recorded_at: new Date().toISOString(),
        campaign_dir: out,
        source_dir: resolve(from),
        source_prereg_sha256: preregistrationHash(m),
        target_prereg_sha256: preregistrationHash(prereg),
        runs: main,
        cusum_sd: aaScale(m, runs) ?? null,
        ...resizeFromM(prereg, input),
    };
    writeAtomic(resizing, `${JSON.stringify(sized, null, 2)}\n`);
}
const record = recorded();
if (prereg.resizing && !record)
    refuse(`${tier} starts only after ${resizing} records the resizing; pass --resize-from`);
if (prereg.resizing && record) {
    const m = loadPrereg(prereg.resizing.source_tier);
    if (record.target_prereg_sha256 !== preregistrationHash(prereg))
        refuse(
            `${resizing} was recorded under another ${tier} pre-registration; remove it to resize again`,
        );
    if (from && record.source_dir !== resolve(from))
        refuse(`${resizing} was recorded from ${record.source_dir}, not ${resolve(from)}`);
    if (from && record.source_prereg_sha256 !== preregistrationHash(m))
        refuse(`${resizing} was recorded under another ${m.tier} pre-registration`);
}
const items = record?.paired_items_per_probe_type;

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

const scenarios = new Map<number, Scenario>();
for (const seed of prereg.seeds) {
    const dir = join(out, `scenarios-${seed}`);
    mkdirSync(dir, { recursive: true });
    scenarios.set(seed, await loadScenario({ config, tier, seed, out: dir }, items));
}
const models = arg("models")
    ?.split(",")
    .map((m) => m.trim()) ?? [config.agent_model];
if (models.some((m) => m === "")) refuse("--models lists an empty model");
const switches = [...scenarios.values()].some((s) =>
    s.faults.some((f) => f.type === "model_switch"),
);
if (switches && new Set(models).size < 2)
    refuse(`the ${tier} scenarios schedule a model_switch; --models must list two distinct models`);
const paired = tierPlan(prereg, scenarios, hosts, out, turnMs);
const repeats = prereg.aa_controls?.repeats ?? 0;
if (paired.length < repeats)
    refuse(
        `${repeats} A/A repeats are registered, and these hosts and seeds plan ${paired.length} runs`,
    );
const plan: TierJob[] = [...paired, ...profileJobs(prereg, scenarios, hosts, out, turnMs)];
const modelConflicts = arg("models")
    ? plan.flatMap((job) => {
          const path = join(job.dir, "manifest.json");
          if (!existsSync(path)) return [];
          const ran = JSON.parse(readFileSync(path, "utf8")).models as string[];
          return JSON.stringify(ran) === JSON.stringify(models)
              ? []
              : [`${job.dir} ran on ${ran.join(",")}, --models says ${models.join(",")}`];
      })
    : [];
if (modelConflicts.length > 0) refuse(modelConflicts.join("\n"));
const conflicts = planConflicts(plan);
if (conflicts.length > 0) {
    console.error(
        `${conflicts.join("\n")}\n--turn-ms must keep the prefix of a run that has a manifest`,
    );
    exit(2);
}
const uncuttable = uncuttableRuns(plan, restartAt);
if (uncuttable.length > 0)
    refuse(`--restart-at ${restartAt} first stops at the last event of ${uncuttable.join(", ")}`);
// Begun runs of every host the saved plan listed, not only those this invocation's --hosts keeps.
const rethreshold = restartConflicts(
    [...plan, ...(prior?.plan ?? []).filter((j) => !plan.some((p) => p.dir === j.dir))],
    prior?.restart_at,
    restartAt,
);
if (rethreshold.length > 0)
    refuse(
        `${rethreshold.join("\n")}\n--restart-at must keep the fraction a begun run started under`,
    );
writeAtomic(
    priorPlan,
    `${JSON.stringify(
        {
            tier,
            turn_ms: turnMs,
            restart_at: restartAt,
            items_per_type: items ?? null,
            models,
            plan,
        },
        null,
        2,
    )}\n`,
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
const run = (
    args: string[],
    log: string,
    limitMs?: number,
    stopWhen?: () => boolean,
    onStop?: (reason: StopReason) => void,
) =>
    children.run(
        [join(import.meta.dir, args[0] as string), ...args.slice(1)],
        log,
        limitMs,
        stopWhen,
        onStop,
    );
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
        await children.stopAll(signal);
        exit(signal === "SIGINT" ? 130 : SIGTERM_EXIT);
    });
}

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
const eventsRun = (dir: string) => {
    const path = join(dir, "journal.jsonl");
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.includes('"kind":"Event"')).length;
};
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
    // A run another process still holds is left as it is: its scenario stays, it is
    // neither run nor graded here, and the command fails for it.
    const held = leaseHeld(job.dir);
    // A resumed run keeps the budget it started with: its wall time counts from its
    // journaled StartRun, and the child gets what remains of the limit. A run that
    // journaled EndRun is complete and is left as it finished.
    const launched = Date.now();
    const span = runSpan(job.dir, launched);
    const scenario = scenarios.get(job.seed) as Scenario;
    if (!held && !existsSync(join(job.dir, "scenario.json")))
        writeAtomic(join(job.dir, "scenario.json"), `${JSON.stringify(scenario)}\n`);
    const log = join(job.dir, "tier.log");
    const faults = compressFaults(scenario, job.events);
    const moved = JSON.stringify(faults) !== JSON.stringify(scenario.faults);
    if (moved) writeFileSync(join(job.dir, "faults.json"), `${JSON.stringify(faults)}\n`);
    const args = [
        "run-tier.ts",
        ...["--tier", tier, "--seed", String(job.seed), "--out", job.dir],
        ...["--host", job.host, "--arms", job.arms.join(",")],
        ...["--events", String(job.events), ...job.extra],
        ...(arg("models") ? ["--models", models.join(",")] : []),
        ...(moved ? ["--faults", join(job.dir, "faults.json")] : []),
    ];
    const marker = join(job.dir, "restarted");
    const due = job.group === "main" ? restartCut(restartAt, job.events, job.arms.length) : null;
    const cut = due !== null && !existsSync(marker) ? due : null;
    const remaining = () => Math.max(1, limit - (Date.now() - span.started));
    let requested = false;
    let code = held
        ? SIGTERM_EXIT
        : span.ended !== undefined
          ? 0
          : await run(
                args,
                log,
                remaining(),
                cut === null ? undefined : () => eventsRun(job.dir) >= cut,
                (reason) => {
                    requested = reason === "stopWhen";
                },
            );
    if (requested && code === SIGTERM_EXIT && remaining() > 1) {
        writeFileSync(marker, `${new Date().toISOString()}\n`);
        code = await run(args, log, remaining());
    }
    const restarted = existsSync(marker);
    const run_wall_ms = (span.ended ?? Date.now()) - span.started;
    const start_ms = existsSync(join(job.dir, "journal.jsonl"))
        ? runSpan(job.dir, launched).started
        : null;
    return {
        ...job,
        log,
        start_ms,
        restarted,
        run_exit: code,
        leased_elsewhere: held,
        run_wall_ms,
        over_budget: run_wall_ms > budget,
    };
};
const gradeJob = async (ran: Awaited<ReturnType<typeof runJob>>) => {
    const { log, ...job } = ran;
    const graded =
        existsSync(join(job.dir, "manifest.json")) && !job.leased_elsewhere
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
    restarted: false,
    run_exit: null,
    leased_elsewhere: false,
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
// A paired run that missed its scheduled restart leaves the main report unpublished: the
// campaign did not exercise the restart it pre-registered.
const unrestarted = results
    .filter(
        (r) =>
            restartAt > 0 &&
            r.group === "main" &&
            r.skipped === undefined &&
            !r.leased_elsewhere &&
            !r.restarted,
    )
    .map((r) => r.dir);
if (unrestarted.length > 0) console.error(`no harness restart in ${unrestarted.join(", ")}`);
const reports: Record<string, number | null> = {};
const reported: string[] = [];
for (const group of groups) {
    const dirs = results
        .filter(
            (r) =>
                r.group === group &&
                !r.leased_elsewhere &&
                existsSync(join(r.dir, "manifest.json")),
        )
        .map((r) => r.dir);
    const identities = new Set(
        results.filter((r) => dirs.includes(r.dir)).map((r) => `${r.host}/${r.seed}`),
    );
    const paired = identities.size === dirs.length;
    if (paired) reported.push(...dirs);
    const target = group === "main" ? out : join(out, group);
    const restartMissing = group === "main" && unrestarted.length > 0;
    reports[group] =
        dirs.length && paired && !restartMissing
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
exit(failed || Object.values(reports).some((r) => r !== null && r !== 0) ? 1 : 0);
