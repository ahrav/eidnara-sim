import { spawn, spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { launch } from "../run/launcher";
import { processStart, running, stopOwnedTree } from "../run/procs";
import { type ArmDriver, HarnessFailure, type ScenarioEvent } from "../run/scheduler";
import { SYSTEM_PATH } from "../run/toolchain";
import { transcriptKind } from "../run/transcripts";
import type { FaultEpisode } from "../scenario/faults";
import {
    type DaemonContext,
    DaemonStack,
    eidnaraOn,
    type HostContext,
    hostNode,
    makeHost,
    opencodeInstall,
    type PromptResult,
    readOnlyPaths,
    type SimHost,
} from "./arms";

interface ArmState {
    model: number;
    daemon: { pid: number; start: string | null } | null;
    host: { pid: number; start: string | null } | null;
    /** The store_full ballast while the fault is active: its length, the blocks it holds, and its fault. */
    ballast: { bytes: number; blocks: number; fault?: string } | null;
    /** True while a resume has removed the ballast and has yet to fill the store again. */
    refilling: boolean;
    /** The sandboxed git run of an apply_diff in flight, with the workspace it holds. */
    git: { pid: number; start: string | null; project: string } | null;
    /** The message of a `finish` that failed; a resume refuses the arm while it stands. */
    failed: string | null;
    /** The latest model switch: its fault and the index it left, so an unobserved one rolls back. */
    switched?: { fault: string; from: number } | null;
}

export interface DriverOptions extends Omit<HostContext, "root" | "model"> {
    armRoot: string;
    projects: Record<string, string>;
    models: string[];
    turnDeadlineMs: number;
    transcriptPaths: string[];
    loopStore: boolean;
    /** Wall time of scenario time 0, the same value the clock offset targets. */
    baseMs: number;
    hostFactory?: (ctx: HostContext) => SimHost;
    daemonFactory?: (ctx: DaemonContext) => DaemonStack;
    onDaemonExit: (detail: Record<string, unknown>) => void;
}

const GIT_ENV = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "sim-user",
    GIT_AUTHOR_EMAIL: "sim-user@users.noreply.github.com",
    GIT_COMMITTER_NAME: "sim-user",
    GIT_COMMITTER_EMAIL: "sim-user@users.noreply.github.com",
    TZ: "UTC",
};

/** Clones from a harness-owned source into a fresh workspace run with the harness's own view. */

/**
 * The rename publishes a complete file, so a kill mid-write leaves the previous one. The staged
 * file is created exclusively, so a link planted at its name is removed, never written through.
 */
function writeWhole(path: string, text: string): void {
    const staged = `${path}.${process.pid}`;
    rmSync(staged, { force: true });
    writeFileSync(staged, text, { flag: "wx" });
    renameSync(staged, path);
}

/** `path` resolves to `parent/name` through real directories only; a planted symlink stops the run. */
function realChild(parent: string, name: string, what: string): string {
    const path = join(parent, name);
    if (!existsSync(path)) return path;
    const real = realpathSync(path);
    if (real !== join(realpathSync(parent), name)) {
        throw new HarnessFailure(`${what} ${path} leaves ${parent}`);
    }
    return real;
}

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

