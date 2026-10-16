import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    test("a malformed provider vector is refused before it reaches the cache", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-embed-"));
        const fake = join(dir, "aws");
        writeFileSync(
            fake,
            '#!/bin/sh\nfor a; do out=$a; done\necho \'{"embedding":[0,0]}\' > "$out"\nexit 0\n',
        );
        chmodSync(fake, 0o755);
        const cache = join(dir, "embeddings.jsonl");
        const script = `
            import { bedrockEmbedder } from "${join(import.meta.dir, "similarity.ts")}";
            await bedrockEmbedder("p", "r", "${cache}").embed(["text"]);
        `;
        const r = Bun.spawnSync(["bun", "-e", script], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr.toString()).toContain("embed: amazon.titan-embed-text-v2:0 returned");
        expect(readdirSync(dir).sort()).toEqual(["aws"]);
    });

    test("an incomplete trailing cache record is skipped, complete records are kept", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-embed-"));
        const cache = join(dir, "embeddings.jsonl");
        const vector = JSON.stringify({ key: "k", vector: Array(256).fill(0.5) });
        writeFileSync(cache, `${vector}\n{"key":"partial","vec`);
        const script = `
            import { bedrockEmbedder } from "${join(import.meta.dir, "similarity.ts")}";
            bedrockEmbedder("p", "r", "${cache}");
            console.log("constructed");
        `;
        const r = Bun.spawnSync(["bun", "-e", script]);
        expect(r.stdout.toString()).toContain("constructed");
        expect(readFileSync(cache, "utf8")).toBe(`${vector}\n`);
    });

    test("a malformed cached vector is ignored and fetched again", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-embed-"));
        const fake = join(dir, "aws");
        const good = JSON.stringify({ embedding: Array(256).fill(0.0625) });
        writeFileSync(fake, `#!/bin/sh\nfor a; do out=$a; done\necho '${good}' > "$out"\nexit 0\n`);
        chmodSync(fake, 0o755);
        const cache = join(dir, "embeddings.jsonl");
        const script = `
            import { sha256Hex } from "${join(import.meta.dir, "..", "prereg", "canonical.ts")}";
            import { bedrockEmbedder } from "${join(import.meta.dir, "similarity.ts")}";
            const key = sha256Hex("amazon.titan-embed-text-v2:0\\ntext");
            require("node:fs").writeFileSync("${cache}", JSON.stringify({ key, vector: [1, 0] }) + "\\n");
            const [v] = await bedrockEmbedder("p", "r", "${cache}").embed(["text"]);
            console.log(v.length);
        `;
        const r = Bun.spawnSync(["bun", "-e", script], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        expect(r.stdout.toString().trim()).toBe("256");
    });

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
