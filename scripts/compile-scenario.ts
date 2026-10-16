import {
    lstatSync,
    mkdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
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
mkdirSync(dirname(out), { recursive: true });
const local = embedderArg === "local";
const { aws_profile, region } = config.bedrock;
const embedder = local ? hashEmbedder : bedrockEmbedder(aws_profile, region, cache);
const scenario = await compileScenario(loadCompileInput(seed, tier as Tier, embedder, local));
const partial = `${out}.${process.pid}.tmp`;
writeFileSync(partial, `${canonicalJson(scenario)}\n`);
renameSync(partial, out);
console.log(`${out} ${scenario.scenario_hash}`);