const BETWEEN_SESSIONS = new Set(["daemon_restart", "plugin_reload", "model_switch", "store_full"]);

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
    private ballastShape: ArmState["ballast"] = null;
    private refilling = false;
    private gitRun: ArmState["git"] = null;
    private failed: string | null = null;
    /** The identity the daemon's pid had when it started, so a later exit shows as one. */
    private daemonId: { pid: number; start: string | null } | null = null;
    private switched: { fault: string; from: number } | null = null;
    /** True once this process has reset or resumed the arm, so its in-memory state is the arm's. */
    private live = false;
    private sessionProject: string | null = null;
    private transcriptsChecked = false;

    constructor(private readonly o: DriverOptions) {}

    private get armDir(): string {
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

    /** The daemon lives while the pid its stack holds still names the process that started there. */
    private daemonAlive(): boolean {
        const pid = this.daemonPid();
        if (pid === null) return false;
        const start = this.procStart(pid);
        if (start === null) return false;
        return this.daemonId?.pid !== pid || this.daemonId.start === start;
    }

    private noteDaemon(): void {
        const pid = this.daemonPid();
        this.daemonId = pid === null ? null : { pid, start: this.procStart(pid) };
    }

    private procStart(pid: number): string | null {
        return (this.o.procStart ?? processStart)(pid);
    }

    private requireHost(): SimHost {
        if (!this.host)
            throw new HarnessFailure(`arm ${this.o.arm} has no host; reset or resume first`);
        return this.host;
    }

    private currentModel(): string {
        return this.o.models[this.model % this.o.models.length] as string;
    }

    /** The paths the sandbox keeps writable for this arm: the host's, plus the store on Eidnara arms. */
    private get keep(): string[] {
        return eidnaraOn(this.o.arm) ? [...this.o.keep, this.storeRoot] : this.o.keep;
    }

    private newHost(): SimHost {
        const make = this.o.hostFactory ?? makeHost;
        const { keep } = this;
        const onSpawn = () => this.recordState();
        return make({ ...this.o, keep, root: this.o.armRoot, model: this.currentModel(), onSpawn });
    }

    /**
     * Git over an agent-written repository runs inside the arm's sandbox, so a hook, filter, or
     * config the agent planted acts with the host's own view of the filesystem.
     */
    private async git(
        project: string,
        dir: string,
        args: string[],
        dateMs?: number,
    ): Promise<{ status: number; stderr: string }> {
        // Git's home is harness-owned, beside the arm, so a hook writes nothing a host reads.
        const home = join(this.armDir, "git-home");
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const env: Record<string, string> = { ...GIT_ENV, HOME: home };
        if (dateMs !== undefined) {
            env.GIT_AUTHOR_DATE = `@${Math.floor(dateMs / 1000)}`;
            env.GIT_COMMITTER_DATE = env.GIT_AUTHOR_DATE;
        }
        // Git sees the selected workspace and its own home; sibling workspaces, the host's home,
        // and the daemon's store stay masked from repository-controlled hooks and filters.
        const keep = [...new Set([...this.o.keep, dir, home])];
        // Git reads no scenario clock, so the clock directory stays out of its view; the hosts'
        // installs join the set, since a hook could otherwise poison a later session's host.
        const clock = dirname(this.o.offsetFile);
        const resolved = (find: () => string): string | null => {
            try {
                return find();
            } catch {
                return null;
            }
        };
        const installs = [
            this.o.config.pi_install,
            resolved(() => hostNode().root),
            resolved(() => opencodeInstall(this.o.config).root),
        ].filter((p): p is string => p !== null);
        const ro = [...new Set([...readOnlyPaths(this.o), ...installs])].filter(
            (p) => p !== clock && existsSync(p),
        );
        // `timeout` runs inside the sandbox, so the recorded pid execs into the launcher's `sudo`
        // and the reaper's walk starts at the root-owned process, as it does for a host.
        const seconds = String(Math.ceil(this.o.turnDeadlineMs / 1000));
        const bounded = ["timeout", "-s", "KILL", seconds, "git", ...args];
        const argv = launch(this.o.launcher, keep, env, bounded, ro, dir);
        // A hook or filter runs inside this command, so the workspace's .git is checked on both
        // sides of it; one moved out of the workspace stops the run.
        this.requireOwnGitDir(dir);
        // The sandbox resolves `timeout` and `git` on this path after it enters the workspace, so
        // the system path alone is used; the ambient one may name the workspace itself.
        const r = await this.recorded(project, argv, { PATH: SYSTEM_PATH });
        // The record stays until the locks a failed run left are gone and the workspace is
        // checked, so a kill in between still leaves the next reap a run to clean up after.
        if (r.status !== 0) this.unlockGit(dir);
        this.requireOwnGitDir(dir);
        this.releaseGit();
        return { ...r, stderr: r.status === 137 ? `cut off after ${seconds} s` : r.stderr };
    }

    /** Clones a harness-owned source into a fresh workspace with the harness's own view. */
    private async gitClone(project: string, source: string, target: string): Promise<void> {
        const argv = ["git", "clone", "--quiet", "--no-hardlinks", source, target];
        // Ambient GIT_* variables (GIT_DIR, GIT_WORK_TREE, ...) would redirect the clone.
        const inherited = Object.entries(process.env).filter(
            ([key, value]) => !key.startsWith("GIT_") && value !== undefined,
        );
        const env = { ...Object.fromEntries(inherited), ...GIT_ENV } as Record<string, string>;
        const r = await this.recorded(project, argv, env, this.o.armRoot);
        this.releaseGit();
        if (r.status !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`);
    }

    /**
     * Runs a git command whose pid is in `state.json` before the command starts: the shell waits
     * for one line on stdin before it execs, so a harness that dies first closes stdin and the
     * shell exits, and a record that cannot be written ends the shell the same way.
     */
    private async recorded(
        project: string,
        argv: string[],
        env: Record<string, string>,
        cwd?: string,
    ): Promise<{ status: number; stderr: string }> {
        const gated = ["/bin/sh", "-c", 'read _ && exec "$@"', "sh", ...argv];
        const child = spawn(gated[0] as string, gated.slice(1), {
            cwd,
            env,
            stdio: ["pipe", "ignore", "pipe"],
        });
        const pid = child.pid as number;
        const start = this.procStart(pid);
        // The record names the process by pid and start; a start the kernel did not report
        // leaves nothing the next reap could match, so the gated shell ends unreleased.
        this.gitRun = start === null ? null : { pid, start, project };
        try {
            if (start === null) {
                throw new HarnessFailure(`git launch ${pid} for ${project} has no start identity`);
            }
            this.recordState();
        } catch (caught) {
            this.gitRun = null;
            child.stdin?.destroy();
            child.kill("SIGKILL");
            throw caught;
        }
        child.stdin?.end("\n");
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr = `${stderr}${chunk}`.slice(-20_000);
        });
        const status = await new Promise<number>((resolve) => {
            child.once("error", () => resolve(-1));
            child.once("exit", (code, signal) =>
                resolve(code ?? (signal === "SIGKILL" ? 137 : -1)),
            );
        });
        return { status, stderr };
    }

    /** The git run is over and cleaned up after; the record goes. */
    private releaseGit(): void {
        this.gitRun = null;
        this.recordState();
    }

    private async gitOk(project: string, dir: string, args: string[], dateMs?: number) {
        const r = await this.git(project, dir, args, dateMs);
        if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    }

    /** Provider faults belong to the proxy and the sleep to the clock; the rest need a mechanism here. */
    supports(f: FaultEpisode): boolean {
        if (f.seam.layer !== "scheduler") return true;
        return SUPPORTED.has(f.type);
    }

    /** The daemon's directories are host-writable, so every daemon start and restart rechecks them. */
    private checkDaemonDirs(): void {
        realChild(this.armDir, "runtime", "daemon runtime");
        realChild(this.storeRoot, "d", "daemon data");
    }

    /**
     * Bound to itself, the data directory is a mount point, which the host cannot rename or
     * replace while a restart writes under it.
     */
    private pinDataDir(): void {
        mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        if (spawnSync("findmnt", ["-n", "-M", this.dataDir]).status === 0) return;
        run(["sudo", "-n", "mount", "--bind", this.dataDir, this.dataDir]);
    }

    private unmount(path: string): void {
        if (spawnSync("findmnt", ["-n", "-M", path]).status === 0) {
            run(["sudo", "-n", "umount", path]);
        }
    }

    /** The real workspace directory; a symlink the host planted at it or above it stops the run. */
    private workspaceDir(project: string): string {
        const workspaces = realChild(this.o.armRoot, "workspaces", "workspaces");
        return realChild(workspaces, project, `workspace ${project}`);
    }

    private recordState(): void {
        const proc = (pid: number | null) =>
            pid === null ? null : { pid, start: this.procStart(pid) };
        // The daemon's identity is the one captured at its start, so a pid reused after an exit
        // is never recorded as the daemon.
        const daemonPid = this.daemonPid();
        const daemon = this.daemonId?.pid === daemonPid ? this.daemonId : proc(daemonPid);
        // The host's identity is the one its launch captured; a launch the kernel reported no
        // start for is unrecordable, and the host ends it on this failure.
        const host = this.sessionProject === null ? null : (this.host?.hostIdentity() ?? null);
        if (host && host.start === null) {
            throw new HarnessFailure(`host launch ${host.pid} has no start identity`);
        }
        const state: ArmState = {
            model: this.model,
            daemon,
            switched: this.switched,
            host,
            ballast: this.ballastShape,
            refilling: this.refilling,
            git: this.gitRun,
            failed: this.failed,
        };
        mkdirSync(this.armDir, { recursive: true });
        writeWhole(this.stateFile, JSON.stringify(state));
    }

    private readState(): ArmState | null {
        if (!existsSync(this.stateFile)) return null;
        return this.readRecord<ArmState>(this.stateFile);
    }

    /** A harness-owned record that fails to parse names itself, since the arm cannot continue on it. */
    private readRecord<T>(path: string): T {
        try {
            return JSON.parse(readFileSync(path, "utf8")) as T;
        } catch (caught) {
            throw new HarnessFailure(`arm ${this.o.arm}: ${path} is unreadable: ${String(caught)}`);
        }
    }

    private get ballast(): string | null {
        return this.storeMount ? join(this.storeMount, "ballast") : null;
    }

    /** Whatever the host left at the ballast's name goes: a directory tree, a link, or a file. */
    private removeBallast(): void {
        if (!this.ballast) return;
        rmSync(this.ballast, { recursive: true, force: true });
    }

    private async startArm(fresh: boolean, state: ArmState | null = null): Promise<void> {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (this.o.loopStore && eidnaraOn(this.o.arm)) this.mountStore(fresh);
        const filled = state?.ballast != null;
        if (filled && !state?.refilling)
            this.requireBallast(state?.ballast ?? null, "before the kill");
        if (filled) {
            this.ballastShape = state?.ballast ?? null;
            this.refilling = true;
            this.recordState();
        }
        this.removeBallast();
        try {
            if (eidnaraOn(this.o.arm)) {
                this.checkDaemonDirs();
                this.pinDataDir();
                const make = this.o.daemonFactory ?? ((ctx: DaemonContext) => new DaemonStack(ctx));
                this.daemon = make({
                    ...this.o,
                    root: this.o.armRoot,
                    dataDir: this.dataDir,
                    logFile: join(this.armDir, "daemon.log"),
                    model: this.o.models[0] as string,
                });
                await this.daemon.start();
                this.noteDaemon();
                this.recordState();
            }
        } finally {
            if (filled) {
                this.fill();
                this.recordState();
            }
        }
        if (filled) {
            this.requireFull();
            this.refilling = false;
            this.recordState();
        }
        this.host = this.newHost();
        this.recordState();
    }

    /** The ballast's length and allocated blocks both have to match; a sparse replacement or a punched hole fails. */
    private requireBallast(expected: ArmState["ballast"], when: string): void {
        const stat = lstatSync(this.ballast ?? "", { throwIfNoEntry: false });
        const shape = stat?.isFile() ? { bytes: stat.size, blocks: stat.blocks } : null;
        // A second name on the inode would keep the blocks allocated after the unlink.
        if (
            !expected ||
            !shape ||
            stat?.nlink !== 1 ||
            shape.bytes !== expected.bytes ||
            shape.blocks !== expected.blocks
        ) {
            throw new HarnessFailure(`store_full ballast ${this.ballast} changed ${when}`);
        }
    }

    /** Recorded processes go first: a daemon the killed harness left holds the data directory busy. */
    async reset(): Promise<void> {
        await this.reapStale();
        await this.stop();
        this.live = true;
        this.model = 0;
        this.transcriptsChecked = false;
        this.ballastShape = null;
        this.refilling = false;
        this.gitRun = null;
        this.failed = null;
        this.switched = null;
        for (const dir of [this.o.armRoot, this.storeRoot])
            rmSync(dir, { recursive: true, force: true });
        rmSync(this.image, { force: true });
        for (const stale of ["daemon.log", "transcripts.json"]) {
            rmSync(join(this.armDir, stale), { force: true });
        }
        mkdirSync(join(this.o.armRoot, "workspaces"), { recursive: true });
        for (const [project, source] of Object.entries(this.o.projects)) {
            const target = this.workspace(project);
            await this.gitClone(project, source, target);
        }
        await this.startArm(true);
    }

    async resume(open: ScenarioEvent | null, interrupted: readonly string[] = []): Promise<void> {
        const state = this.readState();
        if (!state) {
            throw new HarnessFailure(`resume of arm ${this.o.arm}: ${this.stateFile} is gone`);
        }
        // A switch the journal never observed ended with the killed harness; the model it left
        // goes back to the index it came from.
        const undone = state.switched && interrupted.includes(state.switched.fault);
        this.model = undone && state.switched ? state.switched.from : state.model;
        this.switched = undone ? null : (state.switched ?? null);
        this.live = true;
        const checked = join(this.armDir, "transcripts.json");
        if (existsSync(checked)) {
            const { missing } = this.readRecord<{ missing: string[] }>(checked);
            if (missing.length > 0) {
                throw new HarnessFailure(`transcript store missing: ${missing.join(", ")}`);
            }
            this.transcriptsChecked = true;
        }
        await this.reapStale();
        // A fault the journal never observed ended with the killed harness; its ballast goes with it.
        const lost =
            state.ballast?.fault !== undefined && interrupted.includes(state.ballast.fault);
        await this.startArm(false, lost ? { ...state, ballast: null, refilling: false } : state);
        if (open) await this.event(open);
    }

    /**
     * Stops what the killed harness recorded; a missing record is a lost arm, and a recorded
     * finish failure is final, so either stops the resume.
     */
    async reap(): Promise<void> {
        const state = this.readState();
        if (!state) {
            throw new HarnessFailure(`resume of arm ${this.o.arm}: ${this.stateFile} is gone`);
        }
        await this.reapStale();
        if (state.failed !== null && state.failed !== undefined) {
            throw new HarnessFailure(`arm ${this.o.arm} failed to finish earlier: ${state.failed}`);
        }
    }

    private async stopRecorded(proc: { pid: number; start: string | null } | null | undefined) {
        if (!proc || !running(proc.pid) || processStart(proc.pid) !== proc.start) return;
        if (!(await stopOwnedTree(proc.pid, 5_000, proc.start ?? undefined))) {
            throw new HarnessFailure(`recorded process ${proc.pid} survived SIGKILL`);
        }
    }

    /**
     * Daemons the fixture started against this arm's store, found by their `--state-root`
     * argument; one spawned before the harness died has no record in `state.json` yet.
     */
    private daemonsOnStore(): Array<{ pid: number; start: string | null }> {
        const uid = process.getuid?.();
        const found: Array<{ pid: number; start: string | null }> = [];
        for (const entry of readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            const pid = Number(entry);
            try {
                // The start time is read first, so a pid reused after the match is told apart.
                const start = processStart(pid);
                if (statSync(`/proc/${pid}`).uid !== uid) continue;
                const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
                const at = cmd.indexOf("--state-root");
                if (at >= 0 && cmd[at + 1] === this.dataDir) found.push({ pid, start });
            } catch {
                // The process went away between the listing and the read.
            }
        }
        return found;
    }

    /** The OpenCode wrapper's own record of its pid and start time, written before the server answers. */
    private launchRecord(): { pid: number; start: string | null } | null {
        const path = join(this.armDir, "opencode.launch");
        if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) return null;
        const [pid, start] = readFileSync(path, "utf8").trim().split(" ");
        const parsed = Number(pid);
        if (!Number.isInteger(parsed) || parsed <= 0) return null;
        return { pid: parsed, start: start ?? null };
    }

    /** Removes a stale `index.lock` when `.git` is a real directory; a link there is left alone. */
    private unlockGit(dir: string): void {
        const gitDir = join(dir, ".git");
        if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) return;
        for (const lock of ["index.lock", "HEAD.lock", "packed-refs.lock"]) {
            rmSync(join(gitDir, lock), { force: true });
        }
        const refs = join(gitDir, "refs");
        if (!lstatSync(refs, { throwIfNoEntry: false })?.isDirectory()) return;
        const walk = (d: string) => {
            for (const entry of readdirSync(d, { withFileTypes: true })) {
                const path = join(d, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (entry.isFile() && entry.name.endsWith(".lock"))
                    rmSync(path, { force: true });
            }
        };
        walk(refs);
    }

    /** Repository git follows `.git`, so it has to be the workspace's own directory, a link to none. */
    private requireOwnGitDir(dir: string): void {
        const gitDir = join(dir, ".git");
        if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
            throw new HarnessFailure(`workspace ${dir}: .git is not the workspace's own directory`);
        }
    }

    /** A git run cut off mid-way leaves `index.lock` behind; the replayed `apply_diff` needs it gone. */
    private async reapGit(state: ArmState): Promise<void> {
        if (!state.git) return;
        await this.stopRecorded(state.git);
        this.unlockGit(this.workspaceDir(state.git.project));
        writeWhole(this.stateFile, JSON.stringify({ ...state, git: null }));
    }

    /** Every recorded teardown is attempted; the first failure surfaces once all have run. */
    private async reapStale(): Promise<void> {
        const state = this.readState();
        let failure: unknown = null;
        const steps: Array<() => Promise<void> | void> = [
            () => (state ? this.reapGit(state) : undefined),
            () => this.stopRecorded(state?.host),
            () => this.stopRecorded(this.launchRecord()),
            async () => {
                for (const daemon of this.daemonsOnStore()) await this.stopRecorded(daemon);
            },
            () => this.stopRecorded(state?.daemon),
            () => this.unmount(this.dataDir),
            () => this.unmount(this.storeRoot),
        ];
        for (const step of steps) {
            try {
                await step();
            } catch (caught) {
                failure ??= caught;
            }
        }
        if (failure) throw failure;
    }

    private async openSession(e: ScenarioEvent, host: SimHost): Promise<void> {
        this.sessionProject = this.project(e);
        const connection = this.daemon?.connectionFile ?? null;
        await host.openSession(this.workspaceDir(this.sessionProject), e.session, connection);
        this.recordState();
    }

    async event(e: ScenarioEvent): Promise<{ failed?: string }> {
        const host = this.requireHost();
        if (e.kind === "session_start") {
            try {
                await this.openSession(e, host);
            } catch (caught) {
                // A daemon gone between sessions is the cause of a host that cannot connect.
                this.checkDaemon(e);
                throw caught;
            }
            return {};
        }
        if (e.kind === "session_end") {
            await host.closeSession();
            this.clearStoreFill();
            this.sessionProject = null;
            this.recordState();
            this.checkDaemon(e);
            if (!this.transcriptsChecked) this.checkTranscripts(host);
            return {};
        }
        if (e.kind === "apply_diff") {
            if (this.sessionProject !== null) {
                throw new HarnessFailure(
                    `apply_diff fires between sessions; ${e.id} fired inside one`,
                );
            }
            await this.applyDiff(e);
            return {};
        }
        let result: PromptResult;
        try {
            result = await host.prompt(String(e.text), this.o.turnDeadlineMs);
        } catch (caught) {
            // A daemon gone during the turn is the cause of a lost connection; it is reported first.
            this.checkDaemon(e);
            throw caught;
        }
        this.checkDaemon(e);
        return result.error ? { failed: result.error } : {};
    }

    private checkDaemon(e: ScenarioEvent): void {
        if (this.daemon && !this.daemonAlive()) this.o.onDaemonExit({ after: e.id });
    }

    private project(e: ScenarioEvent): string {
        const project = e.project ?? this.sessionProject;
        if (typeof project !== "string") throw new HarnessFailure(`event ${e.id} names no project`);
        return project;
    }

    private async applyDiff(e: ScenarioEvent): Promise<void> {
        const project = this.project(e);
        const dir = this.workspaceDir(project);
        const path = resolve(dir, String(e.path));
        const inside = (p: string) => {
            const real = realpathSync(p);
            return real === dir || real.startsWith(`${dir}/`);
        };
        let existing = dirname(path);
        while (!existsSync(existing)) existing = dirname(existing);
        if (!inside(existing))
            throw new HarnessFailure(`apply_diff path ${String(e.path)} leaves ${dir}`);
        mkdirSync(dirname(path), { recursive: true });
        if (
            !inside(dirname(path)) ||
            lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
        ) {
            throw new HarnessFailure(`apply_diff path ${String(e.path)} leaves ${dir}`);
        }
        this.requireOwnGitDir(dir);
        writeWhole(path, String(e.content));
        await this.gitOk(project, dir, ["add", "--", path]);
        const staged = await this.git(project, dir, ["diff", "--cached", "--quiet", "--", path]);
        if (staged.status === 0) return;
        const message = `Add ${String(e.path)}`;
        const when = this.o.baseMs + e.scenario_ms;
        const commit = ["commit", "--quiet", "--no-verify", "-m", message, "--", path];
        await this.gitOk(project, dir, commit, when);
    }

    private checkTranscripts(host: SimHost): void {
        const env = host.transcriptEnv();
        const paths = this.o.transcriptPaths.map((t) => expandTemplate(t, env));
        // A link anywhere below the arm root, or a node of the wrong kind where the store should
        // be, is the host's placeholder, so the store counts as missing.
        const root = realpathSync(this.o.armRoot);
        const present = (template: string, p: string) => {
            const rel = relative(root, resolve(p));
            if (rel.startsWith("..") || isAbsolute(rel)) return false;
            let at = root;
            for (const part of rel.split("/")) {
                at = join(at, part);
                if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() !== false)
                    return false;
            }
            const stat = lstatSync(p, { throwIfNoEntry: false });
            if (stat === undefined) return false;
            return transcriptKind(template) === "file" ? stat.isFile() : stat.isDirectory();
        };
        const missing = paths.filter((p, i) => !present(this.o.transcriptPaths[i] as string, p));
        const record = { checked_after: "first session_end", paths, missing };
        writeWhole(join(this.armDir, "transcripts.json"), JSON.stringify(record));
        if (missing.length > 0) throw new Error(`transcript store missing: ${missing.join(", ")}`);
        this.transcriptsChecked = true;
    }

    async fault(f: FaultEpisode): Promise<Record<string, unknown>> {
        if (!SUPPORTED.has(f.type))
            throw new HarnessFailure(`fault type ${f.type} has no mechanism`);
        if (BETWEEN_SESSIONS.has(f.type) && this.sessionProject !== null) {
            throw new HarnessFailure(`${f.type} fires between sessions; ${f.id} fired inside one`);
        }
        if (f.type === "daemon_sigkill_mid_fold" || f.type === "daemon_restart") {
            if (!this.daemon) return { skipped: "arm runs no daemon" };
            // The fault's kill is the evidence; a daemon already gone has none to give.
            if (!this.daemonAlive()) {
                throw new HarnessFailure(`${f.type} ${f.id}: daemon already gone before the fault`);
            }
            const before = this.daemonPid();
            this.checkDaemonDirs();
            await this.daemon.restart();
            this.noteDaemon();
            this.recordState();
            const after = this.daemonPid();
            return {
                signal: "SIGKILL",
                pid_before: before,
                pid_after: after,
                restarted_by: "harness",
            };
        }
        if (f.type === "store_full") {
            const evidence = this.fillStore();
            if (this.ballastShape) this.ballastShape = { ...this.ballastShape, fault: f.id };
            this.recordState();
            return evidence;
        }
        if (f.type === "plugin_reload") {
            return { reload: "host process and plugin respawn at the next session_start" };
        }
        this.switched = { fault: f.id, from: this.model };
        this.model++;
        this.host = this.newHost();
        this.recordState();
        return { model: this.currentModel() };
    }

    private mountStore(fresh: boolean): void {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (!fresh && !existsSync(this.image)) {
            throw new HarnessFailure(
                `resume of arm ${this.o.arm}: store image ${this.image} is gone`,
            );
        }
        if (fresh) {
            run(["truncate", "-s", "2G", this.image]);
            run(["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", this.image]);
        }
        const options = "loop,nosuid,nodev,noexec";
        run(["sudo", "-n", "mount", "-o", options, this.image, this.storeRoot]);
        this.storeMount = this.storeRoot;
        run(["sudo", "-n", "chown", `${process.getuid?.()}:${process.getgid?.()}`, this.storeRoot]);
        run(["sudo", "-n", "chmod", "0700", this.storeRoot]);
    }

    /** An unwritten `fallocate` extent and a short `dd` tail fill the store while the sparse image stays small. */
    private fill(): void {
        if (!this.storeMount || !this.ballast) return;
        this.removeBallast();
        writeFileSync(this.ballast, "", { flag: "wx" });
        const free = run(["df", "-B1", "--output=avail", this.storeMount])
            .trim()
            .split("\n")
            .at(-1);
        spawnSync("fallocate", ["-l", String(free), this.ballast]);
        const tail = [
            "if=/dev/zero",
            `of=${this.ballast}`,
            "bs=1M",
            "oflag=append",
            "conv=notrunc",
        ];
        spawnSync("dd", tail);
        const stat = statSync(this.ballast);
        this.ballastShape = { bytes: stat.size, blocks: stat.blocks };
    }

    private fillStore(): Record<string, unknown> {
        if (!this.storeMount) return { skipped: "arm runs no loop-mounted store" };
        this.fill();
        return { mount: this.storeMount, avail_kb: this.requireFull() };
    }

    /** The fault holds only while the store reports no free space. */
    private requireFull(): number {
        const df = run(["df", "--output=avail", this.storeMount as string]);
        const avail = Number(df.trim().split("\n").at(-1));
        if (avail !== 0) throw new HarnessFailure(`store_full left ${avail} KiB free`);
        return avail;
    }

    /**
     * The ballast must still be whole at the episode's end, since the store is writable to the
     * host. The state records the fault's end before the file goes, so a kill in between leaves a
     * ballast the next resume removes as a leftover.
     */
    private clearStoreFill(): void {
        const ballast = this.ballast;
        if (!ballast) return;
        if (this.ballastShape !== null) {
            this.requireBallast(this.ballastShape, "during the episode");
            // Space freed beside the ballast would have let writes through, so the episode holds
            // only while the store still reports none.
            this.requireFull();
            this.ballastShape = null;
            this.recordState();
        }
        this.removeBallast();
    }

    /** A failed finish is recorded, so a resume of an otherwise exhausted arm cannot heal it. */
    async finish(): Promise<void> {
        try {
            await this.stop();
        } catch (caught) {
            this.failed = String(caught);
            try {
                // A driver that finishes before it ever reset or resumed holds none of the
                // recorded identities; the failure joins the record on disk rather than replacing it.
                const recorded = this.readState();
                if (recorded && !this.live) {
                    writeWhole(
                        this.stateFile,
                        JSON.stringify({ ...recorded, failed: this.failed }),
                    );
                } else {
                    this.recordState();
                }
            } catch {
                // The failure itself is what surfaces; a record that cannot be written changes nothing.
            }
            throw caught;
        }
    }

    /**
     * A host or daemon whose teardown fails stays held, with its session and recorded identity, so
     * the failure's state names it and a later stop can try again.
     */
    async stop(): Promise<void> {
        let failure: unknown = null;
        try {
            await this.host?.closeSession();
            this.host = null;
            this.sessionProject = null;
        } catch (caught) {
            failure = caught;
        }
        try {
            await this.daemon?.stop();
            this.daemon = null;
        } catch (caught) {
            failure ??= caught;
        }
        try {
            this.unmount(this.dataDir);
        } catch (caught) {
            failure ??= caught;
        }
        if (this.storeMount) {
            try {
                this.unmount(this.storeMount);
                this.storeMount = null;
            } catch (caught) {
                failure ??= caught;
            }
        }
        if (failure) throw failure;
    }
}
