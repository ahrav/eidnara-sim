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

export function loadSources(): Dataset[] {
    const raw = JSON.parse(readFileSync(join(CORPUS_DIR, "sources.json"), "utf8"));
    if (raw.schema !== "sim-corpus-sources/v1") throw new Error("sources.json: unknown schema");
    return raw.datasets as Dataset[];
}

export function under(root: string, ...parts: string[]): string {
    const dest = resolve(root, ...parts);
    if (!dest.startsWith(root + sep)) {
        throw new Error(`${parts.join("/")} escapes ${root}`);
    }
    return dest;
}

export function cachePath(dataset: Dataset, path: string): string {
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
    if (dataset.access !== "public") {
        log(`${dataset.id}: ${dataset.access}, skipped`);
        return;
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
        const writer = Bun.file(dest).writer();
        for await (const chunk of response.body) writer.write(chunk);
        await writer.end();
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
