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

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
        throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
}

/** Corpus files the compiler reads; each must carry the digest `corpus/manifest.json` records. */
export const CONSUMED_FILES = [
    "distributions.json",
    "fact-bank.json",
    "repos.json",
    "tool-outputs/error-codes.jsonl",
    "tool-outputs/samples.jsonl",
] as const;

export function verifyCorpus(corpusDir = CORPUS_DIR): void {
    const manifest = readJson(join(corpusDir, "manifest.json")) as {
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

export function loadPrereg(tier: Tier, dir = join(CORPUS_DIR, "..", "prereg")) {
    const prereg = parsePreregistration(readJson(join(dir, `${tier}.json`)));
    if (prereg.tier !== tier) {
        throw new Error(`prereg/${tier}.json names tier ${prereg.tier}`);
    }
    return prereg;
}

export function langOf(role: string): Project["lang"] {
    if (role === "rust-service") return "rust";
    if (role === "typescript-package") return "typescript";
    throw new Error(`repos.json: role ${role} has no language`);
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
        const lang = langOf(r.role);
        return [
            { id: r.id, lang, twin_of: null },
            { id: r.twin.id, lang, twin_of: r.id },
        ];
    });
    return {
        seed,
        prereg,
        dist: loadDistributions(),
        bank: readJson(join(CORPUS_DIR, "fact-bank.json")) as Bank,
        projects,
        pastes: parseJsonl(read("tool-outputs/samples.jsonl")) as CompileInput["pastes"],
        errorCodes: parseJsonl(
            read("tool-outputs/error-codes.jsonl"),
        ) as CompileInput["errorCodes"],
        corpusManifestSha256: sha256Hex(read("manifest.json")),
        embedder,
    };
}
