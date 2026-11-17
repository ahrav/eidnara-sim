import { spawnSync } from "node:child_process";

/**
 * The environment for a harness git child: the parent's variables minus every `GIT_*`
 * variable, with global and system config disabled and the per-user excludes file
 * (`$XDG_CONFIG_HOME/git/ignore`) pointed at `/dev/null`, then `extra`. A git hook or shell that
 * launched the harness can set `GIT_DIR`, `GIT_INDEX_FILE`, or `GIT_CONFIG_*`, and any of
 * them would redirect or reconfigure the child.
 */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
    }
    return {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: "/dev/null",
        ...extra,
    };
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
    return gitBytes(cwd, args, extra, timeoutMs, { maxBuffer }).toString("utf8");
}

/**
 * Git paths can contain invalid UTF-8; `gitBytes` preserves bytes that UTF-8 decoding would
 * replace. `accept` lists the exit statuses the caller takes as an answer (`check-ignore`
 * exits 1 when it matches no path); any other status throws.
 */
export function gitBytes(
    cwd: string,
    args: string[],
    extra: Record<string, string> = {},
    timeoutMs?: number,
    o: { input?: Buffer | undefined; accept?: readonly number[]; maxBuffer?: number } = {},
): Buffer {
    const maxBuffer = o.maxBuffer ?? GIT_OUTPUT_CAP;
    const r = spawnSync("git", args, {
        cwd,
        env: gitEnv(extra),
        maxBuffer,
        ...(o.input ? { input: o.input } : {}),
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
    if (!(o.accept ?? [0]).includes(r.status as number)) {
        throw new Error(`git ${args.join(" ")}: ${r.stderr.toString("utf8")}`);
    }
    return r.stdout;
}
