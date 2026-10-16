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

/** Corpus files the compiler reads; each must carry the digest `corpus/manifest.json` records. */
export const CONSUMED_FILES = [
    "distributions.json",
    "fact-bank.json",
    "repos.json",
    "tool-outputs/error-codes.jsonl",
    "tool-outputs/samples.jsonl",
] as const;

export function verifyCorpus(corpusDir = CORPUS_DIR): void {
    const manifest = JSON.parse(readFileSync(join(corpusDir, "manifest.json"), "utf8")) as {
        files: Record<string, string>;
    };
    for (const path of CONSUMED_FILES) {
        const actual = sha256Hex(readFileSync(join(corpusDir, path), "utf8"));
        if (actual !== manifest.files[path]) {
            throw new Error(
                `corpus/${path}: sha256 ${actual} differs from corpus/manifest.json (${manifest.files[path]})`,
            );
        }
    }
}

export function loadPrereg(tier: Tier) {
    const path = join(CORPUS_DIR, "..", "prereg", `${tier}.json`);
    return parsePreregistration(JSON.parse(readFileSync(path, "utf8")));
}

export function loadCompileInput(
    seed: number,
    tier: Tier,
    embedder: Embedder,
    standIn = false,
): CompileInput {
    verifyCorpus();
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
        corpusManifestSha256: sha256Hex(read("manifest.json")),
        embedder,
    };
}
