import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CallView } from "../grade/artefacts";
import { processStart, running, stopOwnedTree } from "../run/procs";
import {
    type ArmDriver,
    HarnessFailure,
    type ScenarioEvent,
    type TurnOutcome,
} from "../run/scheduler";
import type { FaultEpisode } from "../scenario/faults";
import { armBase, DaemonStack, eidnaraOn, type HostContext, makeHost, type SimHost } from "./arms";
import { SnapshotRecorder } from "./snapshot";
import { checkStore, type Deletion, deleteFactNotes, memoryNotes } from "./storecheck";

interface ArmState {
    model: number;
    daemon: { pid: number; start: string | null } | null;
    host: { pid: number; start: string | null } | null;
}

export interface DriverOptions extends Omit<HostContext, "root" | "model" | "arm"> {
    /** The arm's label; `armBase` gives the arm it runs as. */
    arm: string;
    armRoot: string;
    projects: Record<string, string>;
    models: string[];
    turnDeadlineMs: number;
    transcriptPaths: string[];
    loopStore: boolean;
    callsFor?: (session: string) => CallView[];
    hostFactory?: (ctx: HostContext) => SimHost;
    onDaemonExit: (detail: Record<string, unknown>) => void;
}

const git = (cwd: string, ...args: string[]) => {
    const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "sim-user",
        GIT_AUTHOR_EMAIL: "sim-user@users.noreply.github.com",
        GIT_COMMITTER_NAME: "sim-user",
        GIT_COMMITTER_EMAIL: "sim-user@users.noreply.github.com",
    };
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
};

