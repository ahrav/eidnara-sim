import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../src/config/config";
import { canonicalJson } from "../src/prereg/canonical";
import { TIERS, type Tier } from "../src/prereg/schema";
import { compileScenario } from "../src/scenario/compile";
import { loadCompileInput } from "../src/scenario/inputs";
import { bedrockEmbedder, hashEmbedder } from "../src/scenario/similarity";

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const value = process.argv[i + 1];
    if (i < 0) return undefined;
    return value === undefined || value.startsWith("--") ? "" : value;
};
const [tier, seedArg, embedderArg, outArg] = [
    arg("tier"),
    arg("seed"),
    arg("embedder"),
    arg("out"),
];
const seed = Number(seedArg);
if (
    !TIERS.includes(tier as Tier) ||
    !/^\d+$/.test(seedArg ?? "") ||
    ![undefined, "local"].includes(embedderArg) ||
    outArg === ""
) {
    console.error("usage: --tier S|M|L|XL --seed <int> [--embedder local] [--out path]");
    process.exit(2);
}
const out = outArg ?? join(import.meta.dir, "..", "runs", "scenarios", `${tier}-${seed}.json`);
const config = loadConfig();
const canonical = (path: string) => {
    let existing = resolve(path);
    while (!existsSync(existing)) existing = dirname(existing);
    return join(realpathSync(existing), relative(existing, resolve(path)));
};
const checkout = canonical(config.eidnara_checkout);
if (`${canonical(out)}${sep}`.startsWith(`${checkout}${sep}`)) {
    console.error(`--out ${out} is inside eidnara_checkout ${config.eidnara_checkout}`);
    process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const local = embedderArg === "local";
const cache = join(dirname(out), "embeddings.jsonl");
const { aws_profile, region } = config.bedrock;
const embedder = local ? hashEmbedder : bedrockEmbedder(aws_profile, region, cache);
const scenario = await compileScenario(loadCompileInput(seed, tier as Tier, embedder, local));
writeFileSync(out, `${canonicalJson(scenario)}\n`);
console.log(`${out} ${scenario.scenario_hash}`);
