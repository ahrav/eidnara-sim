import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { keepCompleteLines } from "./journal";
import { processStart } from "./procs";

const TICKS_PER_SECOND = 100;

let pageSize: number | null = null;

/** The host's memory page size in bytes, the unit `/proc/<pid>/stat` counts RSS in; read once from `getconf`. */
export function pageBytes(): number {
    if (pageSize === null) {
        const got = Number(Bun.spawnSync(["getconf", "PAGESIZE"]).stdout.toString().trim());
        pageSize = Number.isInteger(got) && got > 0 ? got : 4096;
    }
    return pageSize;
}

export function procStats(pid: number): { rss: number; cpuMs: number } | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        return { rss: Number(fields[21]) * pageBytes(), cpuMs: (ticks * 1000) / TICKS_PER_SECOND };
    } catch {
        return null;
    }
}

export function treeBytes(dir: string): number {
    let total = 0;
    const walk = (d: string) => {
        let names: string[] = [];
        try {
            names = readdirSync(d);
        } catch {
            return;
        }
        for (const name of names) {
            const p = join(d, name);
            try {
                const st = statSync(p);
                if (st.isDirectory()) walk(p);
                else if (st.isFile()) total += st.size;
            } catch {}
        }
    };
    walk(dir);
    return total;
}

export interface Sample {
    wall_ms: number;
    scenario_ms: number;
    pid: number | null;
    /** The daemon's process start time, so two lifetimes sharing a reused pid stay apart. */
    start: string | null;
    rss: number | null;
    cpu_ms: number | null;
    cpu_fraction: number | null;
    store_bytes: number;
}

export class ResourceSampler {
    private timer: ReturnType<typeof setInterval> | null = null;
    private last: { pid: number; wall: number; cpu: number } | null = null;
    private busy = false;

    constructor(
        private readonly o: {
            path: string;
            intervalMs: number;
            busyFraction: number;
            pid: () => number | null;
            storeDir: string;
            scenarioMs: () => number;
            onBusy: (busy: boolean) => void;
        },
    ) {}

    sample(transitions = true): Sample {
        const pid = this.o.pid();
        const stats = pid === null ? null : procStats(pid);
        const wall = Date.now();
        let fraction: number | null = null;
        if (stats && this.last?.pid === pid && wall > this.last.wall) {
            fraction = (stats.cpuMs - this.last.cpu) / (wall - this.last.wall);
        }
        this.last = stats && pid !== null ? { pid, wall, cpu: stats.cpuMs } : null;
        const busy = fraction !== null && fraction > this.o.busyFraction;
        if (transitions && busy !== this.busy) {
            this.busy = busy;
            this.o.onBusy(busy);
        }
        const s: Sample = {
            wall_ms: wall,
            scenario_ms: this.o.scenarioMs(),
            pid,
            start: pid === null ? null : processStart(pid),
            rss: stats?.rss ?? null,
            cpu_ms: stats?.cpuMs ?? null,
            cpu_fraction: fraction === null ? null : Math.round(fraction * 1e4) / 1e4,
            store_bytes: treeBytes(this.o.storeDir),
        };
        appendFileSync(this.o.path, `${JSON.stringify(s)}\n`);
        return s;
    }

    /** The first sample is taken at once, so RSS(0) precedes any session's work; a line a kill cut goes first. */
    start(): void {
        if (this.timer) return;
        keepCompleteLines(this.o.path);
        this.sample();
        this.timer = setInterval(() => this.sample(), this.o.intervalMs);
    }

    /** Takes a sample now: the first one when sampling has yet to start, an extra one otherwise. */
    observe(): void {
        if (this.timer) this.sample();
        else this.start();
    }

    /**
     * A running sampler takes a final sample before its timer goes, so the last interval's
     * growth is on record and reports no busy transition, so no job outlives the arm. A final
     * sample that cannot be written throws after the timer and busy state are cleared; the
     * caller shuts the arm down in a `finally` and the error keeps the run from ending as
     * complete evidence.
     */
    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        if (this.busy) this.o.onBusy(false);
        this.busy = false;
        this.sample(false);
    }
}
