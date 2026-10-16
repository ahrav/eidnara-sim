import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const run = (...args: string[]) =>
    Bun.spawnSync(["bun", "scripts/compile-scenario.ts", ...args], {
        cwd: ROOT,
        env: {
            ...process.env,
            AWS_CONFIG_FILE: "/dev/null",
            AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
        },
    });

describe("compile-scenario arguments", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sim-cli-")), "s.json");
    test.each([
        ["an empty seed", ["--tier", "S", "--seed", "", "--embedder", "local", "--out", out]],
        [
            "an unknown embedder",
            ["--tier", "S", "--seed", "101", "--embedder", "hash", "--out", out],
        ],
        ["a flag without a value", ["--tier", "S", "--seed", "101", "--out", out, "--embedder"]],
    ])(
        "%s is refused with the usage line",
        (_, args) => {
            const r = run(...args);
            expect(r.exitCode).toBe(2);
            expect(r.stderr.toString()).toContain("usage:");
            expect(existsSync(out)).toBe(false);
        },
        30_000,
    );
});
