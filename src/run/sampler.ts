import {
    appendFileSync,
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    truncateSync,
} from "node:fs";
import { join } from "node:path";

/** The kernel reports CPU time in clock ticks; `getconf CLK_TCK` supplies the ticks per second. */
const CLK_TCK = (() => {
    const out = Bun.spawnSync(["getconf", "CLK_TCK"], { stdout: "pipe", stderr: "pipe" });
    const ticks = Number(out.stdout.toString().trim());
    if (out.exitCode !== 0 || !Number.isInteger(ticks) || ticks <= 0) {
        throw new Error(
            `getconf CLK_TCK: ${out.stderr.toString().trim() || out.stdout.toString()}`,
        );
    }
    return ticks;
})();

export function procStats(pid: number): { rss: number; cpuMs: number } | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        const rssKb = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
        if (!rssKb) return null;
        return { rss: Number(rssKb[1]) * 1024, cpuMs: (ticks * 1000) / CLK_TCK };
    } catch {
        return null;
    }
}

/** `treeBytes` sums regular-file sizes under `dir` and returns `null` if reading `dir` fails. */
export function treeBytes(dir: string): number | null {
    let total = 0;
    let readable = true;
    const walk = (d: string) => {
        let names: string[] = [];
        try {
            names = readdirSync(d);
        } catch {
            if (d === dir) readable = false;
            return;
        }
        for (const name of names) {
            const p = join(d, name);
            try {
                const st = lstatSync(p);
                if (st.isDirectory()) walk(p);
                else if (st.isFile()) total += st.size;
            } catch {
                // The scan skips entries removed between readdir and lstat.
            }
        }
    };
    walk(dir);
    return readable ? total : null;
}

export interface Sample {
    wall_ms: number;
    scenario_ms: number;
    pid: number | null;
    rss: number | null;
    cpu_ms: number | null;
    cpu_fraction: number | null;
    store_bytes: number | null;
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
            /** Receives a failed interval sample; the timer stops first. Absent, the failure throws. */
            onError?: (caught: unknown) => void;
        },
    ) {
        if (!existsSync(o.path)) return;
        const text = readFileSync(o.path, "utf8");
        const complete = text.lastIndexOf("\n") + 1;
        if (complete < text.length)
            truncateSync(o.path, Buffer.byteLength(text.slice(0, complete)));
    }

    sample(): Sample {
        const pid = this.o.pid();
        const stats = pid === null ? null : procStats(pid);
        const wall = Date.now();
        let fraction: number | null = null;
        if (stats && this.last?.pid === pid && wall > this.last.wall) {
            fraction = (stats.cpuMs - this.last.cpu) / (wall - this.last.wall);
        }
        this.last = stats && pid !== null ? { pid, wall, cpu: stats.cpuMs } : null;
        const busy = fraction === null ? this.busy : fraction > this.o.busyFraction;
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

    /** `start` takes a baseline sample, so the first interval sample yields a CPU fraction. */
    start(): void {
        if (this.timer) return;
        this.sample();
        this.timer = setInterval(() => {
            try {
                this.sample();
            } catch (caught) {
                if (!this.o.onError) throw caught;
                this.stop();
                this.o.onError(caught);
            }
        }, this.o.intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.busy) this.o.onBusy(false);
        this.busy = false;
    }
}
