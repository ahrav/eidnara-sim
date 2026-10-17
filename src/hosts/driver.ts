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
    upgraded?: boolean;
    second?: { pid: number; start: string | null } | null;
    /** Daemon restarts whose post-crash store check is still owed. */
    store_faults?: string[];
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
    /** The host's pinned and `config.upgrade` versions, as the run's preflight recorded them. */
    hostVersions?: { from: string; to: string | null };
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
    "host_upgrade",
    "two_hosts_one_daemon",
]);

const SECOND_CLIENT_PROMPT = "List the top-level files in this repository and stop.";

export class HostDriver implements ArmDriver {
    host: SimHost | null = null;
    daemon: DaemonStack | null = null;
    private model = 0;
    private storeMount: string | null = null;
    private sessionProject: string | null = null;
    private transcriptsChecked = false;

    private readonly snapshots: SnapshotRecorder;
    private upgraded = false;
    private second: SimHost | null = null;
    /** A host open or daemon restart still in flight, which `stop` awaits before closing either. */
    private inflight: Promise<void> | null = null;
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
        const up = this.upgraded ? (this.o.config.upgrade ?? {}) : {};
        const config = { ...this.o.config, ...up };
        return make({
            ...this.o,
            config,
            arm,
            keep,
            root: this.o.armRoot,
            model: this.currentModel(),
        });
    }

    private recordState(): void {
        const proc = (pid: number | null) =>
            pid === null ? null : { pid, start: processStart(pid) };
        const state: ArmState = {
            model: this.model,
            upgraded: this.upgraded,
            daemon: proc(this.daemonPid()),
            host: proc(this.sessionProject === null ? null : (this.host?.hostPid() ?? null)),
            second: proc(this.second?.hostPid() ?? null),
            store_faults: this.storeFaults,
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
        this.upgraded = false;
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
        const state = this.readState();
        this.model = state?.model ?? 0;
        this.upgraded = state?.upgraded ?? false;
        this.storeFaults = state?.store_faults ?? [];
        const checked = join(this.armDir, "transcripts.json");
        this.transcriptsChecked =
            existsSync(checked) && JSON.parse(readFileSync(checked, "utf8")).missing.length === 0;
        await this.reapStale();
        await this.startArm(false);
        if (open) await this.event(open);
    }

    private async reapStale(): Promise<void> {
        const state = this.readState();
        for (const proc of [state?.daemon, state?.host, state?.second]) {
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
        await this.open(host, dir, e.session, connection);
        this.snapshots.sessionStart(e.session, this.sessionProject, dir);
        this.recordState();
    }

    private async open(
        host: SimHost,
        dir: string,
        session: string,
        connection: string | null,
    ): Promise<void> {
        await this.track(host.openSession(dir, session, connection));
    }

    private async track<T>(pending: Promise<T>): Promise<T> {
        this.inflight = pending.then(
            () => undefined,
            () => undefined,
        );
        try {
            return await pending;
        } finally {
            this.inflight = null;
        }
    }

    async event(e: ScenarioEvent): Promise<TurnOutcome> {
        const host = this.requireHost();
        if (e.kind === "session_start") {
            await this.openSession(e, host);
            return {};
        }
        if (e.kind === "session_end") {
            this.requireSecondAttached();
            const project = this.project(e);
            this.snapshots.addTools(host.drainTools(), null);
            this.snapshots.sessionEnd(project, this.workspace(project));
            await host.closeSession();
            await this.closeSecond();
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
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs, interruptMs);
        if (this.daemon && this.daemonPid() === null) this.o.onDaemonExit({ after: e.id });
        const tools = host.drainTools();
        this.snapshots.addTools(tools, e.id);
        const outcome: TurnOutcome = result.interrupted ? { user: { interrupted: true } } : {};
        if (result.error) outcome.failed = result.error;
        if (this.storeFaults.length > 0 && this.daemon) {
            const store = checkStore(this.storeDb);
            outcome.stores = this.storeFaults.map((fault) => ({ fault, store }));
            this.storeFaults = [];
            this.recordState();
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

    async fault(f: FaultEpisode, at?: ScenarioEvent): Promise<Record<string, unknown>> {
        if (!SUPPORTED.has(f.type))
            throw new HarnessFailure(`fault type ${f.type} has no mechanism`);
        if (f.type === "daemon_sigkill_mid_fold" || f.type === "daemon_restart") {
            if (!this.daemon) return { skipped: "arm runs no daemon" };
            const before = this.daemonPid();
            await this.track(this.daemon.restart());
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
        if (f.type === "host_upgrade") return this.upgradeHost();
        if (f.type === "two_hosts_one_daemon") return this.secondClient(at);
        this.model++;
        this.host = this.newHost();
        this.recordState();
        return { model: this.currentModel() };
    }

    private upgradeHost(): Record<string, unknown> {
        const host = this.o.host;
        const field = host === "pi" ? "pi_install" : "opencode_binary";
        const next = this.o.config.upgrade?.[field];
        if (!next)
            return { skipped: `no next ${host} version is configured (config.upgrade.${field})` };
        const from_version = this.o.hostVersions?.from ?? null;
        const to_version = this.o.hostVersions?.to ?? null;
        this.upgraded = true;
        this.host = this.newHost();
        this.recordState();
        return {
            host,
            from: this.o.config[field],
            to: next,
            from_version,
            to_version,
            takes_effect: "next session_start",
        };
    }

    private async closeSecond(record = true): Promise<void> {
        const second = this.second;
        this.second = null;
        if (!second) return;
        await this.releaseSecond(second);
        if (record) this.recordState();
    }

    private async releaseSecond(second: SimHost): Promise<void> {
        this.snapshots.addTools(second.drainTools(), null);
        await second.closeSession();
    }

    /** A second client's host process must still run at the primary session's `session_end`. */
    private requireSecondAttached(): void {
        if (!this.second) return;
        const pid = this.second.hostPid();
        if (pid === null || !running(pid)) {
            throw new HarnessFailure(
                `the second client exited before the primary session's session_end (pid ${pid})`,
            );
        }
    }

    private async secondClient(at?: ScenarioEvent): Promise<Record<string, unknown>> {
        if (!this.daemon) return { skipped: "arm runs no daemon" };
        if (!at || at.kind !== "session_start") {
            throw new HarnessFailure("two_hosts_one_daemon fires at a session_start");
        }
        const second = this.newHost();
        const session = `${at.session}-b`;
        this.second = second;
        try {
            await this.open(
                second,
                this.workspace(this.project(at)),
                session,
                this.daemon.connectionFile,
            );
            if (this.second !== second) {
                await second.closeSession();
                throw new HarnessFailure("the arm stopped while the second client opened");
            }
            this.recordState();
            const result = await second.prompt(SECOND_CLIENT_PROMPT, this.o.turnDeadlineMs);
            this.snapshots.addTools(second.drainTools(), session);
            return {
                second_session: session,
                second_host_pid: second.hostPid(),
                daemon_pid: this.daemonPid(),
                outcome: result.error ?? "ok",
                attached_until: "the primary session's session_end, or the run's stop",
            };
        } catch (caught) {
            await this.closeSecond().catch(() => undefined);
            throw caught;
        }
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
            return await deleteFactNotes(this.storeDb, statement, others);
        } catch (caught) {
            return { skipped: `deletion failed: ${String(caught).slice(0, 300)}` };
        }
    }

    get storeDb(): string {
        return join(this.dataDir, "eidnara", "context", "store.db");
    }

    async finish(): Promise<void> {
        await this.stop(true);
    }

    async stop(checkFinalStore = false): Promise<void> {
        const host = this.host;
        const daemon = this.daemon;
        const second = this.second;
        this.host = null;
        this.daemon = null;
        this.second = null;
        await this.inflight;
        let failure: unknown = null;
        const closeSecond = () => (second ? this.releaseSecond(second) : undefined);
        for (const close of [() => host?.closeSession(), closeSecond]) {
            try {
                await close();
            } catch (caught) {
                failure ??= caught;
            }
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
