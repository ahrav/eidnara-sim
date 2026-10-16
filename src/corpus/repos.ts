import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR, isPlainRelativePath, under } from "./sources";

export const REPOS_DIR = join(CORPUS_DIR, "repos");
const TWINS_DIR = join(CORPUS_DIR, "twins");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id restriction keeps the returned path a direct child of REPOS_DIR. */
export function repoDir(id: string): string {
    if (!ID.test(id)) {
        throw new Error(`repos.json: id ${JSON.stringify(id)} is not a plain directory name`);
    }
    return join(REPOS_DIR, id);
}

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

const SHA = /^[0-9a-f]{40}$/;

export function loadRepos(): RepoSpec[] {
    const text = readFileSync(join(CORPUS_DIR, "repos.json"), "utf8");
    let raw: { schema?: string; repos?: RepoSpec[] };
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`repos.json: invalid JSON: ${(error as Error).message}`);
    }
    if (raw.schema !== "sim-corpus-repos/v1") throw new Error("repos.json: unknown schema");
    const repos = raw.repos as RepoSpec[];
    const ids = repos.flatMap((r) => [r.id, r.twin.id]);
    for (const id of ids) repoDir(id);
    if (new Set(ids).size !== ids.length) throw new Error(`repos.json: duplicate id in ${ids}`);
    for (const repo of repos) {
        if (!SHA.test(repo.commit)) throw new Error(`repos.json: ${repo.id}: commit is not a SHA`);
        if (typeof repo.license_file !== "string" || !isPlainRelativePath(repo.license_file)) {
            throw new Error(
                `repos.json: ${repo.id}: license_file must be a relative path in the clone`,
            );
        }
        const overlay = join(TWINS_DIR, repo.twin.id);
        if (!statSync(overlay, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error(
                `repos.json: ${repo.twin.id}: corpus/twins/${repo.twin.id} is not a directory`,
            );
        }
        const expected = repo.expected;
        const outcome =
            typeof expected === "object" &&
            expected !== null &&
            Number.isSafeInteger(expected.exit_code) &&
            Array.isArray(expected.summary) &&
            expected.summary.every((s) => typeof s === "string" && s.trim() !== "");
        if (!outcome) {
            throw new Error(
                `repos.json: ${repo.id}: expected needs an integer exit_code and summary lines`,
            );
        }
        if (!Array.isArray(repo.twin.renames)) {
            throw new Error(`repos.json: ${repo.twin.id}: renames must be an array`);
        }
        for (const rename of repo.twin.renames) {
            const fields = [rename.glob, rename.pattern, rename.replace];
            if (!fields.every((f) => typeof f === "string") || rename.glob === "") {
                throw new Error(
                    `repos.json: ${repo.twin.id}: rename needs glob, pattern, and replace`,
                );
            }
            const inside = rename.glob.split("/").every((s) => s !== "" && s !== "." && s !== "..");
            if (!inside) {
                throw new Error(
                    `repos.json: ${repo.twin.id}: glob ${rename.glob} must stay inside the twin`,
                );
            }
            try {
                new RegExp(rename.pattern, "g");
            } catch (error) {
                const why = (error as Error).message;
                throw new Error(`repos.json: ${repo.twin.id}: pattern ${rename.pattern}: ${why}`);
            }
        }
        for (const [field, cmd] of [
            ["prepare", repo.prepare],
            ["test", repo.test],
        ] as const) {
            const ok = Array.isArray(cmd) && cmd.length > 0 && cmd.every((a) => a.trim() !== "");
            if (!ok) throw new Error(`repos.json: ${repo.id}: ${field} must list a command`);
        }
    }
    return repos;
}

const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
    const [bin, ...args] = cmd;
    if (bin === undefined) throw new Error("run: empty command");
    const result = spawnSync(bin, args, {
        cwd,
        env: { ...inherited, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
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
            const file = under(twinDir, path);
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

/** Identical Cargo result lines can represent distinct targets, so summarize preserves their multiplicity. */
export function summarize(output: string): string[] {
    const results: string[] = [];
    const fails = new Set<string>();
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (/^test result:/.test(line)) results.push(line.replace(/; finished in .*$/, ""));
        else if (/^\(fail\) /.test(line)) fails.add(line.replace(/ \[[\d.]+m?s\]$/, ""));
        else if (/^\d+ (pass|fail|skip)$/.test(line)) results.push(line);
    }
    return [...results, ...fails].sort();
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
