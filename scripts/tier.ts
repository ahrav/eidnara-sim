import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
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
const turnMs = Number(arg("turn-ms") ?? 75_000);
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
if (process.argv.includes("--plan-only")) process.exit(0);

const bin = resolve(dirname(config.opencode_binary), "../../.bin");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const run = (args: string[], log: string, limitMs?: number) =>
    new Promise<number>((done) => {
        const child = spawn("bun", args, { env, stdio: ["ignore", "pipe", "pipe"] });
        const sink = (chunk: Buffer) => writeFileSync(log, chunk, { flag: "a" });
        child.stdout.on("data", sink);
        child.stderr.on("data", sink);
        const timer = limitMs ? setTimeout(() => child.kill("SIGTERM"), limitMs) : null;
        child.on("exit", (code, signal) => {
            if (timer) clearTimeout(timer);
            done(code ?? (signal === "SIGTERM" ? 143 : 1));
        });
    });

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
        const args = [
            "scripts/run-tier.ts",
            "--tier",
            tier,
            "--seed",
            String(job.seed),
            "--out",
            job.dir,
        ];
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
        const graded = code === 0 ? await run(["scripts/grade-run.ts", job.dir], log) : null;
        const aa =
            graded === 0 && job.arms.some((a) => a.includes("~"))
                ? await run(["scripts/aa-report.ts", job.dir], log)
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
const report = await run(
    ["scripts/report.ts", ...plan.map((j) => j.dir), "--out", out],
    join(out, "report.log"),
);
console.log(
    JSON.stringify({
        results: results.map((r) => [r.dir, r.run_exit, r.grade_exit, r.wall_ms]),
        report,
    }),
);
