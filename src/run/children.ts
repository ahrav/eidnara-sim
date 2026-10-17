import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { killOwnedTree } from "./procs";

export const SIGTERM_EXIT = 143;

const groupAlive = (pid: number): boolean => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
};

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
    /** Each live child with the promise that settles once its run has finished. */
    private readonly live = new Map<ChildProcess, Promise<void>>();
    private stopping = false;

    constructor(
        private readonly env: NodeJS.ProcessEnv,
        private readonly graceMs = 60_000,
        private readonly pollMs = 1_000,
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
            let settledRun: () => void = () => undefined;
            this.live.set(
                child,
                new Promise<void>((r) => {
                    settledRun = r;
                }),
            );
            // A log the command cannot write ends the child and settles the run as a failure,
            // instead of throwing out of the stream callback past the supervisor.
            const sink = (chunk: Buffer) => {
                try {
                    appendFileSync(log, chunk);
                } catch (caught) {
                    console.error(`${log}: ${(caught as Error).message}`);
                    kill(child);
                    finish(127);
                }
            };
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
            let settled = false;
            const finish = (code: number) => {
                if (settled) return;
                settled = true;
                if (poll) clearInterval(poll);
                for (const t of timers) clearTimeout(t);
                this.live.delete(child);
                settledRun();
                done(code);
            };
            // The run tears its own tree down before it exits, so the process group is killed
            // on every exit and the run settles once the group is gone; a survivor past the
            // grace period is named in the log.
            const settle = async (code: number) => {
                const pid = child.pid;
                if (pid !== undefined) {
                    kill(child);
                    const deadline = Date.now() + this.graceMs;
                    while (groupAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
                    if (groupAlive(pid)) {
                        appendFileSync(log, `process group ${pid} survived SIGKILL\n`);
                    }
                }
                finish(code);
            };
            child.on("error", (e) => {
                appendFileSync(log, `spawn failed: ${e.message}\n`);
                finish(127);
            });
            child.on("exit", (code, signal) => {
                void settle(code ?? 128 + (signal ? (constants.signals[signal] ?? 9) : 9));
            });
        });
    }

    /** Signals every live child, SIGKILLs any still live after `graceMs`, and spawns no more. */
    async stopAll(signal: NodeJS.Signals): Promise<void> {
        this.stopping = true;
        const sent = signal === "SIGHUP" ? "SIGTERM" : signal;
        const children = [...this.live.keys()];
        const exits = children.map((child) => this.live.get(child) as Promise<void>);
        for (const child of children) child.kill(sent);
        const backstop = setTimeout(() => {
            for (const child of children) kill(child);
        }, this.graceMs);
        await Promise.all(exits);
        clearTimeout(backstop);
    }
}
