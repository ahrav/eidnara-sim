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

/** A git run that hit one of the harness's bounds: its time limit or its output cap. */
export class GitBound extends Error {}
export class GitTimeout extends GitBound {}
export class GitOverflow extends GitBound {}

export const GIT_OUTPUT_CAP = 256 << 20;

/**
 * Runs git in `cwd` under `gitEnv(extra)` and returns its stdout; a non-zero exit throws.
 * With `timeoutMs`, a run still going at the bound is killed and throws `GitTimeout`; output
 * past `maxBuffer` throws `GitOverflow`.
 */
export function git(
    cwd: string,
    args: string[],
    extra: Record<string, string> = {},
    timeoutMs?: number,
    maxBuffer = GIT_OUTPUT_CAP,
): string {
    const r = spawnSync("git", args, {
        cwd,
        env: gitEnv(extra),
        encoding: "utf8",
        maxBuffer,
        ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") {
        throw new GitTimeout(`git ${args.join(" ")}: timed out after ${timeoutMs} ms`);
    }
    if (code === "ENOBUFS") {
        throw new GitOverflow(`git ${args.join(" ")}: output passed ${maxBuffer} bytes`);
    }
    if (code === "E2BIG") {
        throw new GitOverflow(`git ${args[0]}: ${args.length} arguments passed the OS limit`);
    }
    if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
}
