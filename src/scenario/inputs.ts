import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDistributions } from "../corpus/distributions";
import { parseJsonl } from "../corpus/entries";
import { loadRepos } from "../corpus/repos";
import { CORPUS_DIR } from "../corpus/sources";
import { sha256Hex } from "../prereg/canonical";
import type { Tier } from "../prereg/schema";
import { parsePreregistration } from "../prereg/validate";
import type { Bank, CompileInput, Project } from "./compile";
import type { Embedder } from "./similarity";

const read = (path: string) => readFileSync(join(CORPUS_DIR, path), "utf8");

export function loadPrereg(tier: Tier) {
    const path = join(CORPUS_DIR, "..", "prereg", `${tier}.json`);
    return parsePreregistration(JSON.parse(readFileSync(path, "utf8")));
}

export const corpusManifestHash = () => sha256Hex(read("manifest.json"));

/** The corpus files compile reads beyond those the manifest hashes. */
const DIRECT_INPUTS = ["manifest.json", "fact-bank.json", "repos.json"];

/** One digest over every corpus file the compiler reads, through the manifest's own hashes. */
export const compileInputsHash = () =>
    sha256Hex(DIRECT_INPUTS.map((f) => `${f}:${sha256Hex(read(f))}`).join("\n"));

export function loadCompileInput(
    seed: number,
    tier: Tier,
    embedder: Embedder,
    standIn = false,
): CompileInput {
    const prereg = loadPrereg(tier);
    if (standIn) prereg.scenario.cue_probe_similarity.embedding_model = embedder.model;
    const projects: Project[] = loadRepos().flatMap((r) => {
        const lang = r.role === "rust-service" ? "rust" : "typescript";
        return [
            { id: r.id, lang, twin_of: null },
            { id: r.twin.id, lang, twin_of: r.id },
        ];
    });
    return {
        seed,
        prereg,
        dist: loadDistributions(),
        bank: JSON.parse(read("fact-bank.json")) as Bank,
        projects,
        pastes: parseJsonl(read("tool-outputs/samples.jsonl")) as CompileInput["pastes"],
        errorCodes: parseJsonl(
            read("tool-outputs/error-codes.jsonl"),
        ) as CompileInput["errorCodes"],
        corpusManifestSha256: corpusManifestHash(),
        compileInputsSha256: compileInputsHash(),
        embedder,
    };
}
