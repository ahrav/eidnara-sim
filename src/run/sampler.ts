import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TICKS_PER_SECOND = 100;
const PAGE_BYTES = 4096;

/** `started` is the process's start time in clock ticks since boot, which tells one process from a later one with the same pid. */
export function procStats(pid: number): { rss: number; cpuMs: number; started: number } | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        return {
            rss: Number(fields[21]) * PAGE_BYTES,
            cpuMs: (ticks * 1000) / TICKS_PER_SECOND,
            started: Number(fields[19]),
        };
    } catch {
        return null;
    }
}

/** Anonymous resident memory (`RssAnon`), which holds the heap, in bytes. */
export function anonBytes(pid: number): number | null {
    try {
        const kb = /^RssAnon:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
        return kb === undefined ? null : Number(kb) * 1024;
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
    /** The process's start time in clock ticks since boot; a resumed or restarted daemon that reuses the pid differs here. */
    pid_started?: number | null;
    rss: number | null;
    heap?: number | null;
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

    sample(): Sample {
        const pid = this.o.pid();
        const stats = pid === null ? null : procStats(pid);
        const wall = Date.now();
        let fraction: number | null = null;
        if (stats && this.last?.pid === pid && wall > this.last.wall) {
            fraction = (stats.cpuMs - this.last.cpu) / (wall - this.last.wall);
        }
        this.last = stats && pid !== null ? { pid, wall, cpu: stats.cpuMs } : null;
        const busy = fraction !== null && fraction > this.o.busyFraction;
        if (busy !== this.busy) {
            this.busy = busy;
            this.o.onBusy(busy);
        }
        const s: Sample = {
            wall_ms: wall,
            scenario_ms: this.o.scenarioMs(),
            pid,
            pid_started: stats?.started ?? null,
            rss: stats?.rss ?? null,
            heap: pid === null ? null : anonBytes(pid),
            cpu_ms: stats?.cpuMs ?? null,
            cpu_fraction: fraction === null ? null : Math.round(fraction * 1e4) / 1e4,
            store_bytes: treeBytes(this.o.storeDir),
        };
        appendFileSync(this.o.path, `${JSON.stringify(s)}\n`);
        return s;
    }

    start(): void {
        this.timer ??= setInterval(() => this.sample(), this.o.intervalMs);
    }

    /** Takes one last sample when the interval was running, so the final session end has a sample after it. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.sample();
        }
        if (this.busy) this.o.onBusy(false);
        this.busy = false;
    }
}
