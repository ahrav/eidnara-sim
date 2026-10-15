import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR } from "./sources";

export const REPOS_DIR = join(CORPUS_DIR, "repos");
const TWINS_DIR = join(CORPUS_DIR, "twins");

export interface Rename {
    glob: string;
    pattern: string;
    replace: string;
}

export interface TwinSpec {
    id: string;
    commit: string;
    renames: Rename[];
}

export interface RepoSpec {
    id: string;
    role: "rust-service" | "typescript-package";
    url: string;
    commit: string;
    license: string;
    license_file: string;
    prepare: string[];
    test: string[];
    expected: { exit_code: number; summary: string[] };
    twin: TwinSpec;
}

export function loadRepos(): RepoSpec[] {
    const raw = JSON.parse(readFileSync(join(CORPUS_DIR, "repos.json"), "utf8"));
    if (raw.schema !== "sim-corpus-repos/v1") throw new Error("repos.json: unknown schema");
    return raw.repos as RepoSpec[];
}

function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
    const [bin, ...args] = cmd;
    if (bin === undefined) throw new Error("run: empty command");
    const result = spawnSync(bin, args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) throw new Error(`${bin}: ${result.error.message}`);
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
    const r = run(["git", ...args], cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.output}`);
    return r.output.trim();
}

/** cloneAt leaves HEAD detached at `commit` with history limited to that commit. */
export function cloneAt(url: string, commit: string, dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "fetch", "-q", "--depth", "1", url, commit);
    git(dir, "checkout", "-q", "--detach", commit);
}

/** buildTwin fixes author and committer identities and dates to stabilize the twin SHA across builds. */
export function buildTwin(baseDir: string, twinDir: string, twin: TwinSpec): string {
    rmSync(twinDir, { recursive: true, force: true });
    git(CORPUS_DIR, "clone", "-q", "--no-hardlinks", baseDir, twinDir);
    for (const rename of twin.renames) {
        for (const path of new Bun.Glob(rename.glob).scanSync({ cwd: twinDir })) {
            const file = join(twinDir, path);
            const text = readFileSync(file, "utf8");
            const next = text.replace(new RegExp(rename.pattern, "g"), rename.replace);
            if (next !== text) writeFileSync(file, next);
        }
    }
    cpSync(join(TWINS_DIR, twin.id), twinDir, { recursive: true });
    git(twinDir, "add", "-A");
    const stamp = "2026-10-12T00:00:00Z";
    const identity = { name: "eidnara-sim", email: "eidnara-sim@users.noreply.github.com" };
    const r = run(["git", "commit", "-q", "--no-verify", "-m", `twin: ${twin.id}`], twinDir, {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_COMMITTER_DATE: stamp,
    });
    if (r.code !== 0) throw new Error(`twin commit: ${r.output}`);
    return git(twinDir, "rev-parse", "HEAD");
}

/** summarize removes timing differences from result-line comparisons. */
export function summarize(output: string): string[] {
    const lines = new Set<string>();
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (/^test result:/.test(line)) lines.add(line.replace(/; finished in .*$/, ""));
        else if (/^\(fail\) /.test(line)) lines.add(line.replace(/ \[[\d.]+m?s\]$/, ""));
        else if (/^\d+ (pass|fail|skip)$/.test(line)) lines.add(line);
    }
    return [...lines].sort();
}

export function runOffline(dir: string, test: string[]) {
    const r = run(
        ["unshare", "-rn", "sh", "-c", 'ip link set lo up && exec "$@"', "sh", ...test],
        dir,
    );
    return { exit_code: r.code, summary: summarize(r.output) };
}

export function prepare(dir: string, cmd: string[]): void {
    const r = run(cmd, dir);
    if (r.code !== 0) throw new Error(`prepare ${cmd.join(" ")}: ${r.output}`);
}
