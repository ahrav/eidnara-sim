import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    ftruncateSync,
    linkSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
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

const KINDS: ReadonlySet<string> = new Set<EntryKind>([
    "StartRun",
    "ResumeRun",
    "StartArm",
    "BeginTurn",
    "EndTurn",
    "RegisterJob",
    "EndJob",
    "AdvanceClock",
    "Event",
    "FaultFired",
    "FaultObserved",
    "ItemState",
    "EndArm",
    "EndRun",
]);

function shaped(e: Entry): boolean {
    return (
        KINDS.has(e.kind) &&
        (e.arm === null || typeof e.arm === "string") &&
        Number.isFinite(e.scenario_ms) &&
        Number.isFinite(e.wall_ms)
    );
}

interface Lease {
    pid: number;
    host: string;
    boot?: string;
    started_wall_ms: number;
    started_ticks?: number;
    released?: boolean;
}

function readTrimmed(path: string): string | null {
    try {
        return readFileSync(path, "utf8").trim() || null;
    } catch {
        return null;
    }
}

/**
 * The machine a lease belongs to: `/etc/machine-id`, which survives reboots, so two machines
 * or containers that share a hostname on one shared directory stay distinct; the hostname
 * stands in where the file is absent.
 */
export function leaseHost(): string {
    return readTrimmed("/etc/machine-id") ?? hostname();
}

/** The kernel's boot id: a lease from an earlier boot of this machine names a dead process. */
export function bootId(): string | undefined {
    return readTrimmed("/proc/sys/kernel/random/boot_id") ?? undefined;
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
function holderAlive(held: Lease, boot: string | undefined): boolean {
    if (held.released) return false;
    if (held.boot !== undefined && boot !== undefined && held.boot !== boot) return false;
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
            if (!m) return [];
            const n = Number(m[1]);
            if (!Number.isSafeInteger(n))
                throw new Error(`lease ${name} in ${dir} has no safe number`);
            return [n];
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
        host: leaseHost(),
        boot: bootId(),
        started_wall_ms: Date.now(),
        started_ticks: startTicks(process.pid) ?? undefined,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        const numbers = leaseNumbers(dir);
        const top = numbers.at(-1);
        const held = top === undefined ? null : readLease(join(dir, `lease.${top}.json`));
        if (held && (held.host !== mine.host || holderAlive(held, mine.boot))) {
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

/**
 * Marks this process's lease released in place, by an atomic rename over the same number, so
 * the directory keeps its highest generation and later takers all target the next one.
 */
export function releaseLease(dir: string): void {
    const host = leaseHost();
    for (const n of leaseNumbers(dir)) {
        const path = join(dir, `lease.${n}.json`);
        const held = readLease(path);
        if (held?.pid !== process.pid || held.host !== host) continue;
        const staged = join(dir, `lease.${randomUUID()}.tmp`);
        writeFileSync(staged, JSON.stringify({ ...held, released: true }), { flag: "wx" });
        renameSync(staged, path);
    }
}

/**
 * Every newline-terminated line must parse and carry the next `seq`; a cut last line without
 * its newline, which a kill mid-write leaves, is dropped. `bytes` is the length of the complete
 * prefix. `source` is a path, or an open descriptor positioned at the start of the file.
 */
export function readJournal(source: string | number): Entry[] & { bytes?: number } {
    const entries: Entry[] & { bytes?: number } = [];
    entries.bytes = 0;
    if (typeof source === "string" && !existsSync(source)) return entries;
    const path = typeof source === "string" ? source : `fd ${source}`;
    const last = new Map<string | null, number>();
    const lines = readFileSync(source, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (i === lines.length - 1) return;
        let entry: Entry;
        try {
            entry = JSON.parse(line) as Entry;
        } catch {
            throw new Error(`journal ${path}: line ${i + 1} is corrupt`);
        }
        if (entry.seq !== i) throw new Error(`journal ${path}: line ${i + 1} has seq ${entry.seq}`);
        if (!shaped(entry)) throw new Error(`journal ${path}: line ${i + 1} is not an entry`);
        const before = last.get(entry.arm);
        if (before !== undefined && entry.scenario_ms < before) {
            throw new Error(
                `journal ${path}: line ${i + 1} precedes ${before} in arm ${entry.arm}`,
            );
        }
        last.set(entry.arm, entry.scenario_ms);
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
        const { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDWR } = constants;
        this.fd = openSync(path, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
        let read: Entry[] & { bytes?: number };
        try {
            if (!fstatSync(this.fd).isFile())
                throw new Error(`journal ${path} is not a regular file`);
            read = readJournal(this.fd);
        } catch (caught) {
            closeSync(this.fd);
            throw caught;
        }
        this.entries = [...read];
        for (const e of this.entries) this.last.set(e.arm, e.scenario_ms);
        ftruncateSync(this.fd, read.bytes ?? 0);
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