function run(argv: string[]): string {
    const r = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${argv.join(" ")}: ${r.error ?? r.stderr}`);
    return r.stdout;
}

export function expandTemplate(template: string, env: Record<string, string>): string {
    return template.replace(/^\$([A-Z_]+)/, (_, name: string) => {
        const value = env[name];
        if (value === undefined) throw new Error(`transcript path ${template}: ${name} unset`);
        return value;
    });
}

const SUPPORTED = new Set([
    "daemon_sigkill_mid_fold",
    "daemon_restart",
    "store_full",
    "plugin_reload",
    "model_switch",
]);

export class HostDriver implements ArmDriver {
    host: SimHost | null = null;
    daemon: DaemonStack | null = null;
    private model = 0;
    private storeMount: string | null = null;
    private sessionProject: string | null = null;
    private transcriptsChecked = false;

    private readonly snapshots: SnapshotRecorder;
    /** Daemon restarts that the end of the current or next turn owes a store check. */
    private storeFaults: string[] = [];

    constructor(private readonly o: DriverOptions) {
        this.snapshots = new SnapshotRecorder(dirname(o.armRoot), o.arm, o.callsFor ?? (() => []));
    }

    get armDir(): string {
        return dirname(this.o.armRoot);
    }

    get storeRoot(): string {
        return join(this.armDir, "s");
    }

    get dataDir(): string {
        return join(this.storeRoot, "d");
    }

    private get image(): string {
        return join(this.armDir, "store.img");
    }

    private get stateFile(): string {
        return join(this.armDir, "state.json");
    }

    workspace(project: string): string {
        return join(this.o.armRoot, "workspaces", project);
    }

    daemonPid(): number | null {
        return this.daemon?.pid() ?? null;
    }

    private requireHost(): SimHost {
        if (!this.host)
            throw new HarnessFailure(`arm ${this.o.arm} has no host; reset or resume first`);
        return this.host;
    }

    private currentModel(): string {
        return this.o.models[this.model % this.o.models.length] as string;
    }

    private newHost(): SimHost {
        const make = this.o.hostFactory ?? makeHost;
        const arm = armBase(this.o.arm);
        const keep = eidnaraOn(arm) ? [...this.o.keep, this.storeRoot] : this.o.keep;
        return make({ ...this.o, arm, keep, root: this.o.armRoot, model: this.currentModel() });
    }

    private recordState(): void {
        const proc = (pid: number | null) =>
            pid === null ? null : { pid, start: processStart(pid) };
        const state: ArmState = {
            model: this.model,
            daemon: proc(this.daemonPid()),
            host: proc(this.sessionProject === null ? null : (this.host?.hostPid() ?? null)),
        };
        mkdirSync(this.armDir, { recursive: true });
        writeFileSync(this.stateFile, JSON.stringify(state));
    }

    private readState(): ArmState | null {
        if (!existsSync(this.stateFile)) return null;
        return JSON.parse(readFileSync(this.stateFile, "utf8")) as ArmState;
    }

    private async startArm(fresh: boolean): Promise<void> {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (this.o.loopStore && eidnaraOn(armBase(this.o.arm))) this.mountStore(fresh);
        if (eidnaraOn(armBase(this.o.arm))) {
            this.daemon = new DaemonStack({
                ...this.o,
                root: this.o.armRoot,
                dataDir: this.dataDir,
                logFile: join(this.armDir, "daemon.log"),
                model: this.o.sideModel ?? this.currentModel(),
            });
            await this.daemon.start();
            this.recordState();
        }
        this.host = this.newHost();
        this.recordState();
    }

    async reset(): Promise<void> {
        await this.stop();
        this.model = 0;
        this.snapshots.clear();
        await this.reapStale();
        for (const dir of [this.o.armRoot, this.storeRoot])
            rmSync(dir, { recursive: true, force: true });
        rmSync(this.image, { force: true });
        mkdirSync(join(this.o.armRoot, "workspaces"), { recursive: true });
        for (const [project, source] of Object.entries(this.o.projects)) {
            const target = this.workspace(project);
            git(this.o.armRoot, "clone", "--quiet", "--no-hardlinks", source, target);
        }
        await this.startArm(true);
    }

    async resume(open: ScenarioEvent | null): Promise<void> {
        this.model = this.readState()?.model ?? 0;
        const checked = join(this.armDir, "transcripts.json");
        this.transcriptsChecked =
            existsSync(checked) && JSON.parse(readFileSync(checked, "utf8")).missing.length === 0;
        await this.reapStale();
        await this.startArm(false);
        if (open) await this.event(open);
    }

    private async reapStale(): Promise<void> {
        const state = this.readState();
        for (const proc of [state?.daemon, state?.host]) {
            if (proc && running(proc.pid) && processStart(proc.pid) === proc.start) {
                await stopOwnedTree(proc.pid, 5_000);
            }
        }
        if (spawnSync("findmnt", ["-n", "-M", this.storeRoot]).status === 0) {
            run(["sudo", "-n", "umount", this.storeRoot]);
        }
    }

    private async openSession(e: ScenarioEvent, host: SimHost): Promise<void> {
        this.sessionProject = this.project(e);
        const connection = this.daemon?.connectionFile ?? null;
        const dir = this.workspace(this.sessionProject);
        await host.openSession(dir, e.session, connection);
        this.snapshots.sessionStart(e.session, this.sessionProject, dir);
        this.recordState();
    }

    async event(e: ScenarioEvent): Promise<TurnOutcome> {
        const host = this.requireHost();
        if (e.kind === "session_start") {
            await this.openSession(e, host);
            return {};
        }
        if (e.kind === "session_end") {
            const project = this.project(e);
            this.snapshots.addTools(host.drainTools(), null);
            this.snapshots.sessionEnd(project, this.workspace(project));
            await host.closeSession();
            this.clearStoreFill();
            this.sessionProject = null;
            this.recordState();
            if (!this.transcriptsChecked) this.checkTranscripts(host);
            return {};
        }
        if (e.kind === "apply_diff") {
            this.applyDiff(e);
            return {};
        }
        const project = this.project(e);
        const dir = this.workspace(project);
        const before = e.probe ? this.snapshots.tree(dir) : "";
        const interruptMs = typeof e.interrupt_ms === "number" ? e.interrupt_ms : undefined;
        const started = performance.now();
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs, interruptMs);
        const prompt_ms = Math.round(performance.now() - started);
        if (this.daemon && this.daemonPid() === null) this.o.onDaemonExit({ after: e.id });
        const tools = host.drainTools();
        this.snapshots.addTools(tools, e.id);
        const outcome: TurnOutcome = {
            prompt_ms,
            ...(result.interrupted ? { user: { interrupted: true } } : {}),
        };
        if (result.error) outcome.failed = result.error;
        if (this.storeFaults.length > 0 && this.daemon) {
            const store = checkStore(this.storeDb);
            outcome.stores = this.storeFaults.map((fault) => ({ fault, store }));
            this.storeFaults = [];
        }
        if (e.probe) {
            const probe = { probe: e.probe, session: e.session, id: e.id };
            outcome.snapshot = this.snapshots.capture(
                probe,
                project,
                dir,
                before,
                tools,
                !!result.error,
            );
        }
        return outcome;
    }

    private project(e: ScenarioEvent): string {
        const project = e.project ?? this.sessionProject;
        if (typeof project !== "string") throw new HarnessFailure(`event ${e.id} names no project`);
        return project;
    }

    private applyDiff(e: ScenarioEvent): void {
        const dir = realpathSync(this.workspace(this.project(e)));
        const path = resolve(dir, String(e.path));
        mkdirSync(dirname(path), { recursive: true });
        const parent = realpathSync(dirname(path));
        const inside = parent === dir || parent.startsWith(`${dir}/`);
        if (!inside || lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
            throw new HarnessFailure(`apply_diff path ${String(e.path)} leaves ${dir}`);
        }
        writeFileSync(path, String(e.content));
        git(dir, "add", "--", path);
        if (
            spawnSync("git", ["diff", "--cached", "--quiet", "--", path], { cwd: dir }).status === 0
        ) {
            return;
        }
        git(dir, "commit", "--quiet", "--no-verify", "-m", `Add ${String(e.path)}`, "--", path);
    }

    private checkTranscripts(host: SimHost): void {
        const env = host.transcriptEnv();
        const paths = this.o.transcriptPaths.map((t) => expandTemplate(t, env));
        const missing = paths.filter((p) => !existsSync(p));
        const record = { checked_after: "first session_end", paths, missing };
        writeFileSync(join(this.armDir, "transcripts.json"), JSON.stringify(record));
        if (missing.length > 0) throw new Error(`transcript store missing: ${missing.join(", ")}`);
        this.transcriptsChecked = true;
    }

    async fault(f: FaultEpisode): Promise<Record<string, unknown>> {
        if (!SUPPORTED.has(f.type))
            throw new HarnessFailure(`fault type ${f.type} has no mechanism`);
        if (f.type === "daemon_sigkill_mid_fold" || f.type === "daemon_restart") {
            if (!this.daemon) return { skipped: "arm runs no daemon" };
            const before = this.daemonPid();
            await this.daemon.restart();
            this.storeFaults.push(f.id);
            this.recordState();
            const after = this.daemonPid();
            return {
                signal: "SIGKILL",
                pid_before: before,
                pid_after: after,
                restarted_by: "harness",
                store: checkStore(this.storeDb),
            };
        }
        if (f.type === "store_full") return this.fillStore();
        if (this.sessionProject !== null) {
            throw new HarnessFailure(`${f.type} fires between sessions; ${f.id} fired inside one`);
        }
        if (f.type === "plugin_reload") {
            return { reload: "host process and plugin respawn at the next session_start" };
        }
        this.model++;
        this.host = this.newHost();
        this.recordState();
        return { model: this.currentModel() };
    }

    private mountStore(fresh: boolean): void {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (fresh || !existsSync(this.image)) {
            run(["truncate", "-s", "2G", this.image]);
            run(["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", this.image]);
        }
        const options = "loop,nosuid,nodev,noexec";
        run(["sudo", "-n", "mount", "-o", options, this.image, this.storeRoot]);
        this.storeMount = this.storeRoot;
        run(["sudo", "-n", "chown", `${process.getuid?.()}:${process.getgid?.()}`, this.storeRoot]);
        run(["sudo", "-n", "chmod", "0700", this.storeRoot]);
    }

    private fillStore(): Record<string, unknown> {
        if (!this.storeMount) return { skipped: "arm runs no loop-mounted store" };
        const ballast = join(this.storeMount, "ballast");
        spawnSync("dd", ["if=/dev/zero", `of=${ballast}`, "bs=1M", "count=4096"]);
        const df = run(["df", "--output=avail", this.storeMount]);
        const avail = Number(df.trim().split("\n").at(-1));
        if (avail !== 0) throw new HarnessFailure(`store_full left ${avail} KiB free`);
        return { mount: this.storeMount, avail_kb: avail };
    }

    private clearStoreFill(): void {
        if (this.storeMount) rmSync(join(this.storeMount, "ballast"), { force: true });
    }

    async deleteFact(
        statement: string,
        others: readonly string[] = [],
    ): Promise<Deletion | { skipped: string }> {
        if (!this.daemon) return { skipped: "arm runs no daemon" };
        if (!existsSync(this.storeDb)) return { skipped: "no store yet" };
        try {
            return await deleteFactNotes(this.storeDb, statement, others, (child) => {
                this.deleting = child;
                void child.exited.finally(() => {
                    if (this.deleting === child) this.deleting = null;
                });
            });
        } catch (caught) {
            return { skipped: `deletion failed: ${String(caught).slice(0, 300)}` };
        }
    }

    private deleting: ReturnType<typeof Bun.spawn> | null = null;

    get storeDb(): string {
        return join(this.dataDir, "eidnara", "context", "store.db");
    }

    async finish(): Promise<void> {
        await this.stop(true);
    }

    async stop(checkFinalStore = false): Promise<void> {
        const host = this.host;
        const daemon = this.daemon;
        this.host = null;
        this.daemon = null;
        const deleting = this.deleting;
        if (deleting) {
            deleting.kill();
            await deleting.exited;
        }
        let failure: unknown = null;
        try {
            await host?.closeSession();
        } catch (caught) {
            failure = caught;
        }
        try {
            await daemon?.stop();
            if (daemon && checkFinalStore) {
                const check = checkStore(this.storeDb);
                writeFileSync(join(this.armDir, "store-check.json"), `${JSON.stringify(check)}\n`);
                const notes = memoryNotes(this.storeDb);
                writeFileSync(join(this.armDir, "memory.json"), `${JSON.stringify(notes)}\n`);
            }
        } catch (caught) {
            failure ??= caught;
        }
        if (this.storeMount) {
            const r = spawnSync("sudo", ["-n", "umount", this.storeMount], { encoding: "utf8" });
            if (r.status === 0) this.storeMount = null;
            else failure ??= new Error(`umount ${this.storeMount}: ${r.stderr}`);
        }
        if (failure) throw failure;
    }
}
