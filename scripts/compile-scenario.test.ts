import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
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

describe("compile-scenario output boundary", () => {
    test("an output under the Eidnara checkout is refused before anything is written", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const checkout = join(dir, "eidnara");
        mkdirSync(checkout);
        const config = JSON.parse(readFileSync(join(ROOT, "sim.config.json"), "utf8"));
        const configPath = join(dir, "sim.config.json");
        writeFileSync(configPath, JSON.stringify({ ...config, eidnara_checkout: checkout }));
        const out = join(checkout, "runs", "s.json");
        const r = Bun.spawnSync(
            [
                "bun",
                "scripts/compile-scenario.ts",
                "--tier",
                "S",
                "--seed",
                "101",
                "--embedder",
                "local",
                "--out",
                out,
            ],
            { cwd: ROOT, env: { ...process.env, SIM_CONFIG: configPath } },
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("eidnara_checkout");
        expect(readdirSync(checkout)).toEqual([]);
    });
});

describe("compile-scenario cache boundary", () => {
    test("an embedding cache symlinked into the Eidnara checkout is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const checkout = join(dir, "eidnara");
        mkdirSync(checkout);
        const outDir = join(dir, "out");
        mkdirSync(outDir);
        symlinkSync(join(checkout, "embeddings.jsonl"), join(outDir, "embeddings.jsonl"));
        const config = JSON.parse(readFileSync(join(ROOT, "sim.config.json"), "utf8"));
        const configPath = join(dir, "sim.config.json");
        writeFileSync(configPath, JSON.stringify({ ...config, eidnara_checkout: checkout }));
        const r = Bun.spawnSync(
            [
                "bun",
                "scripts/compile-scenario.ts",
                "--tier",
                "S",
                "--seed",
                "101",
                "--out",
                join(outDir, "s.json"),
            ],
            {
                cwd: ROOT,
                env: {
                    ...process.env,
                    SIM_CONFIG: configPath,
                    AWS_CONFIG_FILE: "/dev/null",
                    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
                },
            },
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("eidnara_checkout");
        expect(readdirSync(checkout)).toEqual([]);
    });
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
