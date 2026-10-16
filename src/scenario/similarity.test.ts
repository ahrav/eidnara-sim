import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bm25Ratio, cosine } from "./similarity";

describe("similarity scores", () => {
    test("cosine and bm25Ratio return full precision for the threshold gate", () => {
        const b = [0.60004, Math.sqrt(1 - 0.60004 ** 2)];
        expect(cosine([1, 0], b)).toBeGreaterThan(0.6);
        expect(bm25Ratio("alpha beta", "alpha beta gamma", ["alpha beta gamma", "delta"])).not.toBe(
            Math.round(
                bm25Ratio("alpha beta", "alpha beta gamma", ["alpha beta gamma", "delta"]) * 1e4,
            ) / 1e4,
        );
    });
});

describe("bedrockEmbedder", () => {
    test("a failed CLI call leaves no temporary file beside the cache", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-embed-"));
        const fake = join(dir, "aws");
        writeFileSync(
            fake,
            '#!/bin/sh\nfor a; do out=$a; done\necho \'{"embedding":[1]}\' > "$out"\necho boom >&2\nexit 1\n',
        );
        chmodSync(fake, 0o755);
        const script = `
            import { bedrockEmbedder } from "${join(import.meta.dir, "similarity.ts")}";
            await bedrockEmbedder("p", "r", "${join(dir, "embeddings.jsonl")}").embed(["text"]);
        `;
        const r = Bun.spawnSync(["bun", "-e", script], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr.toString()).toContain("embed: boom");
        expect(readdirSync(dir).sort()).toEqual(["aws"]);
    });
});
