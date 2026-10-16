import { describe, expect, test } from "bun:test";
import {
    existsSync,
    linkSync,
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

describe("compile-scenario temporary file", () => {
    test("a hard-linked cache and a pre-placed temporary-file symlink never reach the Eidnara checkout", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const checkout = join(dir, "eidnara");
        mkdirSync(checkout);
        const outDir = join(dir, "out");
        mkdirSync(outDir);
        const out = join(outDir, "s.json");
        symlinkSync(join(checkout, "stolen.json"), `${out}.tmp`);
        writeFileSync(join(checkout, "linked.jsonl"), "");
        linkSync(join(checkout, "linked.jsonl"), join(outDir, "embeddings.jsonl"));
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
                "--embedder",
                "local",
                "--out",
                out,
            ],
            { cwd: ROOT, env: { ...process.env, SIM_CONFIG: configPath } },
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("hard link");
        expect(readdirSync(checkout).sort()).toEqual(["linked.jsonl"]);
        expect(readFileSync(join(checkout, "linked.jsonl"), "utf8")).toBe("");
    });
});

describe("compile-scenario cache identity", () => {
    test("a cache symlink to a file hard-linked into the Eidnara checkout is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const checkout = join(dir, "eidnara");
        mkdirSync(checkout);
        const outDir = join(dir, "out");
        mkdirSync(outDir);
        writeFileSync(join(dir, "shared.jsonl"), "");
        linkSync(join(dir, "shared.jsonl"), join(checkout, "linked.jsonl"));
        symlinkSync(join(dir, "shared.jsonl"), join(outDir, "embeddings.jsonl"));
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
                "--embedder",
                "local",
                "--out",
                join(outDir, "s.json"),
            ],
            { cwd: ROOT, env: { ...process.env, SIM_CONFIG: configPath } },
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("hard link");
    });
});

describe("compile-scenario output parent", () => {
    test("an output symlink that lives inside the Eidnara checkout is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const checkout = join(dir, "eidnara");
        mkdirSync(join(checkout, "runs"), { recursive: true });
        const safe = join(dir, "safe");
        mkdirSync(safe);
        writeFileSync(join(safe, "s.json"), "");
        writeFileSync(join(safe, "embeddings.jsonl"), "");
        symlinkSync(join(safe, "s.json"), join(checkout, "runs", "s.json"));
        symlinkSync(join(safe, "embeddings.jsonl"), join(checkout, "runs", "embeddings.jsonl"));
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
                "--embedder",
                "local",
                "--out",
                join(checkout, "runs", "s.json"),
            ],
            { cwd: ROOT, env: { ...process.env, SIM_CONFIG: configPath } },
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("eidnara_checkout");
        expect(readdirSync(join(checkout, "runs")).sort()).toEqual(["embeddings.jsonl", "s.json"]);
        expect(readFileSync(join(safe, "s.json"), "utf8")).toBe("");
    });
});

describe("compile-scenario dangling cache link", () => {
    test("a cache symlink whose target does not exist yet is tolerated", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-cli-"));
        const outDir = join(dir, "out");
        mkdirSync(outDir);
        symlinkSync(join(dir, "elsewhere", "embeddings.jsonl"), join(outDir, "embeddings.jsonl"));
        const r = run(
            "--tier",
            "S",
            "--seed",
            "101",
            "--embedder",
            "local",
            "--out",
            join(outDir, "s.json"),
        );
        expect(r.stderr.toString()).toBe("");
        expect(r.exitCode).toBe(0);
    });
});

describe("compile-scenario arguments", () => {
    test("a seed outside the tier's registered seeds is refused for a Titan compile", () => {
        const out = join(mkdtempSync(join(tmpdir(), "sim-cli-")), "s.json");
        const r = run("--tier", "S", "--seed", "103", "--out", out);
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("registered seeds");
        expect(existsSync(out)).toBe(false);
    });

    test("an output that aliases the embedding cache is refused", () => {
        const out = join(mkdtempSync(join(tmpdir(), "sim-cli-")), "embeddings.jsonl");
        const r = run("--tier", "S", "--seed", "101", "--embedder", "local", "--out", out);
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("embedding cache");
        expect(existsSync(out)).toBe(false);
    });

    test("an unknown flag is refused with the usage line", () => {
        const out = join(mkdtempSync(join(tmpdir(), "sim-cli-")), "s.json");
        const r = run("--tier", "S", "--seed", "101", "--embeder", "local", "--out", out);
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("usage:");
        expect(existsSync(out)).toBe(false);
    });

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
