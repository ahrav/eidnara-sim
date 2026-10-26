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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { loadConfig } from "../src/config/config";
import { canonicalJson } from "../src/prereg/canonical";
import { qualificationHash } from "../src/prereg/qualification";
import { TIERS, type Tier } from "../src/prereg/schema";
import { compileScenario } from "../src/scenario/compile";
import { loadCompileInput, loadPrereg, loadQualification } from "../src/scenario/inputs";
import { bedrockEmbedder, hashEmbedder } from "../src/scenario/similarity";

const FLAGS = ["tier", "seed", "embedder", "out", "qualification"];
const usage = (why: string) => {
    console.error(
        `${why}\nusage: --tier S|M|L|XL --seed <int> [--embedder local] [--out path] [--qualification Q]`,
    );
    process.exit(2);
};
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
    const name = (argv[i] ?? "").replace(/^--/, "");
    const value = argv[i + 1];
    if (!FLAGS.includes(name) || argv[i] === name) usage(`unknown argument ${argv[i]}`);
    if (args.has(name)) usage(`--${name} given twice`);
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        usage(`--${name} needs a value`);
    }
    args.set(name, value as string);
}
const [tier, seedArg, embedderArg, outArg, qualificationArg] = FLAGS.map((f) => args.get(f));
const seed = Number(seedArg);
if (!TIERS.includes(tier as Tier)) usage(`--tier must be one of ${TIERS.join(", ")}`);
if (!/^\d+$/.test(seedArg ?? "")) usage("--seed must be a non-negative integer");
if (![undefined, "local"].includes(embedderArg)) usage("--embedder accepts only local");
const local = embedderArg === "local";
const defaultName = `${tier}-${seed}${qualificationArg ? `-${qualificationArg}` : ""}${local ? ".local" : ""}.json`;
const out = outArg ?? join(import.meta.dir, "..", "runs", "scenarios", defaultName);
const config = loadConfig();
const kind = (path: string) => {
    try {
        return lstatSync(path).isSymbolicLink() ? "link" : "real";
    } catch {
        return "missing";
    }
};
const target = (link: string) => {
    const t = readlinkSync(link);
    return isAbsolute(t) ? t : `${dirname(link)}${sep}${t}`;
};
const canonical = (path: string, depth = 0): string => {
    if (depth > 40) throw new Error(`${path}: too many levels of symbolic links`);
    const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
    let cur: string = sep;
    for (const part of absolute.split(sep).filter((p) => p !== "" && p !== ".")) {
        if (kind(cur) === "link") cur = canonical(target(cur), depth + 1);
        else if (kind(cur) === "real") cur = realpathSync(cur);
        cur = part === ".." ? dirname(cur) : join(cur, part);
    }
    if (kind(cur) === "link") return canonical(target(cur), depth + 1);
    return kind(cur) === "real" ? realpathSync(cur) : cur;
};
const checkout = canonical(config.eidnara_checkout);
const cache = join(dirname(out), "embeddings.jsonl");
const inside = (path: string) => {
    const rel = relative(checkout, canonical(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
for (const path of [out, cache, dirname(out)]) {
    if (inside(path)) {
        console.error(`${path} resolves inside eidnara_checkout ${config.eidnara_checkout}`);
        process.exit(2);
    }
}
if (canonical(out) === canonical(cache)) {
    console.error(`--out ${out} is the embedding cache path; choose another file name`);
    process.exit(2);
}
if ((statSync(cache, { throwIfNoEntry: false })?.nlink ?? 0) > 1) {
    console.error(
        `${cache} is a hard link shared with another path; the cache must be its own file`,
    );
    process.exit(2);
}
if (statSync(out, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`--out ${out} is a directory; name the scenario file`);
    process.exit(2);
}
const qualification = (() => {
    if (qualificationArg === undefined) return undefined;
    try {
        return loadQualification(qualificationArg);
    } catch (caught) {
        return usage(`--qualification ${qualificationArg}: ${(caught as Error).message}`);
    }
})();
if (qualification && qualification.tier !== tier) {
    usage(`qualification ${qualification.id} runs over tier ${qualification.tier}, not ${tier}`);
}
const registered = qualification
    ? [...qualification.seeds, ...(qualification.holdout?.seeds ?? [])]
    : loadPrereg(tier as Tier).seeds;
if (!local && !registered.includes(seed)) {
    const owner = qualification ? `qualification ${qualification.id}` : `tier ${tier}`;
    console.error(`seed ${seed} is not among ${owner}'s registered seeds ${registered.join(", ")}`);
    process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const { aws_profile, region } = config.bedrock;
const embedder = local ? hashEmbedder : bedrockEmbedder(aws_profile, region, cache);
const scenario = await compileScenario({
    ...loadCompileInput(seed, tier as Tier, embedder, local),
    ...(qualification
        ? {
              qualification: {
                  sha256: qualificationHash(qualification),
                  controls: qualification.controls,
              },
          }
        : {}),
});
const partial = `${out}.${randomBytes(6).toString("hex")}.tmp`;
try {
    writeFileSync(partial, `${canonicalJson(scenario)}\n`, { flag: "wx" });
    renameSync(partial, out);
} finally {
    rmSync(partial, { force: true });
}
console.log(`${out} ${scenario.scenario_hash}`);
