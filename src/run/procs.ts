import { readdirSync, readFileSync, statSync } from "node:fs";

function statFields(pid: number): string[] | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    } catch {
        return null;
    }
}

/** A kernel without `CONFIG_PROC_CHILDREN` has no `children` files; the parent field of every `stat` is the fallback. */
export function childrenByParent(pid: number): number[] {
    const out: number[] = [];
    for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        if (statFields(Number(entry))?.[1] === String(pid)) out.push(Number(entry));
    }
    return out;
}

/** Reads one task's `children` file; null when the kernel offers none. Tests substitute a reader. */
export type ChildrenReader = (pid: number, tid: string) => string | null;

const readChildren: ChildrenReader = (pid, tid) => {
    try {
        return readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
    } catch {
        return null;
    }
};

function childrenOf(pid: number, read: ChildrenReader): number[] {
    let tasks: string[];
    try {
        tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
        return [];
    }
    let listedAny = false;
    const found = tasks.flatMap((tid) => {
        const listed = read(pid, tid);
        if (listed === null) return [];
        listedAny = true;
        return listed
            .split(" ")
            .filter((c) => c.trim() !== "")
            .map(Number);
    });
    return listedAny ? found : childrenByParent(pid);
}

function ownedBy(pid: number, uid: number | undefined): boolean {
    try {
        return statSync(`/proc/${pid}`).uid === uid;
    } catch {
        return false;
    }
}

export function ownedProcesses(rootPid: number, read: ChildrenReader = readChildren): number[] {
    const uid = process.getuid?.();
    const out: number[] = [];
    const queue = [rootPid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (ownedBy(next, uid)) out.push(next);
        queue.push(...childrenOf(next, read));
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
        } catch {
            // A target that exits before the signal is already stopped.
        }
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
    const root = { pid: rootPid, start: rootStart ?? processStart(rootPid) };
    if (!alive(root)) return true;
    // Descendants keep being discovered while the root lives: a root-owned launcher still in
    // its privileged setup starts the user-owned command later, and that command is the target.
    const seen = new Map<number, Target>();
    // Discovery walks the root only while the pinned identity still holds the pid, so a pid the
    // kernel reused after the launcher exited is never adopted; the descendants already seen
    // still receive the signal.
    const sweep = (name: NodeJS.Signals) => {
        if (alive(root)) {
            for (const pid of ownedProcesses(rootPid)) {
                if (!seen.has(pid)) seen.set(pid, { pid, start: processStart(pid) });
            }
        }
        signal([...seen.values()], name);
    };
    const settled = () => !alive(root) && [...seen.values()].every((t) => !alive(t));
    const phase = async (name: NodeJS.Signals, ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            sweep(name);
            if (settled()) return true;
            await Bun.sleep(50);
        }
        return settled();
    };
    if (await phase("SIGTERM", graceMs)) return true;
    if (await phase("SIGKILL", 2_000)) return true;
    // The privileged fallback walks the root only while the pinned identity still holds it; a
    // root already gone leaves the verdict to the descendants seen.
    if (rootStart === undefined || !alive(root)) return settled();
    // The launcher is root-owned until its sandbox drops privileges, so what is left of a pinned
    // launch is killed through the same passwordless sudo the launcher runs under. The walk is
    // taken only while the pinned root still holds its pid, and discarded when that changes
    // during the walk, so a pid reused in between is never signalled.
    const walked = treeProcesses(rootPid).map((pid) => ({ pid, start: processStart(pid) }));
    if (!alive(root)) return settled();
    const privileged = walked.filter(alive);
    if (privileged.length === 0) return settled();
    Bun.spawnSync([
        "sudo",
        "-n",
        "kill",
        "-KILL",
        ...privileged.filter(alive).map((t) => String(t.pid)),
    ]);
    return stopped([...seen.values(), root, ...privileged], 2_000);
}

function treeProcesses(rootPid: number): number[] {
    const out: number[] = [];
    const queue = [rootPid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (statFields(next) !== null) out.push(next);
        queue.push(...childrenOf(next, readChildren));
    }
    return out;
}
