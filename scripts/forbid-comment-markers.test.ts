import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "forbid-comment-markers.sh");

// Splitting `MARKER` prevents the full-tree scan from matching this test file.
const MARKER = `${["commentlin", "t"].join("")}: allow(JUDGE)`;

let repo: string;

function git(...args: string[]): void {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function stagedScan(): { status: number | null; stderr: string } {
    const result = spawnSync("bash", [SCRIPT, "--staged"], { cwd: repo, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr };
}

function stage(name: string, content: string): void {
    writeFileSync(join(repo, name), content);
    git("add", name);
}

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "forbid-comment-markers-"));
    git("init", "-q");
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe("forbid-comment-markers.sh --staged", () => {
    test("accepts a staged file without a marker", () => {
        stage("a.ts", "const value = 1; // plain comment\n");
        expect(stagedScan().status).toBe(0);
    });

    test("rejects a staged line that carries a marker", () => {
        stage("a.ts", `const value = 1; // ${MARKER}\n`);
        const { status, stderr } = stagedScan();
        expect(status).toBe(1);
        expect(stderr).toContain("forbidden comment marker");
    });

    test("rejects a marker on an added line whose content starts with a plus", () => {
        // The staged diff spells this added line as `++value; ...`.
        stage("a.ts", `let value = 1;\n+value; // ${MARKER}\n`);
        const { status, stderr } = stagedScan();
        expect(status).toBe(1);
        expect(stderr).toContain("forbidden comment marker");
    });

    test("names the offending file and line when several files are staged", () => {
        stage("clean.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
        stage("a.ts", `let value = 1;\nlet other = 2; // ${MARKER}\n`);
        const { status, stderr } = stagedScan();
        expect(status).toBe(1);
        expect(stderr).toContain("a.ts:2:");
        expect(stderr).not.toContain("clean.ts");
    });
});
