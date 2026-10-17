import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { killOwnedTree } from "./procs";

export const SIGTERM_EXIT = 143;

/** SIGKILL for the child's process group and for every owned descendant the process tree shows. */
const kill = (child: ChildProcess) => {
    if (child.pid === undefined) return;
    killOwnedTree(child.pid);
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch (caught) {
        if ((caught as { code?: string }).code !== "ESRCH") throw caught;
    }
};

/**
 * When `limitMs` expires, or `stopWhen` holds at one of its checks every `pollMs`, a child gets
 * SIGTERM, then SIGKILL after `graceMs` if it is still live, which bounds a stalled teardown.
 * `onStop` receives the cause of a stop this run issued; a signal from outside issues none.
 */
export type StopReason = "limit" | "stopWhen";

export class Children {
    private readonly live = new Set<ChildProcess>();
    private stopping = false;

    constructor(
        private readonly env: NodeJS.ProcessEnv,
        private readonly graceMs = 60_000,
        private readonly pollMs = 30_000,
    ) {}

    run(
        argv: string[],
        log: string,
        limitMs?: number,
        stopWhen?: () => boolean,
        onStop?: (reason: StopReason) => void,
    ): Promise<number> {
        if (this.stopping) return Promise.resolve(SIGTERM_EXIT);
        return new Promise<number>((done) => {
            const child = spawn("bun", argv, {
                env: this.env,
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
            });
            this.live.add(child);
            const sink = (chunk: Buffer) => appendFileSync(log, chunk);
            child.stdout?.on("data", sink);
            child.stderr?.on("data", sink);
            const timers: ReturnType<typeof setTimeout>[] = [];
            let stopping = false;
            const stop = (reason: StopReason) => {
                if (stopping) return;
                stopping = true;
                onStop?.(reason);
                child.kill("SIGTERM");
                timers.push(setTimeout(() => kill(child), this.graceMs));
            };
            if (limitMs !== undefined && limitMs > 0)
                timers.push(setTimeout(() => stop("limit"), limitMs));
            const poll = stopWhen
                ? setInterval(() => stopWhen() && stop("stopWhen"), this.pollMs)
                : null;
            const finish = (code: number) => {
                if (poll) clearInterval(poll);
                for (const t of timers) clearTimeout(t);
                this.live.delete(child);
                done(code);
            };
            child.on("error", (e) => {
                appendFileSync(log, `spawn failed: ${e.message}\n`);
                finish(127);
            });
            child.on("exit", (code, signal) =>
                finish(code ?? 128 + (signal ? (constants.signals[signal] ?? 9) : 9)),
            );
        });
    }

    /** Signals every live child, SIGKILLs any still live after `graceMs`, and spawns no more. */
    async stopAll(signal: NodeJS.Signals): Promise<void> {
        this.stopping = true;
        const sent = signal === "SIGHUP" ? "SIGTERM" : signal;
        const children = [...this.live];
        const exits = children.map(
            (child) => new Promise<void>((done) => child.once("close", () => done())),
        );
        for (const child of children) child.kill(sent);
        const backstop = setTimeout(() => {
            for (const child of children) kill(child);
        }, this.graceMs);
        await Promise.all(exits);
        clearTimeout(backstop);
    }
}
