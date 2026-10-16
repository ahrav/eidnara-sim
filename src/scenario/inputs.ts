import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Distributions } from "../corpus/distributions";
import { parseJsonl } from "../corpus/entries";
import type { RepoSpec } from "../corpus/repos";
import { CORPUS_DIR } from "../corpus/sources";
import { sha256Hex } from "../prereg/canonical";
import type { Tier } from "../prereg/schema";
import { parsePreregistration } from "../prereg/validate";
import type { Bank, CompileInput, Project } from "./compile";
import type { Embedder } from "./similarity";

const read = (path: string) => readFileSync(join(CORPUS_DIR, path), "utf8");

const CORPUS_INPUTS = [
    "manifest.json",
    "fact-bank.json",
    "repos.json",
    "distributions.json",
    "tool-outputs/samples.jsonl",
    "tool-outputs/error-codes.jsonl",
] as const;
type CorpusInput = (typeof CORPUS_INPUTS)[number];

/** One read of every corpus file the compiler consumes, so the digest covers the bytes that were parsed. */
function readCorpusInputs(): Record<CorpusInput, string> {
    return Object.fromEntries(CORPUS_INPUTS.map((f) => [f, read(f)])) as Record<
        CorpusInput,
        string
    >;
}

/** One digest over every corpus file the compiler reads directly, so a change to any of them recompiles. */
export function corpusInputsSha256(
    texts: Record<CorpusInput, string> = readCorpusInputs(),
): string {
    return sha256Hex(CORPUS_INPUTS.map((f) => `${f}:${sha256Hex(texts[f])}`).join("\n"));
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
    const prereg = loadPrereg(tier);
    if (standIn) prereg.scenario.cue_probe_similarity.embedding_model = embedder.model;
    const texts = readCorpusInputs();
    const repos = JSON.parse(texts["repos.json"]);
    if (repos.schema !== "sim-corpus-repos/v1") throw new Error("repos.json: unknown schema");
    const projects: Project[] = (repos.repos as RepoSpec[]).flatMap((r) => {
        const lang = r.role === "rust-service" ? "rust" : "typescript";
        return [
            { id: r.id, lang, twin_of: null },
            { id: r.twin.id, lang, twin_of: r.id },
        ];
    });
    return {
        seed,
        prereg,
        dist: JSON.parse(texts["distributions.json"]) as Distributions,
        bank: JSON.parse(texts["fact-bank.json"]) as Bank,
        projects,
        pastes: parseJsonl(texts["tool-outputs/samples.jsonl"]) as CompileInput["pastes"],
        errorCodes: parseJsonl(
            texts["tool-outputs/error-codes.jsonl"],
        ) as CompileInput["errorCodes"],
        corpusInputsSha256: corpusInputsSha256(texts),
        embedder,
    };
}
