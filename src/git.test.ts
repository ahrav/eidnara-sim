import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBound, GitOverflow, git, gitEnv } from "./git";

test("git output past the cap is a bounded failure, distinct from a plain error", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-git-"));
    git(dir, ["init", "-q"]);
    expect(() => git(dir, ["help", "-a"], {}, undefined, 64)).toThrow(GitOverflow);
    try {
        git(dir, ["help", "-a"], {}, undefined, 64);
    } catch (caught) {
        expect(caught).toBeInstanceOf(GitBound);
        expect(String(caught)).toContain("output passed 64 bytes");
    }
    expect(() => git(dir, ["no-such-command"])).not.toThrow(GitBound);
});

test("an argument list past the OS limit is a bounded failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-git-"));
    git(dir, ["init", "-q"]);
    const many = Array.from({ length: 200_000 }, (_, i) => `:(exclude)dir-${i}/with/a/long/path`);
    expect(() => git(dir, ["add", "--all", "--", ".", ...many])).toThrow(GitBound);
});

test("the harness git environment turns off the per-user excludes file", () => {
    const env = gitEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    const keys = Object.entries(env).filter(([k]) => /^GIT_CONFIG_KEY_\d+$/.test(k));
    const excludes = keys.find(([, v]) => v === "core.excludesFile");
    expect(excludes).toBeDefined();
    const n = (excludes as [string, string])[0].slice("GIT_CONFIG_KEY_".length);
    expect(env[`GIT_CONFIG_VALUE_${n}`]).toBe("/dev/null");
    const dir = mkdtempSync(join(tmpdir(), "git-env-"));
    const xdg = join(dir, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "ignore"), "*.log\n");
    mkdirSync(join(dir, "repo"));
    git(join(dir, "repo"), ["init", "-q"]);
    writeFileSync(join(dir, "repo", "agent.log"), "x");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
        expect(git(join(dir, "repo"), ["status", "--porcelain"])).toContain("agent.log");
    } finally {
        if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = saved;
    }
});
