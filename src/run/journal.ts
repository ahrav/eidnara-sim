import {
    closeSync,
    existsSync,
    fstatSync,
    linkSync,
    lstatSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    truncateSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export type EntryKind =
    | "StartRun"
    | "StartArm"
    | "BeginTurn"
    | "EndTurn"
    | "RegisterJob"
    | "EndJob"
    | "AdvanceClock"
    | "ClockOffset"
    | "Event"
    | "FaultFired"
    | "FaultObserved"
    | "ItemState"
    | "SnapshotArtefacts"
    | "StoreChecked"
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
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (caught) {
        return (caught as { code?: string }).code === "EPERM";
    }
}

function readLease(path: string): Lease | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Lease;
    } catch {
        return null;
    }
}

/**
 * The lease file names the one process that may append to the journal. A lease whose process
 * on this host has exited, or that a kill left unreadable, is moved aside by one atomic rename
 * and replaced, which is how a killed run resumes.
 */
export function takeLease(dir: string): Lease {
    const path = join(dir, "lease.json");
    const mine: Lease = { pid: process.pid, host: hostname(), started_wall_ms: Date.now() };
    for (let attempt = 0; attempt < 3; attempt++) {
        const staged = join(dir, `lease.${process.pid}.tmp`);
        writeFileSync(staged, JSON.stringify(mine));
        try {
            linkSync(staged, path);
            rmSync(staged);
            return mine;
        } catch {
            rmSync(staged);
        }
        const held = readLease(path);
        if (held && (held.host !== mine.host || alive(held.pid))) {
            throw new Error(`run directory ${dir} is leased by pid ${held.pid} on ${held.host}`);
        }
        try {
            renameSync(path, join(dir, `lease.stale.${process.pid}.${attempt}`));
        } catch {}
    }
    throw new Error(`could not lease ${dir}`);
}

export function releaseLease(dir: string): void {
    rmSync(join(dir, "lease.json"), { force: true });
}

const TAIL_CHUNK = 1 << 20;

/**
 * A log the harness appends to must be a regular file or absent; a symlink or other shape at
 * its path would carry the write elsewhere.
 */
export function requireAppendable(path: string): void {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) {
        throw new Error(`${path} is not a regular file; refusing to write through it`);
    }
}

/**
 * Truncates a JSONL file to its newline-terminated prefix, which drops the line a kill
 * mid-append left cut, and returns the byte length kept. The file is scanned backwards in
 * chunks from its end, so a log of large records costs one chunk of memory, and a missing
 * file reads as empty.
 */
export function keepCompleteLines(path: string): number {
    requireAppendable(path);
    if (!existsSync(path)) return 0;
    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        if (size === 0) return 0;
        const chunk = Buffer.alloc(Math.min(TAIL_CHUNK, size));
        let end = size;
        while (end > 0) {
            const start = Math.max(0, end - chunk.length);
            const read = readSync(fd, chunk, 0, end - start, start);
            const newline = chunk.lastIndexOf(0x0a, read - 1);
            if (newline !== -1) {
                const keep = start + newline + 1;
                if (keep < size) truncateSync(path, keep);
                return keep;
            }
            end = start;
        }
        truncateSync(path, 0);
        return 0;
    } finally {
        closeSync(fd);
    }
}

/**
 * Every line but the last must parse; a cut last line, which a kill mid-write leaves, is
 * dropped. `bytes` is the length of the complete prefix.
 */
export function readJournal(path: string): Entry[] & { bytes?: number } {
    const entries: Entry[] & { bytes?: number } = [];
    entries.bytes = 0;
    if (!existsSync(path)) return entries;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (i === lines.length - 1) return;
        try {
            entries.push(JSON.parse(line) as Entry);
            entries.bytes = (entries.bytes ?? 0) + Buffer.byteLength(line) + 1;
        } catch {
            if (i < lines.length - 2) throw new Error(`journal ${path}: line ${i + 1} is corrupt`);
        }
    });
    return entries;
}

/**
 * `requireComplete` admits a run whose journal records every scheduled event ended once per
 * arm in the compiled order, an `EndArm` per arm, and one arm-less `EndRun` after every
 * `EndArm`, with the manifest's arm order matching the journaled `StartRun`. The check indexes
 * the scheduled events once, so it costs one pass over the journal per arm. The error names the
 * arm and its event counts (SIM-P67).
 */
export function requireComplete(entries: Entry[], arms: string[], scheduled: string[]): void {
    const started = entries.find((e) => e.kind === "StartRun");
    const journaled = Array.isArray(started?.order) ? started.order : null;
    const malformed = arms.some((a) => typeof a !== "string") || new Set(arms).size !== arms.length;
    if (malformed || !journaled || JSON.stringify(journaled) !== JSON.stringify(arms)) {
        throw new Error(
            `manifest order ${JSON.stringify(arms)} differs from the journaled order ${JSON.stringify(journaled)}`,
        );
    }
    const planned = new Set(scheduled);
    const endRuns = entries.map((e, i) => [e, i] as const).filter(([e]) => e.kind === "EndRun");
    for (const arm of arms) {
        const ended: string[] = [];
        let closedAt = -1;
        for (const [i, e] of entries.entries()) {
            if (e.arm !== arm) continue;
            if (e.kind === "Event") ended.push(String(e.event));
            if (e.kind === "EndArm" && closedAt === -1) closedAt = i;
        }
        const once = new Set(ended);
        const missing = scheduled.filter((id) => !once.has(id));
        const seen = new Set<string>();
        const stray: string[] = [];
        for (const id of ended) {
            if (!planned.has(id) || seen.has(id)) stray.push(id);
            seen.add(id);
        }
        const misordered = ended.findIndex((id, i) => id !== scheduled[i]);
        if (closedAt === -1 || missing.length > 0 || stray.length > 0 || misordered !== -1) {
            const marker = closedAt !== -1 ? "EndArm present" : "no EndArm";
            const count = `${scheduled.length - missing.length} of ${scheduled.length} events ended`;
            const extra = stray.length > 0 ? `, unexpected or repeated: ${stray.join(", ")}` : "";
            const order =
                misordered !== -1 && missing.length === 0 && stray.length === 0
                    ? `, out of order from ${ended[misordered]}`
                    : "";
            throw new Error(`arm ${arm} is incomplete: ${count}, ${marker}${extra}${order}`);
        }
        if (endRuns.some(([, i]) => i < closedAt)) {
            throw new Error(`run is incomplete: EndRun before arm ${arm}'s EndArm`);
        }
    }
    if (endRuns.length === 0) {
        throw new Error("run is incomplete: the journal has no EndRun");
    }
    if (endRuns.length > 1) {
        throw new Error(`run is incomplete: ${endRuns.length} EndRun entries`);
    }
    const [closer] = endRuns[0] as readonly [Entry, number];
    if (closer.arm !== null && closer.arm !== undefined) {
        throw new Error(`run is incomplete: EndRun names arm ${String(closer.arm)}`);
    }
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
        writeSync(this.fd, `${JSON.stringify(full)}\n`);
        this.entries.push(full);
        this.last.set(entry.arm, entry.scenario_ms);
        return full;
    }

    close(): void {
        closeSync(this.fd);
    }
}
