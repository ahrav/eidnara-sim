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
    readlinkSync,
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

export interface Lease {
    pid: number;
    host: string;
    boot?: string;
    ns?: string;
    started_wall_ms: number;
    started_ticks?: number;
    /** Random per acquisition, so a release names one acquisition and no other. */
    token?: string;
    released?: boolean;
}

const optional = (v: unknown, type: string) => v === undefined || typeof v === type;

function isLease(v: unknown): v is Lease {
    if (typeof v !== "object" || v === null) return false;
    const l = v as Record<string, unknown>;
    return (
        Number.isSafeInteger(l.pid) &&
        typeof l.host === "string" &&
        optional(l.boot, "string") &&
        optional(l.ns, "string") &&
        Number.isFinite(l.started_wall_ms) &&
        (l.started_ticks === undefined ||
            (typeof l.started_ticks === "number" &&
                Number.isFinite(l.started_ticks) &&
                l.started_ticks >= 0)) &&
        optional(l.token, "string") &&
        optional(l.released, "boolean")
    );
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
    const id = readTrimmed("/etc/machine-id");
    return id ? id : `hostname:${hostname()}`;
}

/** The kernel's boot id: a lease from an earlier boot of this machine names a dead process. */
export function bootId(): string | undefined {
    return readTrimmed("/proc/sys/kernel/random/boot_id") ?? undefined;
}

/**
 * The kernel's start time of `pid` in clock ticks since boot, field 22 of `/proc/<pid>/stat`,
 * which with the pid identifies one process incarnation. `gone` is a pid with no live process
 * (no `/proc` entry, or a zombie or exiting state); `unknown` is an identity this host cannot
 * read, which never counts as dead.
 */
function startTicks(pid: number): number | "gone" | "unknown" {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[0] === "Z" || fields[0] === "X") return "gone";
        const ticks = Number(fields[19]);
        return Number.isFinite(ticks) ? ticks : "unknown";
    } catch (caught) {
        return (caught as { code?: string }).code === "ENOENT" ? "gone" : "unknown";
    }
}

/** A holder is alive when its incarnation still runs; a recycled pid is a dead holder. */
function holderAlive(held: Lease, mine: Lease): boolean {
    if (held.boot !== undefined && mine.boot !== undefined && held.boot !== mine.boot) {
        return held.host.startsWith("hostname:");
    }
    if (held.ns !== undefined && mine.ns !== undefined && held.ns !== mine.ns) return true;
    const ticks = startTicks(held.pid);
    if (ticks === "unknown") return true;
    if (ticks === "gone") return false;
    return held.started_ticks === undefined || ticks === held.started_ticks;
}

const LEASE_BYTES = 4096;

/**
 * Reads a lease through a descriptor opened without following symlinks, requiring a small regular
 * file. A file that vanished between listing and reading is absent (`null`). Every other read
 * error, and a file that does not parse to a lease, refuses the directory: a lease is linked
 * into place whole, so a damaged one is corruption and never a holder to take over.
 */
function readLease(path: string): Lease | null {
    const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;
    let fd: number;
    try {
        fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (caught) {
        if ((caught as { code?: string }).code === "ENOENT") return null;
        throw new Error(`lease ${path} cannot be opened: ${(caught as Error).message}`);
    }
    let text: string;
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error(`lease ${path} is not a regular file`);
        if (st.size > LEASE_BYTES) throw new Error(`lease ${path} is ${st.size} bytes`);
        text = readFileSync(fd, "utf8");
    } finally {
        closeSync(fd);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`lease ${path} is malformed`);
    }
    if (!isLease(parsed)) throw new Error(`lease ${path} is malformed`);
    return parsed;
}

/** The fields that name this process's own lease, compared whole when releasing it. */
function ownIdentity(): Lease {
    const own = startTicks(process.pid);
    return {
        pid: process.pid,
        host: leaseHost(),
        boot: bootId(),
        ns: pidNamespace(),
        started_wall_ms: Date.now(),
        started_ticks: typeof own === "number" ? own : undefined,
        token: randomUUID(),
    };
}

/** Two lease records name one acquisition when every identifying field agrees. */
function sameLease(a: Lease, b: Lease): boolean {
    return (
        a.pid === b.pid &&
        a.host === b.host &&
        a.boot === b.boot &&
        a.ns === b.ns &&
        a.started_ticks === b.started_ticks &&
        a.started_wall_ms === b.started_wall_ms &&
        a.token === b.token
    );
}

