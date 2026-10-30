import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { MAX_TIMER_MS, runTier } from "../src/run/run";

const USAGE = `usage: --tier S --seed 101 --out <run dir> [--host pi|opencode] [--arms a,b]
    [--events N] [--faults <episodes.json>] [--context-limit N] [--models a,b]
    [--tapes <tape.jsonl>,...] [--side-model <id>] [--user-sim-model <id>] [--turns-await-jobs true|false]
    [--qualification Q] [--wall-budget-ms N] [--sim-upgrade <commit>]`;
const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = process.argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
    return value;
};
const count = (name: string) => {
    const raw = arg(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive integer`);
    return n;
};
function fail(message: string): never {
    console.error(`${message}\n${USAGE}`);
    process.exit(2);
}
const KNOWN = [
    "tier",
    "seed",
    "out",
    "host",
    "arms",
    "events",
    "faults",
    "context-limit",
    "models",
    "tapes",
    "side-model",
    "user-sim-model",
    "turns-await-jobs",
    "qualification",
    "wall-budget-ms",
    "sim-upgrade",
];
const unknown = process.argv
    .slice(2)
    .filter((a, i, all) => a.startsWith("--") || !all[i - 1]?.startsWith("--"))
    .filter((a) => !a.startsWith("--") || !KNOWN.includes(a.slice(2)));
if (unknown.length > 0) fail(`unknown arguments: ${unknown.join(" ")}`);
const tier = arg("tier") as Tier;
const seed = Number(arg("seed"));
const out = arg("out");
const host = arg("host") ?? "pi";
if (!TIERS.includes(tier) || !Number.isInteger(seed) || !out)
    fail("missing --tier, --seed, or --out");
if (host !== "pi" && host !== "opencode") fail("--host must be pi or opencode");
const awaitJobs = (value: string | undefined): boolean | undefined => {
    if (value === undefined) return undefined;
    if (value !== "true" && value !== "false") fail("--turns-await-jobs takes true or false");
    return value === "true";
};
const faults = arg("faults");
const parseFaults = (path: string): unknown => {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (caught) {
        return fail(`--faults ${path}: ${(caught as Error).message}`);
    }
};
const wallBudgetMs = count("wall-budget-ms");
if (wallBudgetMs !== undefined && wallBudgetMs > MAX_TIMER_MS) {
    fail(`--wall-budget-ms must be at most ${MAX_TIMER_MS}`);
}
await runTier({
    config: loadConfig(),
    tier,
    seed,
    host,
    out: resolve(out),
    arms: arg("arms")?.split(","),
    events: count("events"),
    faults: faults ? parseFaults(faults) : undefined,
    contextLimit: count("context-limit"),
    models: arg("models")?.split(","),
    tapes: arg("tapes")
        ?.split(",")
        .map((p) => resolve(p)),
    sideModel: arg("side-model"),
    userSimModel: arg("user-sim-model"),
    turnsAwaitJobs: awaitJobs(arg("turns-await-jobs")),
    qualification: arg("qualification"),
    wallBudgetMs,
    simUpgrade: arg("sim-upgrade"),
});
// runTier resolves once the journal is sealed and every teardown step has run. A Pi launcher
// that the runtime never reaped can still hold the event loop open, so the command exits here.
process.exit(0);
