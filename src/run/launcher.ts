import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UNSHARE_ARGS = ["--mount", "--pid", "--fork", "--mount-proc", "--propagation", "private"];
// `~` is admitted for A/A control labels such as `host~aa`; the sandbox script reads these
// words from parameters, which the shell never tilde-expands.
const PLAIN_PATH = /^\/[A-Za-z0-9._@+~/-]*$/;
const PLAIN_VALUE = /^[A-Za-z0-9._@+~/:,=-]*$/;

export const shellQuote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

export function plainPath(path: string): string {
    if (!PLAIN_PATH.test(path)) {
        throw new Error(`sandbox path ${JSON.stringify(path)} must match ${PLAIN_PATH}`);
    }
    return path;
}

const within = (path: string, dir: string) =>
    path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

export function maskedPaths(runRoot: string): string[] {
    const candidates = [...new Set(["/tmp", realpathSync(homedir()), runRoot])].sort(
        (a, b) => a.length - b.length,
    );
    const masked: string[] = [];
    for (const path of candidates) {
        if (!masked.some((outer) => within(path, outer))) masked.push(path);
    }
    return masked;
}

// The setuid sudo boundary strips LD_PRELOAD, so the interposer reaches the host only
// through variables set after setpriv.
function script(hidden: readonly string[]): string {
    const mounts = hidden
        .map((dir) => `mount -t tmpfs -o mode=1777 tmpfs ${plainPath(dir)}`)
        .join("\n");
    const ids = `--reuid=${process.getuid?.() ?? 0} --regid=${process.getgid?.() ?? 0}`;
    return `#!/bin/sh
SIM_PATH="$PATH" exec sudo -n --preserve-env unshare ${UNSHARE_ARGS.join(" ")} /bin/sh -c '
set -e
keep=""
while [ "$1" != "--ro" ]; do keep="$keep $1"; shift; done
shift
ro=""
while [ "$1" != "--env" ]; do ro="$ro $1"; keep="$keep $1"; shift; done
shift
envs=""
while [ "$1" != "--" ]; do envs="$envs $1"; shift; done
shift
st=$(mktemp -d /dev/shm/simst.XXXXXX)
for p in $keep; do mkdir -p "$st$p"; mount --rbind "$p" "$st$p"; done
${mounts}
for p in $keep; do mkdir -p "$p"; mount --rbind "$st$p" "$p"; done
for p in $keep; do umount -R "$st$p" || true; done
for p in $ro; do mount -o remount,bind,ro "$p"; done
find "$st" -depth -type d -empty -delete || true
export PATH="$SIM_PATH"
setpriv ${ids} --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- env --default-signal=INT,TERM $envs "$@"
exit 0' sh "$@"
`;
}

export function writeLauncher(runRoot: string): string {
    const root = realpathSync(runRoot);
    const path = join(root, "sandbox.sh");
    const staged = `${path}.${process.pid}`;
    writeFileSync(staged, script(maskedPaths(root)), { mode: 0o755 });
    renameSync(staged, path);
    return path;
}

export function launch(
    launcher: string,
    keep: readonly string[],
    env: Record<string, string>,
    command: readonly string[],
    readOnly: readonly string[] = [],
): string[] {
    const pairs = Object.entries(env).map(([k, v]) => {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || !PLAIN_VALUE.test(v)) {
            throw new Error(`sandbox env ${k} must be a plain word`);
        }
        return `${k}=${v}`;
    });
    const ro = readOnly.map(plainPath);
    return [launcher, ...keep.map(plainPath), "--ro", ...ro, "--env", ...pairs, "--", ...command];
}

export function sandboxAvailable(): boolean {
    const probe = ["sudo", "-n", "--preserve-env", "unshare", ...UNSHARE_ARGS, "true"];
    return Bun.spawnSync(probe).exitCode === 0;
}
