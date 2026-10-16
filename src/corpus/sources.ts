import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const CORPUS_DIR = resolve(import.meta.dir, "../../corpus");
export const CACHE_DIR = join(CORPUS_DIR, "cache");

export interface Dataset {
    id: string;
    repo: string;
    revision: string;
    license: string;
    access: "public" | "gated";
    files: { path: string; sha256: string }[];
}

export function parseJson<T>(text: string, file: string): T {
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new Error(`${file}: invalid JSON: ${(error as Error).message}`);
    }
}

export function loadSources(): Dataset[] {
    const raw = parseJson<{ schema?: string; datasets: Dataset[] }>(
        readFileSync(join(CORPUS_DIR, "sources.json"), "utf8"),
        "sources.json",
    );
    if (raw.schema !== "sim-corpus-sources/v1") throw new Error("sources.json: unknown schema");
    const datasets = raw.datasets;
    const ids = datasets.map((d) => d.id);
    if (new Set(ids).size !== ids.length) throw new Error(`sources.json: duplicate id in ${ids}`);
    for (const d of datasets) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d.id)) {
            throw new Error(
                `sources.json: id ${JSON.stringify(d.id)} is not a plain directory name`,
            );
        }
        if (d.access !== "public" && d.access !== "gated") {
            throw new Error(`sources.json: ${d.id}: access ${JSON.stringify(d.access)}`);
        }
        if (!/^[0-9a-f]{40}$/.test(d.revision)) {
            throw new Error(`sources.json: ${d.id}: revision is not a commit SHA`);
        }
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(d.repo)) {
            throw new Error(
                `sources.json: ${d.id}: repo ${JSON.stringify(d.repo)} is not owner/name`,
            );
        }
        const paths = d.files.map((f) => f.path);
        if (new Set(paths).size !== paths.length) {
            throw new Error(`sources.json: ${d.id}: a file path repeats`);
        }
        for (const f of d.files) {
            const segments = f.path.split("/");
            if (!segments.every((s) => s !== "" && s !== "." && s !== "..")) {
                throw new Error(
                    `sources.json: ${d.id}/${f.path}: path must be relative plain segments`,
                );
            }
            if (!/^[0-9a-f]{64}$/.test(f.sha256)) {
                throw new Error(`sources.json: ${d.id}/${f.path}: sha256 is not 64 hex digits`);
            }
        }
    }
    return datasets;
}

export function under(root: string, ...parts: string[]): string {
    const dest = resolve(root, ...parts);
    if (!dest.startsWith(root + sep)) {
        throw new Error(`${parts.join("/")} escapes ${root}`);
    }
    return dest;
}

export function cachePath(dataset: Dataset, path: string): string {
    if (!dataset.files.some((f) => f.path === path)) {
        throw new Error(`sources.json: ${dataset.id} does not list ${path}`);
    }
    return under(CACHE_DIR, dataset.id, dataset.revision, path);
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

/**
 * Successful completion for a public dataset guarantees that each listed
 * cache file matches its file.sha256.
 */
export async function fetchDataset(dataset: Dataset, log = console.log): Promise<void> {
    if (dataset.access === "gated") {
        log(`${dataset.id}: gated, skipped`);
        return;
    }
    if (dataset.access !== "public") {
        throw new Error(`sources.json: ${dataset.id}: access ${JSON.stringify(dataset.access)}`);
    }
    for (const file of dataset.files) {
        const dest = cachePath(dataset, file.path);
        if (existsSync(dest) && (await sha256File(dest)) === file.sha256) {
            log(`${dataset.id}/${file.path}: cached`);
            continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        const url = `https://huggingface.co/datasets/${dataset.repo}/resolve/${dataset.revision}/${file.path}`;
        const response = await fetch(url);
        if (!response.ok || response.body === null) {
            throw new Error(`${url}: HTTP ${response.status}`);
        }
        rmSync(dest, { force: true });
        const writer = Bun.file(dest).writer();
        try {
            for await (const chunk of response.body) writer.write(chunk);
            await writer.end();
        } catch (error) {
            rmSync(dest, { force: true });
            throw error;
        }
        const digest = await sha256File(dest);
        if (digest !== file.sha256) {
            rmSync(dest);
            throw new Error(
                `${dataset.id}/${file.path}: sha256 ${digest}, recorded ${file.sha256}`,
            );
        }
        log(`${dataset.id}/${file.path}: fetched, sha256 ok`);
    }
}
