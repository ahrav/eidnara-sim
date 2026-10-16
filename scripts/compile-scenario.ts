import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config/config";
import { canonicalJson } from "../src/prereg/canonical";
import { TIERS, type Tier } from "../src/prereg/schema";
import { compileScenario } from "../src/scenario/compile";
import { loadCompileInput } from "../src/scenario/inputs";
import { bedrockEmbedder, hashEmbedder } from "../src/scenario/similarity";

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};
const tier = arg("tier") as Tier;
const seed = Number(arg("seed"));
if (!TIERS.includes(tier) || !Number.isInteger(seed)) {
    console.error("usage: --tier S|M|L|XL --seed <int> [--embedder local] [--out path]");
    process.exit(2);
}
const out = arg("out") ?? join(import.meta.dir, "..", "runs", "scenarios", `${tier}-${seed}.json`);
mkdirSync(dirname(out), { recursive: true });
const config = loadConfig();
const local = arg("embedder") === "local";
const cache = join(dirname(out), "embeddings.jsonl");
const { aws_profile, region } = config.bedrock;
const embedder = local ? hashEmbedder : bedrockEmbedder(aws_profile, region, cache);
const scenario = await compileScenario(loadCompileInput(seed, tier, embedder, local));
writeFileSync(out, `${canonicalJson(scenario)}\n`);
console.log(`${out} ${scenario.scenario_hash}`);
