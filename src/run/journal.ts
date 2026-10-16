import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    existsSync,
    fdatasyncSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    linkSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PID_NS = /^pid:\[\d+\]$/;

function isLease(v: unknown): v is Lease {
    if (typeof v !== "object" || v === null) return false;
    const l = v as Record<string, unknown>;
    return (
        Number.isSafeInteger(l.pid) &&
        (l.pid as number) > 0 &&
        typeof l.host === "string" &&
        (l.boot === undefined || BOOT_ID.test(l.boot as string)) &&
        (l.ns === undefined || PID_NS.test(l.ns as string)) &&
        Number.isFinite(l.started_wall_ms) &&
        (l.started_ticks === undefined ||
            (Number.isSafeInteger(l.started_ticks) && (l.started_ticks as number) >= 0)) &&
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
    if ((held.ns === undefined) !== (mine.ns === undefined) || held.ns !== mine.ns) return true;
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

/** A run that failed in a way the harness owns: the run is refused rather than retried. */
export class HarnessFailure extends Error {}

/**
 * A journal is read whole before it is replayed, so its size is bounded ahead of the read: a
 * run of the largest tier journals a few thousand entries, each well under a kilobyte apart
 * from fault evidence, and this limit leaves two orders of magnitude of room.
 */
export const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;

/** The device and inode of a run directory, fixed when its lease is taken. */
export interface DirIdentity {
    dev: number;
    ino: number;
}

/** The identity of the directory `dir` resolves to now. */
export function directoryIdentity(dir: string): DirIdentity {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
    return { dev: st.dev, ino: st.ino };
}

/** Flushes a file's contents to its device. */
function flushFile(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** Flushes a directory's entries, so a file just created in it survives a crash. */
function syncDirectory(dir: string): void {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** The largest failure marker read back; the reason is one line. */
const MAX_MARKER_BYTES = 4096;

/**
 * The reason a failure marker carries, or `null` when there is none. The marker is opened
 * without following links or blocking and must be a regular single-link file under the size
 * bound; anything else is itself a failed run.
 */
function readMarker(marker: string): string | null {
    let fd: number;
    try {
        fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
        return `failure marker ${basename(marker)} cannot be opened`;
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_MARKER_BYTES) {
            return `failure marker ${basename(marker)} is not a small regular file`;
        }
        const buf = Buffer.alloc(st.size);
        let at = 0;
        while (at < st.size) {
            const n = readSync(fd, buf, at, st.size - at, at);
            if (n <= 0) break;
            at += n;
        }
        return buf.subarray(0, at).toString("utf8").trim() || "marked failed";
    } finally {
        closeSync(fd);
    }
}

const LEASE = /^lease\.(0|[1-9]\d*)\.json$/;
const LEASE_LIKE = /^lease\..*\.json$/;

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
/**
 * `within` is the identity of the directory the lease landed in, for `new Journal(path,
 * lease.within)`, so the journal opens in the leased directory even when the path is a symlink
 * repointed in between.
 */
export function takeLease(runDir: string): Lease & { within: DirIdentity } {
    const mine = ownIdentity();
    const dir = realpathSync(runDir);
    const within = directoryIdentity(dir);
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
        flushFile(staged);
        try {
            linkSync(staged, join(dir, `lease.${(top ?? -1) + 1}.json`));
            syncDirectory(dir);
        } catch {
            continue;
        } finally {
            try {
                rmSync(staged);
            } catch {}
        }
        for (const n of numbers) {
            try {
                rmSync(join(dir, `lease.${n}.json`), { force: true });
            } catch {}
        }
        const after = directoryIdentity(dir);
        if (after.dev !== within.dev || after.ino !== within.ino) {
            throw new Error(`run directory ${dir} changed while it was being leased`);
        }
        return { ...mine, within };
    }
    throw new Error(`could not lease ${dir}`);
}

/**
 * Marks this process's lease released in place, by an atomic rename over the same number, so
 * the directory keeps its highest generation and later takers all target the next one.
 */
export function releaseLease(runDir: string, lease: Lease): void {
    const dir = realpathSync(runDir);
    const top = leaseNumbers(dir).at(-1);
    if (top === undefined) return;
    const path = join(dir, `lease.${top}.json`);
    const held = readLease(path);
    if (!held || held.released || !sameLease(held, lease)) return;
    const staged = join(dir, `lease.${randomUUID()}.tmp`);
    writeFileSync(staged, JSON.stringify({ ...held, released: true }), { flag: "wx" });
    flushFile(staged);
    renameSync(staged, path);
    syncDirectory(dir);
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
    const size = (typeof source === "string" ? statSync(source) : fstatSync(source)).size;
    if (size > MAX_JOURNAL_BYTES) {
        throw new Error(`journal ${path} is ${size} bytes, over the ${MAX_JOURNAL_BYTES} limit`);
    }
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
    /** The file's path as the kernel resolved it at open, pinned for the failure marker. */
    private realPath = "";
    /** Bytes of complete lines on disk; a failed append truncates back to it. */
    private length = 0;

    /**
     * Opens the journal at `path`, and checks that the file the kernel opened lives in the
     * directory `within`, which the caller fixed when it took the run directory's lease, so a
     * directory symlink swapped underneath the path cannot route the journal elsewhere. With
     * `within` omitted, the directory is the one `path` names as the constructor starts.
     */
    constructor(
        readonly path: string,
        within: DirIdentity = directoryIdentity(dirname(resolve(path))),
    ) {
        const { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDWR } = constants;
        const target = directoryIdentity(dirname(resolve(path)));
        if (target.dev !== within.dev || target.ino !== within.ino) {
            throw new Error(`journal ${basename(path)} would open outside its run directory`);
        }
        this.fd = openSync(path, O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
        let read: Entry[] & { bytes?: number };
        try {
            const st = fstatSync(this.fd);
            if (!st.isFile()) throw new Error(`journal ${path} is not a regular file`);
            if (st.nlink !== 1) throw new Error(`journal ${path} has ${st.nlink} links`);
            if (st.uid !== process.getuid?.()) throw new Error(`journal ${path} has another owner`);
            this.realPath = readlinkSync(`/proc/self/fd/${this.fd}`);
            const parent = directoryIdentity(dirname(this.realPath));
            if (parent.dev !== within.dev || parent.ino !== within.ino) {
                throw new Error(`journal ${basename(path)} opened outside its run directory`);
            }
            const poisoned = readMarker(`${this.realPath}.failed`);
            if (poisoned !== null) throw new HarnessFailure(`run failed: ${poisoned}`);
            read = readJournal(this.fd);
            ftruncateSync(this.fd, read.bytes ?? 0);
            if (st.size === 0) syncDirectory(dirname(this.realPath));
        } catch (caught) {
            closeSync(this.fd);
            throw caught;
        }
        this.entries = [...read];
        this.length = read.bytes ?? 0;
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
        const fd = this.open();
        if (this.length + line.length > MAX_JOURNAL_BYTES) {
            throw new Error(
                `journal: seq ${full.seq} would carry the file over the ${MAX_JOURNAL_BYTES} limit`,
            );
        }
        try {
            for (let written = 0; written < line.length; ) {
                const n = writeSync(fd, line, written);
                if (n <= 0) throw new Error(`journal: short write at seq ${full.seq}`);
                written += n;
            }
            fdatasyncSync(fd);
        } catch (caught) {
            try {
                ftruncateSync(fd, this.length);
                fdatasyncSync(fd);
            } catch {
                this.fd = -1;
                try {
                    closeSync(fd);
                } catch {}
            }
            throw caught;
        }
        this.length += line.length;
        this.entries.push(full);
        this.last.set(entry.arm, entry.scenario_ms);
        return full;
    }

    close(): void {
        const fd = this.open();
        this.fd = -1;
        closeSync(fd);
    }

    /**
     * Marks the run failed on disk: writes `<journal>.failed` with the reason and flushes it,
     * so a later process refuses to open the journal even when the entry recording the failure
     * could not be appended. The journal is closed afterwards.
     */
    poison(reason: string): void {
        const marker = `${this.realPath}.failed`;
        try {
            const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = constants;
            let fd: number;
            try {
                fd = openSync(marker, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
            } catch (caught) {
                if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
                fd = openSync(marker, O_WRONLY | O_NOFOLLOW);
                const st = fstatSync(fd);
                const own = st.isFile() && st.nlink === 1 && st.uid === process.getuid?.();
                if (!own) {
                    closeSync(fd);
                    throw new Error(`failure marker ${basename(marker)} is not this run's file`);
                }
                ftruncateSync(fd, 0);
            }
            try {
                writeSync(fd, `${reason}\n`);
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            syncDirectory(dirname(realpathSync(marker)));
        } finally {
            if (this.fd >= 0) {
                const fd = this.fd;
                this.fd = -1;
                try {
                    closeSync(fd);
                } catch {}
            }
        }
    }

    private open(): number {
        if (this.fd < 0) throw new Error(`journal ${this.path} is closed`);
        return this.fd;
    }
}
