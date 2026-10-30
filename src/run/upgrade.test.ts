import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Manifest, manifestIdentity, requireRecoveryUpgrade, simRevision } from "./run";

const CLEAN = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function repo() {
    const dir = mkdtempSync(join(tmpdir(), "sim-upgrade-"));
    const g = (...args: string[]) =>
        spawnSync("git", args, {
            cwd: dir,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        }).stdout.trim();
    const commit = (path: string, text: string) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
        g("add", path);
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", path);
        return g("rev-parse", "HEAD");
    };
    g("init", "-q");
    return { dir, g, commit };
}

test("a resume may move to a descendant commit that changes only harness recovery code", () => {
    const { dir, commit } = repo();
    const base = commit("src/run/scheduler.ts", "a\n");
    const fix = commit("src/run/scheduler.ts", "b\n");
    const at = (c: string) => ({ commit: c, worktree: CLEAN });
    expect(() => requireRecoveryUpgrade(at(base), at(fix), dir)).not.toThrow();
});

test("a resume refuses a commit that changes a measurement path, is unrelated, or a dirty tree", () => {
    const { dir, g, commit } = repo();
    const base = commit("src/run/scheduler.ts", "a\n");
    const persona = commit("src/usersim/usersim.ts", "persona\n");
    const prereg = commit("prereg/S.json", "{}\n");
    g("checkout", "-q", "--orphan", "other");
    const unrelated = commit("src/run/run.ts", "x\n");
    const at = (c: string, worktree = CLEAN) => ({ commit: c, worktree });
    expect(() => requireRecoveryUpgrade(at(base), at(persona), dir)).toThrow(
        "changes measurement paths: src/usersim/usersim.ts",
    );
    expect(() => requireRecoveryUpgrade(at(persona), at(prereg), dir)).toThrow(
        "changes measurement paths: prereg/S.json",
    );
    expect(() => requireRecoveryUpgrade(at(base), at(unrelated), dir)).toThrow("does not descend");
    expect(() => requireRecoveryUpgrade(at(base, "dirty"), at(persona), dir)).toThrow(
        "clean eidnara-sim checkouts",
    );
    expect(() => requireRecoveryUpgrade(at(base), at(persona, "dirty"), dir)).toThrow(
        "clean eidnara-sim checkouts",
    );
});

test("a recorded sim revision leaves the execution digest the journal's Preflight entries bind", () => {
    const manifest = {
        schema: "sim-run-manifest/v3",
        sim_commit: "a",
        preflight: {},
    } as unknown as Manifest;
    const upgraded = {
        ...manifest,
        sim_revisions: [
            { commit: "b", worktree: CLEAN, from_commit: "a", arms: ["x"], accepted_wall_ms: 1 },
        ],
    };
    expect(manifestIdentity(upgraded)).toBe(manifestIdentity(manifest));
    expect(manifestIdentity({ ...manifest, sim_commit: "b" })).not.toBe(manifestIdentity(manifest));
});

test("simRevision records an accepted upgrade, keeps an upgraded run at its latest revision, and refuses the rest", () => {
    const { dir, commit } = repo();
    const a = commit("src/run/scheduler.ts", "a\n");
    const b = commit("src/run/scheduler.ts", "b\n");
    const start = { sim_commit: a, sim_worktree: CLEAN };
    const at = (c: string) => ({ sim_commit: c, sim_worktree: CLEAN });
    // Moving without the flag is refused with a hint; with it, the revision is recorded.
    expect(() => simRevision(start, at(b), undefined, [], dir)).toThrow(
        "inputs changed since the run started: sim_commit (a harness-recovery change resumes with --sim-upgrade <commit>)",
    );
    expect(() => simRevision(start, at(b), a, [], dir)).toThrow(`this checkout runs ${b}`);
    expect(() => simRevision(start, at(b), b, ["binaries"], dir)).toThrow(
        "inputs changed since the run started: binaries, sim_commit",
    );
    const revision = simRevision(start, at(b), b, [], dir);
    expect(revision).toMatchObject({ commit: b, worktree: CLEAN, from_commit: a });
    const upgraded = { ...start, sim_revisions: [revision as NonNullable<typeof revision>] };
    // The upgraded run resumes at b with or without the flag, and going back to a is a move.
    expect(simRevision(upgraded, at(b), undefined, [], dir)).toBeNull();
    expect(simRevision(upgraded, at(b), b, [], dir)).toBeNull();
    expect(() => simRevision(upgraded, at(b), a, [], dir)).toThrow(`the run is at ${b}`);
    expect(() => simRevision(upgraded, at(a), undefined, [], dir)).toThrow(
        "inputs changed since the run started: sim_commit",
    );
    expect(() => simRevision(upgraded, at(a), a, [], dir)).toThrow("does not descend");
});

test("simRevision refuses a sim_revisions entry the gate never accepted", () => {
    const { dir, commit } = repo();
    const a = commit("src/run/scheduler.ts", "a\n");
    const persona = commit("src/usersim/usersim.ts", "persona\n");
    const start = { sim_commit: a, sim_worktree: CLEAN };
    const forged = (from_commit: string) => ({
        ...start,
        sim_revisions: [
            { commit: persona, worktree: CLEAN, from_commit, arms: [], accepted_wall_ms: 1 },
        ],
    });
    const now = { sim_commit: persona, sim_worktree: CLEAN };
    expect(() => simRevision(forged(a), now, undefined, [], dir)).toThrow(
        "changes measurement paths: src/usersim/usersim.ts",
    );
    expect(() => simRevision(forged(persona), now, undefined, [], dir)).toThrow(
        "sim_revisions breaks its chain",
    );
});
