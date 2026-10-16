import { randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    linkSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    truncateSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export type EntryKind =
    | "StartRun"
    | "ResumeRun"
    | "StartArm"
    | "BeginTurn"
    | "EndTurn"
    | "RegisterJob"
    | "EndJob"
    | "AdvanceClock"
    | "Event"
    | "FaultFired"
    | "FaultObserved"
    | "ItemState"
    | "EndArm"
    | "EndRun";

export interface NewEntry {
    kind: EntryKind;
    arm: string | null;
    scenario_ms: number;
    [field: string]: unknown;
}

export interface Entry extends NewEntry {
    seq: number;
    wall_ms: number;
}

interface Lease {
    pid: number;
    host: string;
    started_wall_ms: number;
    started_ticks?: number;
}

/**
 * The kernel's start time of `pid` in clock ticks since boot, field 22 of `/proc/<pid>/stat`,
 * which with the pid identifies one process incarnation; `null` where `/proc` has no entry.
 */
function startTicks(pid: number): number | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
        return Number.isFinite(ticks) ? ticks : null;
    } catch {
        return null;
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (caught) {
        return (caught as { code?: string }).code === "EPERM";
    }
}

/** A holder is alive when its incarnation still runs; a recycled pid is a dead holder. */
function holderAlive(held: Lease): boolean {
    const ticks = held.started_ticks === undefined ? null : startTicks(held.pid);
    return ticks === null ? alive(held.pid) : ticks === held.started_ticks;
}

function readLease(path: string): Lease | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Lease;
    } catch {
        return null;
    }
}

const LEASE = /^lease\.(\d+)\.json$/;

/** The numbers of every lease file in `dir`, ascending. The highest names the holder. */
function leaseNumbers(dir: string): number[] {
    return readdirSync(dir)
        .flatMap((name) => {
            const m = LEASE.exec(name);
            return m ? [Number(m[1])] : [];
        })
        .sort((a, b) => a - b);
}

/**
 * The lease names the one process that may append to the journal. Leases are numbered files
 * `lease.<n>.json`, and the highest number is the holder. A takeover links `lease.<n+1>.json`,
 * which exactly one of several racing resumers can create; the others then read the winner's
 * live lease and are refused. Only the winner removes the lower-numbered files, which is how a
 * killed run resumes.
 */
export function takeLease(dir: string): Lease {
    const mine: Lease = {
        pid: process.pid,
        host: hostname(),
        started_wall_ms: Date.now(),
        started_ticks: startTicks(process.pid) ?? undefined,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        const numbers = leaseNumbers(dir);
        const top = numbers.at(-1);
        const held = top === undefined ? null : readLease(join(dir, `lease.${top}.json`));
        if (held && (held.host !== mine.host || holderAlive(held))) {
            throw new Error(`run directory ${dir} is leased by pid ${held.pid} on ${held.host}`);
        }
        const staged = join(dir, `lease.${randomUUID()}.tmp`);
        writeFileSync(staged, JSON.stringify(mine), { flag: "wx" });
        try {
            linkSync(staged, join(dir, `lease.${(top ?? -1) + 1}.json`));
        } catch {
            continue;
        } finally {
            rmSync(staged);
        }
        for (const n of numbers) rmSync(join(dir, `lease.${n}.json`), { force: true });
        return mine;
    }
    throw new Error(`could not lease ${dir}`);
}

export function releaseLease(dir: string): void {
    for (const n of leaseNumbers(dir)) {
        const path = join(dir, `lease.${n}.json`);
        const held = readLease(path);
        if (held?.pid === process.pid && held.host === hostname()) rmSync(path, { force: true });
    }
}

/**
 * Every newline-terminated line must parse and carry the next `seq`; a cut last line without
 * its newline, which a kill mid-write leaves, is dropped. `bytes` is the length of the complete
 * prefix.
 */
export function readJournal(path: string): Entry[] & { bytes?: number } {
    const entries: Entry[] & { bytes?: number } = [];
    entries.bytes = 0;
    if (!existsSync(path)) return entries;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (i === lines.length - 1) return;
        let entry: Entry;
        try {
            entry = JSON.parse(line) as Entry;
        } catch {
            throw new Error(`journal ${path}: line ${i + 1} is corrupt`);
        }
        if (entry.seq !== i) throw new Error(`journal ${path}: line ${i + 1} has seq ${entry.seq}`);
        entries.push(entry);
        entries.bytes = (entries.bytes ?? 0) + Buffer.byteLength(line) + 1;
    });
    return entries;
}

export class Journal {
    readonly entries: Entry[];
    private readonly last = new Map<string | null, number>();
    private fd: number;

    constructor(readonly path: string) {
        const read = readJournal(path);
        this.entries = [...read];
        for (const e of this.entries) this.last.set(e.arm, e.scenario_ms);
        if (existsSync(path)) truncateSync(path, read.bytes ?? 0);
        this.fd = openSync(path, "a");
    }

    append(entry: NewEntry): Entry {
        const last = this.last.get(entry.arm);
        if (last !== undefined && entry.scenario_ms < last) {
            throw new Error(`journal: scenario_ms ${entry.scenario_ms} precedes ${last}`);
        }
        const full = { ...entry, seq: this.entries.length, wall_ms: Date.now() } as Entry;
        const line = Buffer.from(`${JSON.stringify(full)}\n`);
        for (let written = 0; written < line.length; ) {
            const n = writeSync(this.fd, line, written);
            if (n <= 0) throw new Error(`journal: short write at seq ${full.seq}`);
            written += n;
        }
        this.entries.push(full);
        this.last.set(entry.arm, entry.scenario_ms);
        return full;
    }

    close(): void {
        closeSync(this.fd);
    }
}