/** The pid namespace this process lives in; pids from another namespace cannot be probed here. */
export function pidNamespace(): string | undefined {
    try {
        return readlinkSync("/proc/self/ns/pid");
    } catch {
        return undefined;
    }
}

const LEASE = /^lease\.(0|[1-9]\d*)\.json$/;
const LEASE_LIKE = /^lease\.\d+\.json$/;

/** The numbers of every lease file in `dir`, ascending. The highest names the holder. */
function leaseNumbers(dir: string): number[] {
    return readdirSync(dir)
        .flatMap((name) => {
            const m = LEASE.exec(name);
            if (!m && LEASE_LIKE.test(name))
                throw new Error(`lease ${name} in ${dir} has no canonical number`);
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
    const mine = ownIdentity();
    for (let attempt = 0; attempt < 3; attempt++) {
        const numbers = leaseNumbers(dir);
        const top = numbers.at(-1);
        if (top === Number.MAX_SAFE_INTEGER)
            throw new Error(`lease numbers in ${dir} are exhausted`);
        const held = top === undefined ? null : readLease(join(dir, `lease.${top}.json`));
        if (held && !held.released && (held.host !== mine.host || holderAlive(held, mine))) {
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
        for (const n of numbers) {
            try {
                rmSync(join(dir, `lease.${n}.json`), { force: true });
            } catch {}
        }
        return mine;
    }
    throw new Error(`could not lease ${dir}`);
}

/**
 * Marks this process's lease released in place, by an atomic rename over the same number, so
 * the directory keeps its highest generation and later takers all target the next one.
 */
export function releaseLease(dir: string, lease: Lease): void {
    for (const n of leaseNumbers(dir)) {
        const path = join(dir, `lease.${n}.json`);
        const held = readLease(path);
        if (!held || held.released || !sameLease(held, lease)) continue;
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
    const buf = readFileSync(source);
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const lines: Buffer[] = [];
    for (let at = 0; ; ) {
        const nl = buf.indexOf(0x0a, at);
        if (nl < 0) break;
        lines.push(buf.subarray(at, nl));
        at = nl + 1;
    }
    lines.forEach((raw, i) => {
        let entry: Entry;
        try {
            entry = JSON.parse(utf8.decode(raw)) as Entry;
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
        entries.bytes = (entries.bytes ?? 0) + raw.length + 1;
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
            const st = fstatSync(this.fd);
            if (!st.isFile()) throw new Error(`journal ${path} is not a regular file`);
            if (st.nlink !== 1) throw new Error(`journal ${path} has ${st.nlink} links`);
            if (st.uid !== process.getuid?.()) throw new Error(`journal ${path} has another owner`);
            read = readJournal(this.fd);
            ftruncateSync(this.fd, read.bytes ?? 0);
        } catch (caught) {
            closeSync(this.fd);
            throw caught;
        }
        this.entries = [...read];
        for (const e of this.entries) this.last.set(e.arm, e.scenario_ms);
    }

    append(entry: NewEntry): Entry {
        if (!Number.isFinite(entry.scenario_ms)) {
            throw new Error(`journal: scenario_ms ${entry.scenario_ms} is not finite`);
        }
        const last = this.last.get(entry.arm);
        if (last !== undefined && entry.scenario_ms < last) {
            throw new Error(`journal: scenario_ms ${entry.scenario_ms} precedes ${last}`);
        }
        const full = { ...entry, seq: this.entries.length, wall_ms: Date.now() } as Entry;
        const line = Buffer.from(`${JSON.stringify(full)}\n`);
        for (let written = 0; written < line.length; ) {
            const n = writeSync(this.open(), line, written);
            if (n <= 0) throw new Error(`journal: short write at seq ${full.seq}`);
            written += n;
        }
        this.entries.push(full);
        this.last.set(entry.arm, entry.scenario_ms);
        return full;
    }

    close(): void {
        const fd = this.open();
        this.fd = -1;
        closeSync(fd);
    }

    private open(): number {
        if (this.fd < 0) throw new Error(`journal ${this.path} is closed`);
        return this.fd;
    }
}
