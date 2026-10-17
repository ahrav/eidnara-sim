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

export function processStart(pid: number): string | null {
    return statFields(pid)?.[19] ?? null;
}

export function running(pid: number): boolean {
    const fields = statFields(pid);
    return fields !== null && fields[0] !== "Z";
}

async function stopped(pids: number[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (pids.some(running)) {
        if (Date.now() >= deadline) return false;
        await Bun.sleep(50);
    }
    return true;
}

function signal(pids: number[], name: NodeJS.Signals): void {
    for (const pid of pids) {
        try {
            process.kill(pid, name);
        } catch (caught) {
            const code = (caught as { code?: string }).code;
            if (code !== "ESRCH" && code !== "EPERM") throw caught;
        }
    }
}

export async function stopOwnedTree(rootPid: number, graceMs: number): Promise<boolean> {
    const targets = ownedProcesses(rootPid);
    signal(targets, "SIGTERM");
    if (await stopped(targets, graceMs)) return true;
    const left = targets.filter(running);
    signal(left, "SIGKILL");
    return stopped(left, 2_000);
}

export function killOwnedTree(rootPid: number): void {
    signal(ownedProcesses(rootPid), "SIGKILL");
}
