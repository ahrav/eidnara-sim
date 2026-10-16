import { readdirSync, readFileSync, statSync } from "node:fs";

function statFields(pid: number): string[] | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    } catch {
        return null;
    }
}

function childrenOf(pid: number): number[] {
    let tasks: string[];
    try {
        tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
        return [];
    }
    return tasks.flatMap((tid) => {
        try {
            const listed = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
            return listed
                .split(" ")
                .filter((c) => c.trim() !== "")
                .map(Number);
        } catch {
            return [];
        }
    });
}

function ownedBy(pid: number, uid: number | undefined): boolean {
    try {
        return statSync(`/proc/${pid}`).uid === uid;
    } catch {
        return false;
    }
}

export function ownedProcesses(rootPid: number): number[] {
    const uid = process.getuid?.();
    const out: number[] = [];
    const queue = [rootPid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (ownedBy(next, uid)) out.push(next);
        queue.push(...childrenOf(next));
    }
    return out;
}

export function parentPid(pid: number): number | null {
    const ppid = statFields(pid)?.[1];
    return ppid === undefined ? null : Number(ppid);
}

export function processStart(pid: number): string | null {
    return statFields(pid)?.[19] ?? null;
}

/** With `start`, a pid now owned by a process with another start time counts as gone. */
export function running(pid: number, start?: string): boolean {
    const fields = statFields(pid);
    if (fields === null || fields[0] === "Z") return false;
    return start === undefined || fields[19] === start;
}

interface Target {
    pid: number;
    start: string | null;
}

const alive = (t: Target) => t.start !== null && running(t.pid, t.start);

async function stopped(targets: Target[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (targets.some(alive)) {
        if (Date.now() >= deadline) return false;
        await Bun.sleep(50);
    }
    return true;
}

// Each pid is checked against its start time right before the signal, so a pid the kernel
// reused for another process during the grace period is left alone.
function signal(targets: Target[], name: NodeJS.Signals): void {
    for (const t of targets.filter(alive)) {
        try {
            process.kill(t.pid, name);
        } catch {}
    }
}

// The launcher root stays root-owned while the sandbox is set up, so the stop succeeds only
// once the root itself has exited too; a root still privileged then reports failure.
// `rootStart`, captured when the launcher was spawned, rules out a root pid since reused.
export async function stopOwnedTree(
    rootPid: number,
    graceMs: number,
    rootStart?: string,
): Promise<boolean> {
    if (rootStart !== undefined && processStart(rootPid) !== rootStart) return true;
    const targets = ownedProcesses(rootPid).map((pid) => ({ pid, start: processStart(pid) }));
    const all = [...targets, { pid: rootPid, start: processStart(rootPid) }];
    signal(targets, "SIGTERM");
    if (await stopped(all, graceMs)) return true;
    signal(targets, "SIGKILL");
    return stopped(all, 2_000);
}
