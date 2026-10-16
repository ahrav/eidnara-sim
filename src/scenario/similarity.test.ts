import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bedrockEmbedder", () => {
    test("a failed CLI call leaves no temporary file beside the cache", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-embed-"));
        const fake = join(dir, "aws");
        writeFileSync(
            fake,
            '#!/bin/sh\necho \'{"embedding":[1]}\' > "${@: -1}"\necho boom >&2\nexit 1\n',
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
