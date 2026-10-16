import { randomBytes } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../src/config/config";
import { canonicalJson } from "../src/prereg/canonical";
import { TIERS, type Tier } from "../src/prereg/schema";
import { compileScenario } from "../src/scenario/compile";
import { loadCompileInput, loadPrereg } from "../src/scenario/inputs";
import { bedrockEmbedder, hashEmbedder } from "../src/scenario/similarity";

const FLAGS = ["tier", "seed", "embedder", "out"];
const usage = (why: string) => {
    console.error(`${why}\nusage: --tier S|M|L|XL --seed <int> [--embedder local] [--out path]`);
    process.exit(2);
};
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const name = (argv[i] ?? "").replace(/^--/, "");
    const value = argv[i + 1];
    if (!FLAGS.includes(name) || argv[i] === name) usage(`unknown argument ${argv[i]}`);
    if (args.has(name)) usage(`--${name} given twice`);
    if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
    args.set(name, value as string);
}
const [tier, seedArg, embedderArg, outArg] = FLAGS.map((f) => args.get(f));
const seed = Number(seedArg);
if (!TIERS.includes(tier as Tier)) usage(`--tier must be one of ${TIERS.join(", ")}`);
if (!/^\d+$/.test(seedArg ?? "")) usage("--seed must be a non-negative integer");
if (![undefined, "local"].includes(embedderArg)) usage("--embedder accepts only local");
const out = outArg ?? join(import.meta.dir, "..", "runs", "scenarios", `${tier}-${seed}.json`);
const config = loadConfig();
const kind = (path: string) => {
    try {
        return lstatSync(path).isSymbolicLink() ? "link" : "real";
    } catch {
        return "missing";
    }
};
const canonical = (path: string): string => {
    let existing = resolve(path);
    while (kind(existing) === "missing") existing = dirname(existing);
    const rest = relative(existing, resolve(path));
    if (kind(existing) === "link") {
        return join(canonical(resolve(dirname(existing), readlinkSync(existing))), rest);
    }
    return join(realpathSync(existing), rest);
};
const checkout = canonical(config.eidnara_checkout);
const cache = join(dirname(out), "embeddings.jsonl");
for (const path of [out, cache]) {
    if (`${canonical(path)}${sep}`.startsWith(`${checkout}${sep}`)) {
        console.error(`${path} resolves inside eidnara_checkout ${config.eidnara_checkout}`);
        process.exit(2);
    }
}
if (canonical(out) === canonical(cache)) {
    console.error(`--out ${out} is the embedding cache path; choose another file name`);
    process.exit(2);
}
if (kind(cache) !== "missing" && statSync(cache).nlink > 1) {
    console.error(
        `${cache} is a hard link shared with another path; the cache must be its own file`,
    );
    process.exit(2);
}
const local = embedderArg === "local";
const registered = loadPrereg(tier as Tier).seeds;
if (!local && !registered.includes(seed)) {
    console.error(
        `seed ${seed} is not among tier ${tier}'s registered seeds ${registered.join(", ")}`,
    );
    process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const { aws_profile, region } = config.bedrock;
const embedder = local ? hashEmbedder : bedrockEmbedder(aws_profile, region, cache);
const scenario = await compileScenario(loadCompileInput(seed, tier as Tier, embedder, local));
const partial = `${out}.${randomBytes(6).toString("hex")}.tmp`;
try {
    writeFileSync(partial, `${canonicalJson(scenario)}\n`, { flag: "wx" });
    renameSync(partial, out);
} finally {
    rmSync(partial, { force: true });
}
console.log(`${out} ${scenario.scenario_hash}`);
