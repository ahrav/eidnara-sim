import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TICKS_PER_SECOND = 100;
const PAGE_BYTES = 4096;

export function procStats(pid: number): { rss: number; cpuMs: number } | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        return { rss: Number(fields[21]) * PAGE_BYTES, cpuMs: (ticks * 1000) / TICKS_PER_SECOND };
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
            rss: stats?.rss ?? null,
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

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.busy) this.o.onBusy(false);
        this.busy = false;
    }
}
