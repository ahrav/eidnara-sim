import { spawnSync } from "node:child_process";

/**
 * The environment for a harness git child: the parent's variables minus every `GIT_*`
 * variable, with global and system config disabled, then `extra`. A git hook or shell that
 * launched the harness can set `GIT_DIR`, `GIT_INDEX_FILE`, or `GIT_CONFIG_*`, and any of
 * them would redirect or reconfigure the child.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
    }
    return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

export class GitTimeout extends Error {}

/**
 * Runs git in `cwd` under `gitEnv(extra)` and returns its stdout; a non-zero exit throws.
 * With `timeoutMs`, a run still going at the bound is killed and throws `GitTimeout`.
 */
export function git(
    cwd: string,
    args: string[],
    extra: Record<string, string> = {},
    timeoutMs?: number,
): string {
    const r = spawnSync("git", args, {
        cwd,
        env: gitEnv(extra),
        encoding: "utf8",
        maxBuffer: 256 << 20,
        ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
        throw new GitTimeout(`git ${args.join(" ")}: timed out after ${timeoutMs} ms`);
    }
    if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
}
