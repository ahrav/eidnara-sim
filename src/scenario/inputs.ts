import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDistributions } from "../corpus/distributions";
import { parseJsonl } from "../corpus/entries";
import { loadRepos } from "../corpus/repos";
import { CORPUS_DIR } from "../corpus/sources";
import { sha256Hex } from "../prereg/canonical";
import { parseQualification, type Qualification, qualificationHash } from "../prereg/qualification";
import { TIERS, type Tier } from "../prereg/schema";
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

function readJson(path: string): unknown {
    return parseText(readFileSync(path, "utf8"), path);
}

function parseText(text: string, path: string): unknown {
    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
}

/** Corpus files the compiler reads; each must carry the digest `corpus/manifest.json` records. */
export const CONSUMED_FILES = [
    "distributions.json",
    "fact-bank.json",
    "repos.json",
    "tool-outputs/samples.jsonl",
] as const;

export function verifyCorpus(corpusDir = CORPUS_DIR): void {
    const manifest = readJson(join(corpusDir, "manifest.json")) as {
        schema?: string;
        datasets?: unknown;
        files: Record<string, string>;
    };
    if (manifest.schema !== "sim-corpus-manifest/v1") {
        throw new Error(
            `corpus/manifest.json: schema ${manifest.schema} is not sim-corpus-manifest/v1`,
        );
    }
    const sources = readJson(join(corpusDir, "sources.json")) as {
        datasets: { id: string; revision: string; access: string }[];
    };
    const configured = sources.datasets.map((d) => ({
        id: d.id,
        revision: d.revision,
        access: d.access,
    }));
    if (JSON.stringify(manifest.datasets) !== JSON.stringify(configured)) {
        throw new Error("corpus/manifest.json: datasets differ from sources.json");
    }
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

/** `prereg/<id>.json`, accepted only over the current `prereg/<tier>.json` it binds. */
export function loadQualification(
    id: string,
    dir = join(CORPUS_DIR, "..", "prereg"),
): Qualification {
    if (!/^[A-Z]+$/.test(id)) throw new Error(`qualification id ${id} is not a registration name`);
    const value = readJson(join(dir, `${id}.json`)) as { tier?: unknown; id?: unknown };
    if (typeof value?.tier !== "string" || !(TIERS as readonly string[]).includes(value.tier)) {
        throw new Error(`prereg/${id}.json names no tier`);
    }
    const q = parseQualification(value, loadPrereg(value.tier as Tier, dir));
    if (q.id !== id) throw new Error(`prereg/${id}.json names registration ${q.id}`);
    return q;
}

/**
 * The arms and A/A pairs a run's manifest is admitted under: those of the qualification it names,
 * whose current registration must hash to the recorded digest, bind the manifest's tier, list
 * its host and seed, and schedule its order for that seed, or else its tier's. The scenario must
 * name the manifest's seed and the same qualification digest, or none with a tier run.
 */
export function admittedArms(
    manifest: {
        tier: Tier;
        host?: string;
        seed?: number;
        order?: string[];
        qualification?: { id: string; sha256: string } | null;
    },
    scenario: { manifest?: Record<string, unknown> },
): { run: string[]; pairs: string[][] } {
    const ref = manifest.qualification ?? null;
    const compiledSeed = scenario.manifest?.seed;
    if (
        compiledSeed !== undefined &&
        manifest.seed !== undefined &&
        compiledSeed !== manifest.seed
    ) {
        throw new Error(
            `scenario.json was compiled for seed ${String(compiledSeed)}, but the manifest names ${manifest.seed}`,
        );
    }
    const compiled = scenario.manifest?.qualification_sha256 ?? null;
    if (compiled !== (ref?.sha256 ?? null)) {
        throw new Error(
            `scenario.json was compiled under qualification ${String(compiled ?? "none")}, but the manifest names ${ref?.sha256 ?? "none"}`,
        );
    }
    if (ref === null) {
        const prereg = loadPrereg(manifest.tier);
        return { run: prereg.arms.run, pairs: prereg.aa_controls?.pairs ?? [] };
    }
    const q = loadQualification(ref.id);
    if (qualificationHash(q) !== ref.sha256) {
        throw new Error(`prereg/${ref.id}.json changed since the run recorded ${ref.sha256}`);
    }
    if (q.tier !== manifest.tier) throw new Error(`qualification ${q.id} binds tier ${q.tier}`);
    if (manifest.host !== undefined && !q.hosts.includes(manifest.host)) {
        throw new Error(`qualification ${q.id} runs no ${manifest.host} host`);
    }
    const at = manifest.seed === undefined ? -1 : q.seeds.indexOf(manifest.seed);
    if (at < 0) throw new Error(`qualification ${q.id} runs no seed ${manifest.seed}`);
    const scheduled = q.arms.order_by_seed[at] ?? [];
    const ranks = (manifest.order ?? []).map((arm) => scheduled.indexOf(arm));
    if (ranks.some((r, i) => r < 0 || (i > 0 && r <= (ranks[i - 1] as number)))) {
        throw new Error(
            `manifest order ${(manifest.order ?? []).join(",")} is not a subsequence of qualification ${q.id}'s seed ${manifest.seed} order ${scheduled.join(",")}`,
        );
    }
    return { run: q.arms.run, pairs: [] };
}

export function langOf(role: string): Project["lang"] {
    if (role === "rust-service") return "rust";
    if (role === "typescript-package") return "typescript";
    throw new Error(`repos.json: role ${role} has no language`);
}

export const corpusManifestHash = () => sha256Hex(read("manifest.json"));

/** Every corpus file the compiler reads, hashed by its bytes as they are. */
const DIRECT_INPUTS = [
    "manifest.json",
    "fact-bank.json",
    "repos.json",
    "distributions.json",
    "tool-outputs/samples.jsonl",
];

/** One digest over the bytes of every corpus file the compiler reads. */
export const compileInputsHash = () =>
    sha256Hex(DIRECT_INPUTS.map((f) => `${f}:${sha256Hex(read(f))}`).join("\n"));

export function loadCompileInput(
    seed: number,
    tier: Tier,
    embedder: Embedder,
    standIn = false,
): CompileInput {
    verifyCorpus();
    const prereg = loadPrereg(tier);
    if (standIn) prereg.scenario.cue_probe_similarity.embedding_model = embedder.model;
    const texts = readCorpusInputs();
    const projects: Project[] = loadRepos(texts["repos.json"]).flatMap((r) => {
        const lang = langOf(r.role);
        return [
            { id: r.id, lang, twin_of: null },
            { id: r.twin.id, lang, twin_of: r.id },
        ];
    });
    return {
        seed,
        prereg,
        dist: loadDistributions(texts["distributions.json"]),
        bank: parseText(texts["fact-bank.json"], join(CORPUS_DIR, "fact-bank.json")) as Bank,
        projects,
        pastes: parseJsonl(texts["tool-outputs/samples.jsonl"]) as CompileInput["pastes"],
        corpusInputsSha256: corpusInputsSha256(texts),
        embedder,
    };
}
