import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { sha256Hex } from "../prereg/canonical";

export interface Embedder {
    model: string;
    embed(texts: string[]): Promise<number[][]>;
}

export function terms(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * `bm25Ratio` normalizes the BM25 score of `query` against `doc` by `doc`'s
 * self-score. Document frequencies come from `collection`.
 */
export function bm25Ratio(query: string, doc: string, collection: string[]): number {
    const docs = collection.map((d) => terms(d));
    const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    const target = terms(doc);
    const tf = new Map<string, number>();
    for (const t of target) tf.set(t, (tf.get(t) ?? 0) + 1);
    const score = (q: string[]) =>
        [...new Set(q)].reduce((s, t) => {
            const f = tf.get(t) ?? 0;
            const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
            return s + (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * target.length) / avg));
        }, 0);
    const self = score(target);
    return self === 0 ? 0 : score(terms(query)) / self;
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    a.forEach((v, i) => {
        const w = b[i] ?? 0;
        dot += v * w;
        na += v * v;
        nb += w * w;
    });
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** hashEmbedder computes signed, feature-hashed bag-of-words vectors locally. */
export const hashEmbedder: Embedder = {
    model: "local-hash-256/v1",
    async embed(texts) {
        return texts.map((text) => {
            const v = new Array<number>(256).fill(0);
            for (const t of terms(text)) {
                const h = Number.parseInt(sha256Hex(t).slice(0, 8), 16);
                v[h % 256] = (v[h % 256] ?? 0) + (h & 0x100 ? 1 : -1);
            }
            return v;
        });
    },
};

/**
 * `bedrockEmbedder` fetches Titan text embeddings through the AWS CLI and
 * caches vectors by a digest of the model and text. Embedding runs entirely
 * offline when `cachePath` contains vectors for every requested text.
 */
export function bedrockEmbedder(profile: string, region: string, cachePath: string): Embedder {
    const model = "amazon.titan-embed-text-v2:0";
    const cache = new Map<string, number[]>();
    if (existsSync(cachePath)) {
        for (const line of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) {
            let entry: { key: string; vector: number[] };
            try {
                entry = JSON.parse(line);
            } catch {
                throw new Error(`embedding cache ${cachePath} holds a malformed line`);
            }
            cache.set(entry.key, entry.vector);
        }
    }
    return {
        model,
        async embed(texts) {
            const out: number[][] = [];
            for (const text of texts) {
                const key = sha256Hex(`${model}\n${text}`);
                let vector = cache.get(key);
                if (vector === undefined) {
                    const input = { inputText: text, dimensions: 256, normalize: true };
                    const outFile = `${cachePath}.${process.pid}.tmp`;
                    const cli = `bedrock-runtime invoke-model --cli-binary-format raw-in-base64-out`;
                    const flags = ["--profile", profile, "--region", region, "--model-id", model];
                    const argv = [
                        "aws",
                        ...cli.split(" "),
                        ...flags,
                        "--body",
                        JSON.stringify(input),
                    ];
                    let response: { embedding: number[] };
                    try {
                        const r = Bun.spawnSync([...argv, outFile], { timeout: 60_000 });
                        if (r.exitCode !== 0) throw new Error(`embed: ${r.stderr.toString()}`);
                        response = JSON.parse(readFileSync(outFile, "utf8"));
                    } finally {
                        rmSync(outFile, { force: true });
                    }
                    vector = response.embedding.map((x) => Math.round(x * 1e6) / 1e6);
                    cache.set(key, vector);
                    appendFileSync(cachePath, `${JSON.stringify({ key, vector })}\n`);
                }
                out.push(vector);
            }
            return out;
        },
    };
}

/** Four-decimal rendering for the journaled score; the gate compares the full value. */
export function round4(v: number): number {
    return Math.round(v * 1e4) / 1e4;
}
