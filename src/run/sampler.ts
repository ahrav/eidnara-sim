import {
    appendFileSync,
    existsSync,
    lstatSync,
    readdirSync,
    readFileSync,
    truncateSync,
} from "node:fs";
import { join } from "node:path";
import { keepCompleteLines } from "./journal";

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

let pageSize: number | null = null;

/** The host's memory page size in bytes, the unit `/proc/<pid>/stat` counts RSS in; read once from `getconf`. */
export function pageBytes(): number {
    if (pageSize === null) {
        const got = Number(Bun.spawnSync(["getconf", "PAGESIZE"]).stdout.toString().trim());
        pageSize = Number.isInteger(got) && got > 0 ? got : 4096;
    }
    return pageSize;
}

/** One `/proc/<pid>/stat` read: RSS in bytes, CPU time, and the process start time that names the lifetime. */
export function procStats(pid: number): { rss: number; cpuMs: number; start: string } | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        const rssKb = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
        if (!rssKb) return null;
        return {
            rss: Number(rssKb[1]) * 1024,
            cpuMs: (ticks * 1000) / CLK_TCK,
            start: fields[19] ?? "",
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
    /** The daemon's process start time, so two lifetimes sharing a reused pid stay apart. */
    start: string | null;
    rss: number | null;
    heap?: number | null;
    cpu_ms: number | null;
    cpu_fraction: number | null;
    store_bytes: number | null;
}

export class ResourceSampler {
    private timer: ReturnType<typeof setInterval> | null = null;
    /**
     * The CPU baseline names the process lifetime it was read from, so a reused pid with a new
     * start begins afresh, and its monotonic time, so a wall-clock step cannot distort the CPU
     * fraction.
     */
    private last: { pid: number; start: string; mono: number; cpu: number } | null = null;
    private busy = false;

    constructor(
        private readonly o: {
            path: string;
            intervalMs: number;
            busyFraction: number;
            pid: () => number | null;
            /** Reads a process's /proc snapshot; defaults to procStats. */
            stats?: (pid: number) => ReturnType<typeof procStats>;
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

    sample(transitions = true): Sample {
        const pid = this.o.pid();
        const stats = pid === null ? null : (this.o.stats ?? procStats)(pid);
        const wall = Date.now();
        const mono = performance.now();
        let fraction: number | null = null;
        const sameLife = this.last?.pid === pid && this.last?.start === stats?.start;
        if (stats && this.last && sameLife && mono > this.last.mono) {
            fraction = (stats.cpuMs - this.last.cpu) / (mono - this.last.mono);
        }
        this.last =
            stats && pid !== null ? { pid, start: stats.start, mono, cpu: stats.cpuMs } : null;
        const busy = fraction === null ? this.busy : fraction > this.o.busyFraction;
        if (transitions && busy !== this.busy) {
            this.busy = busy;
            this.o.onBusy(busy);
        }
        const s: Sample = {
            wall_ms: wall,
            scenario_ms: this.o.scenarioMs(),
            pid: stats ? pid : null,
            start: stats?.start ?? null,
            rss: stats?.rss ?? null,
            heap: pid === null ? null : anonBytes(pid),
            cpu_ms: stats?.cpuMs ?? null,
            cpu_fraction: fraction === null ? null : Math.round(fraction * 1e4) / 1e4,
            store_bytes: treeBytes(this.o.storeDir),
        };
        appendFileSync(this.o.path, `${JSON.stringify(s)}\n`);
        return s;
    }

    /**
     * The first sample is taken at once, so RSS(0) precedes any session's work and the first
     * interval sample yields a CPU fraction; a line a kill cut goes first.
     */
    start(): void {
        if (this.timer) return;
        keepCompleteLines(this.o.path);
        this.sample();
        this.timer = setInterval(() => {
            try {
                this.sample();
            } catch (caught) {
                if (!this.o.onError) throw caught;
                try {
                    this.stop();
                } catch {
                    this.busy = false;
                }
                this.o.onError(caught);
            }
        }, this.o.intervalMs);
    }

    /** Takes a sample now: the first one when sampling has yet to start, an extra one otherwise. */
    observe(): void {
        if (this.timer) this.sample();
        else this.start();
    }

    /**
     * `stop` reports a busy sampler idle, so no job outlives the arm. A running sampler then
     * takes a final sample before its timer goes, so the last interval's growth is on record;
     * that sample reports no busy transition. A final sample that cannot be written throws
     * after the timer and busy state are cleared; the caller shuts the arm down in a `finally`
     * and the error keeps the run from ending as complete evidence.
     */
    stop(): void {
        const running = this.timer !== null;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        const wasBusy = this.busy;
        this.busy = false;
        if (wasBusy) this.o.onBusy(false);
        if (running) this.sample(false);
    }
}
