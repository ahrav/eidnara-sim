import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { runTier } from "../src/run/run";
import type { FaultEpisode } from "../src/scenario/faults";

const USAGE = `usage: --tier S --seed 101 --out <run dir> [--host pi|opencode] [--arms a,b]
    [--events N] [--faults <episodes.json>] [--context-limit N] [--models a,b]
    [--tapes <tape.jsonl>,...]`;
const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
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
const tier = arg("tier") as Tier;
const seed = Number(arg("seed"));
const out = arg("out");
const host = arg("host") ?? "pi";
if (!TIERS.includes(tier) || !Number.isInteger(seed) || !out)
    fail("missing --tier, --seed, or --out");
if (host !== "pi" && host !== "opencode") fail("--host must be pi or opencode");
const faults = arg("faults");
await runTier({
    config: loadConfig(),
    tier,
    seed,
    host,
    out: resolve(out),
    arms: arg("arms")?.split(","),
    events: count("events"),
    faults: faults ? (JSON.parse(readFileSync(faults, "utf8")) as FaultEpisode[]) : undefined,
    contextLimit: count("context-limit"),
    models: arg("models")?.split(","),
    tapes: arg("tapes")
        ?.split(",")
        .map((p) => resolve(p)),
});
