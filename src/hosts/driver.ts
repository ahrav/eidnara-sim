import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { GitBound, git } from "../git";
import type { CallView } from "../grade/artefacts";
import { processStart, running, stopOwnedTree } from "../run/procs";
import {
    type ArmDriver,
    HarnessFailure,
    type ScenarioEvent,
    type TurnOutcome,
} from "../run/scheduler";
import { transcriptKind } from "../run/transcripts";
import type { FaultEpisode } from "../scenario/faults";
import {
    armBase,
    type DaemonContext,
    DaemonStack,
    eidnaraOn,
    type HostContext,
    makeHost,
    type PromptResult,
    type SimHost,
    type ToolRun,
} from "./arms";
import { entriesOf, SnapshotRecorder } from "./snapshot";
import {
    checkStore,
    type Deletion,
    type DeletionPlan,
    deleteFactNotes,
    kernelObjects,
    memoryNotes,
} from "./storecheck";

interface ArmState {
    model: number;
    /** True once a host_upgrade moved later sessions to the configured next host version. */
    upgraded?: boolean;
    /** The second host client a two_hosts_one_daemon fault attached, with its session, while it runs. */
    second?: { pid: number; start: string | null; session?: string } | null;
    /** A session owed a second client again, kept until that client is attached. */
    second_owed?: string | null;
    /** The transcript store's newest mtime when an upgraded host's first session opened. */
    transcript_mark?: number | null;
    /** The session whose second client exited before its end; the arm stays failed. */
    second_exited?: string | null;
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
    /** Daemon restarts whose store check the journal may still lack, each with its plugin-log mark. */
    store_faults: Record<string, number>;
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
    /** Wall time of scenario time 0, the same value the clock offset targets. */
    baseMs: number;
    callsFor?: (session: string) => CallView[];
    /** Awaited after a probe turn and before its snapshot, so background calls the turn started are on record. */
    settle?: () => Promise<void>;
    /** Entries a walk of a workspace `.git` visits at most; the default is `GIT_DIR_ENTRY_CAP`. */
    gitDirEntryCap?: number;
    hostFactory?: (ctx: HostContext) => SimHost;
    daemonFactory?: (ctx: DaemonContext) => DaemonStack;
    /** The host's pinned and `config.upgrade` versions, as the run's preflight recorded them. */
    hostVersions?: { from: string; to: string | null; upgradeTranscriptPaths?: string[] };
    onDaemonExit: (detail: Record<string, unknown>) => void;
    /**
     * Called when a daemon process is up (at reset, resume, and after a fault's restart) and
     * before a fault takes one down, so each daemon lifetime has a first and a last sample.
     */
    sampleDaemon?: () => void;
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

/**
 * Copies one final store file from `within/name` to `to`. The store tree is the evaluated
 * host's to write, so the source opens without following a link, and the opened file must be a
 * single-link regular file whose kernel path is `within/name`; the destination is created
 * exclusively without following a link. An absent source copies nothing.
 */
function archiveStoreFile(within: string, name: string, to: string): void {
    const from = join(within, name);
    const { O_EXCL, O_CREAT, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = constants;
    let source: number;
    try {
        source = openSync(from, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (caught) {
        const code = (caught as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        if (code === "ELOOP") throw new HarnessFailure(`final store file ${from} is a symlink`);
        throw caught;
    }
    try {
        const st = fstatSync(source);
        if (!st.isFile() || st.nlink !== 1) {
            throw new HarnessFailure(`final store file ${from} is not a single-link regular file`);
        }
        const opened = readlinkSync(`/proc/self/fd/${source}`);
        if (opened !== from) {
            throw new HarnessFailure(`final store file ${from} resolves to ${opened}`);
        }
        const target = openSync(to, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
        try {
            const buf = Buffer.alloc(1 << 20);
            for (let at = 0; ; ) {
                const n = readSync(source, buf, 0, buf.length, at);
                if (n === 0) break;
                for (let done = 0; done < n; ) done += writeSync(target, buf, done, n - done);
                at += n;
            }
        } finally {
            closeSync(target);
        }
    } finally {
        closeSync(source);
    }
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

const BETWEEN_SESSIONS = new Set([
    "daemon_restart",
    "plugin_reload",
    "model_switch",
    "store_full",
    "host_upgrade",
    "two_hosts_one_daemon",
]);
/** A transform pass the daemon answered, as the plugin logs it. */
const SERVED_PASS = /rust pass: .*served_from=transform/;
/** How much of the plugin log one pass check reads at a time. */
const LOG_CHUNK_BYTES = 64 * 1024;

const SUPPORTED = new Set([
    "daemon_sigkill_mid_fold",
    "daemon_restart",
    "store_full",
    "plugin_reload",
    "model_switch",
    "host_upgrade",
    "two_hosts_one_daemon",
]);

export function driverSupports(f: Pick<FaultEpisode, "seam" | "type">): boolean {
    if (f.seam.layer !== "scheduler") return true;
    return SUPPORTED.has(f.type);
}

/** Entries a walk of the workspace `.git` visits at most; a wider tree stops the run. */
export const GIT_DIR_ENTRY_CAP = 200_000;

const IDENTITY = {
    GIT_AUTHOR_NAME: "sim-user",
    GIT_AUTHOR_EMAIL: "sim-user@users.noreply.github.com",
    GIT_COMMITTER_NAME: "sim-user",
    GIT_COMMITTER_EMAIL: "sim-user@users.noreply.github.com",
};

const SECOND_CLIENT_PROMPT = "List the top-level files in this repository and stop.";

/**
 * Creates `path` as an empty regular file when absent and leaves an existing regular file as it
 * is. The path lies in the evaluated agent's writable tree, so a symlink there is refused rather
 * than followed, and nothing is created outside the run directory on the agent's behalf.
 */
export function createNoFollow(path: string): void {
    const flags =
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
    try {
        closeSync(openSync(path, flags, 0o644));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ELOOP") {
            throw new Error(`${path} is a symlink; the plugin log must be a regular file`);
        }
        throw err;
    }
}

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
    /** Host-reported tool runs carry the active user turn id, or null between turns and for runs recovered from an earlier turn. */
    private turn: string | null = null;
    private transcriptsChecked = false;
    private readonly snapshots: SnapshotRecorder;
    private upgraded = false;
    private second: SimHost | null = null;
    /** The session the second client is attached to, kept in `state.json` for a resume. */
    private secondSession: string | null = null;
    /** A session a stopped run had a second client on, owed one again when it reopens. */
    private secondOwed: string | null = null;
    /** The session whose second client exited before the primary session's end. */
    private secondExited: string | null = null;
    /** The transcript store's newest mtime when an upgraded host's first session opened. */
    private storeMarkAtOpen: number | null = null;
    /** A host open or daemon start or restart in flight, which `stop` awaits before closing either. */
    private inflight: Promise<void> | null = null;
    private stopping = false;
    /** The deletion child a counterfactual fault runs, which `stop` ends before the store goes. */
    private deleting: ReturnType<typeof Bun.spawn> | null = null;
    /**
     * Daemon restarts owed a store check, each with the plugin log's length between the kill and
     * the replacement's start. The check runs at the end of the first turn whose log, past that
     * mark, shows a pass the daemon served (`served_from=transform`): the wire contract's first
     * pass after the crash.
     */
    private storeFaults = new Map<string, number>();
    /** Checks taken and returned, kept in the recorded state until the next event confirms the journal has them. */
    private settledFaults = new Map<string, number>();
    /** A daemon restart in progress; the turn it interrupts ends after it and fails with it. */
    private restarting: Promise<unknown> = Promise.resolve();

    constructor(private readonly o: DriverOptions) {
        this.snapshots = new SnapshotRecorder(
            dirname(o.armRoot),
            o.arm,
            o.callsFor ?? (() => []),
            o.turnDeadlineMs,
        );
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
        return eidnaraOn(armBase(this.o.arm)) ? [...this.o.keep, this.storeRoot] : this.o.keep;
    }

    /**
     * The primary host reports its tool runs to the snapshot recorder; a second client's runs
     * stay out of the primary session's command log.
     */
    private newHost(primary = true): SimHost {
        const make = this.o.hostFactory ?? makeHost;
        const { keep } = this;
        // An upgrade moves only this host's binary to the configured next version.
        const field = this.o.host === "pi" ? "pi_install" : "opencode_binary";
        const next = this.upgraded ? this.o.config.upgrade?.[field] : undefined;
        const config = next ? { ...this.o.config, [field]: next } : this.o.config;
        const onSpawn = () => this.recordState();
        const onTool = (run: ToolRun) =>
            this.snapshots.addTools([run], run.recovered ? null : this.turn);
        return make({
            ...this.o,
            config,
            arm: armBase(this.o.arm),
            keep,
            root: this.o.armRoot,
            model: this.currentModel(),
            onSpawn,
            ...(primary ? { onTool } : {}),
        });
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

    /** Provider faults belong to the proxy and the sleep to the clock; the rest need a mechanism here. */
    supports(f: FaultEpisode): boolean {
        return driverSupports(f);
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
        const identity = this.second?.hostIdentity() ?? null;
        const second =
            identity && this.secondSession
                ? { ...identity, session: this.secondSession }
                : identity;
        const state: ArmState = {
            model: this.model,
            upgraded: this.upgraded,
            second,
            second_owed: this.secondOwed ?? this.secondSession,
            transcript_mark: this.storeMarkAtOpen,
            second_exited: this.secondExited,
            daemon,
            switched: this.switched,
            host,
            ballast: this.ballastShape,
            refilling: this.refilling,
            git: this.gitRun,
            failed: this.failed,
            store_faults: Object.fromEntries([...this.settledFaults, ...this.storeFaults]),
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
        this.stopping = false;
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (this.o.loopStore && eidnaraOn(armBase(this.o.arm))) this.mountStore(fresh);
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
            if (eidnaraOn(armBase(this.o.arm))) {
                this.checkDaemonDirs();
                this.pinDataDir();
                const make = this.o.daemonFactory ?? ((ctx: DaemonContext) => new DaemonStack(ctx));
                this.daemon = make({
                    ...this.o,
                    root: this.o.armRoot,
                    dataDir: this.dataDir,
                    logFile: join(this.armDir, "daemon.log"),
                    model: this.o.sideModel ?? (this.o.models[0] as string),
                });
                await this.track(this.daemon.start());
                this.noteDaemon();
                this.recordState();
                this.o.sampleDaemon?.();
                createNoFollow(join(this.o.armRoot, "eidnara.log"));
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
        // A stop that landed during the start owns the daemon it captured; the arm starts no
        // host behind it.
        if (this.stopping) return;
        this.host = this.newHost();
        this.recordState();
    }

    /** Runs a host open or daemon start or restart so that `stop` waits for it to settle. */
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
        this.upgraded = false;
        this.snapshots.clear();
        this.transcriptsChecked = false;
        this.secondSession = null;
        this.secondOwed = null;
        this.secondExited = null;
        this.storeMarkAtOpen = null;
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
            const baseline = join(this.armDir, `${project}.gitconfig`);
            rmSync(baseline, { force: true });
            copyFileSync(join(target, ".git", "config"), baseline, constants.COPYFILE_EXCL);
            this.trackRules(project, source, target);
        }
        await this.startArm(true);
    }

    /**
     * Records which paths the clone's source force-tracks past its ignore rules, and the rule
     * files and exclude digests it starts with, so a probe snapshot sees what the agent changed.
     */
    private trackRules(project: string, source: string, target: string): void {
        const tracked = ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"];
        const forced = git(source, tracked).split("\0").filter(Boolean);
        this.snapshots.trackIgnored(project, forced);
        const rules: Record<string, string> = {};
        const names = [".gitignore", "**/.gitignore", ".gitattributes", "**/.gitattributes"];
        const listed = git(source, ["ls-files", "-s", "-z", "--", ...names]);
        for (const row of listed.split("\0").filter(Boolean)) {
            const [meta, path] = row.split("\t") as [string, string];
            rules[path] = meta.split(" ")[1] as string;
        }
        this.snapshots.trackIgnoreRules(
            project,
            rules,
            this.snapshots.excludeDigest(target),
            this.snapshots.excludeDigest(target, "attributes"),
        );
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
        this.upgraded = state.upgraded ?? false;
        this.switched = undone ? null : (state.switched ?? null);
        this.live = true;
        this.storeFaults = new Map(Object.entries(state.store_faults ?? {}));
        const checked = join(this.armDir, "transcripts.json");
        if (existsSync(checked)) {
            const record = this.readRecord<{
                missing: string[];
                fresh?: boolean | null;
                templates?: string[];
            }>(checked);
            if (record.missing.length > 0) {
                throw new HarnessFailure(`transcript store missing: ${record.missing.join(", ")}`);
            }
            // An upgraded arm accepts only the record of the upgraded host's own fresh check, of
            // the store templates that host writes.
            this.transcriptsChecked =
                (this.upgraded ? record.fresh === true : record.fresh !== false) &&
                JSON.stringify(record.templates ?? this.o.transcriptPaths) ===
                    JSON.stringify(this.transcriptPaths());
        }
        this.secondOwed = state.second?.session ?? state.second_owed ?? null;
        this.storeMarkAtOpen = state.transcript_mark ?? null;
        this.secondExited = state.second_exited ?? null;
        await this.reapStale();
        if (this.secondExited !== null) {
            throw new HarnessFailure(
                `the second client exited before the primary session's session_end in ${this.secondExited}`,
            );
        }
        // A fault the journal never observed ended with the killed harness; its ballast goes with it.
        const lost =
            state.ballast?.fault !== undefined && interrupted.includes(state.ballast.fault);
        await this.startArm(false, lost ? { ...state, ballast: null, refilling: false } : state);
        if (open && !this.stopping) await this.event(open);
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
            () => this.stopRecorded(state?.second),
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
        // A second client the stopped run had on this session is attached again before the
        // primary reopens, so the session keeps both clients on the daemon; its fixed turn ran.
        if (this.secondOwed === e.session && this.daemon && !this.second)
            await this.attachSecond(e);
        this.secondOwed = null;
        this.sessionProject = this.project(e);
        const connection = this.daemon?.connectionFile ?? null;
        const dir = this.workspaceDir(this.sessionProject);
        // The mark from a session a stop interrupted stays, so the reopened session's check
        // measures the whole session.
        if (this.upgraded && !this.transcriptsChecked && this.storeMarkAtOpen === null) {
            this.storeMarkAtOpen = this.storeMark(host);
        }
        await this.track(host.openSession(dir, e.session, connection));
        this.recordState();
        this.snapshots.sessionStart(e.session, this.sessionProject, dir);
        this.recordState();
    }

    async event(e: ScenarioEvent): Promise<TurnOutcome> {
        const host = this.requireHost();
        // The scheduler journals the previous event's store checks before it sends the next event,
        // so the recorded obligations drop them here, not when the checks are returned.
        this.settledFaults.clear();
        this.recordState();
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
            this.requireSecondAttached();
            const project = this.project(e);
            host.drainTools();
            this.snapshots.sessionEnd(e.session, project, this.workspace(project));
            await host.closeSession();
            await this.closeSecond();
            this.clearStoreFill();
            this.sessionProject = null;
            this.recordState();
            this.checkDaemon(e);
            if (!this.transcriptsChecked) this.checkTranscripts(host);
            // The session's background passes have settled by now, so a check they earned runs
            // here, after the state write, so the recorded obligation outlives the journal append.
            const stores = this.owedStores();
            return stores ? { stores } : {};
        }
        if (e.kind === "apply_diff") {
            if (this.sessionProject !== null) {
                throw new HarnessFailure(
                    `apply_diff fires between sessions; ${e.id} fired inside one`,
                );
            }
            this.applyDiff(e);
            return {};
        }
        const entered = Date.now();
        const project = this.project(e);
        const dir = this.workspaceDir(project);
        let before: string | null = "";
        let beforeFailed = "";
        if (e.probe) {
            try {
                before = this.snapshots.tree(dir);
            } catch (caught) {
                if (!(caught instanceof GitBound)) throw caught;
                before = null;
                beforeFailed = caught.message;
            }
        }
        const interruptMs = typeof e.interrupt_ms === "number" ? e.interrupt_ms : undefined;
        // A pass served between turns earned its check before this turn's own passes.
        const owedBefore = this.owedStores();
        // One turn reports a gone daemon once, however many checks find it gone.
        let reported = false;
        const check = () => {
            if (reported) return;
            reported = this.checkDaemon(e);
        };
        // A turn that spent part of its deadline before the prompt passes the rest along; one
        // that spent all of it fails here, so the agent never runs past the deadline.
        const deadline =
            typeof e.deadline_ms === "number"
                ? Math.min(this.o.turnDeadlineMs, e.deadline_ms - (Date.now() - entered))
                : this.o.turnDeadlineMs;
        if (deadline <= 0) {
            const spent: TurnOutcome = {
                failed: `turn deadline ${this.o.turnDeadlineMs} ms spent before the prompt`,
                undelivered: true,
            };
            if (owedBefore) spent.stores = owedBefore;
            return spent;
        }
        let result: PromptResult;
        this.turn = e.id;
        const started = performance.now();
        try {
            result = await host.prompt(String(e.text), deadline, interruptMs);
        } catch (caught) {
            this.turn = null;
            // A daemon gone during the turn is the cause of a lost connection; it is reported first.
            check();
            throw caught;
        }
        // Wall time of the host's prompt call alone, the turn latency the report reads.
        const prompt_ms = Math.round(performance.now() - started);
        check();
        const tools = host.drainTools();
        this.turn = null;
        const outcome: TurnOutcome = {
            prompt_ms,
            ...(result.interrupted ? { user: { interrupted: true } } : {}),
        };
        if (result.undelivered) outcome.undelivered = true;
        if (owedBefore) outcome.stores = owedBefore;
        if (result.error) outcome.failed = result.error;
        if (e.probe && before === null) {
            const reason = `snapshot before the turn: ${beforeFailed}`;
            outcome.failed = outcome.failed ? `${outcome.failed} | ${reason}` : reason;
        } else if (e.probe && before !== null) {
            await this.o.settle?.();
            try {
                const { nested, ignoreFiles } = this.snapshots.survey(dir);
                const changed = this.snapshots.ignoreChanges(dir, project, ignoreFiles);
                const after = changed.length > 0 ? before : this.snapshots.tree(dir, nested);
                const reasons = [
                    nested.length > 0 ? `embedded repository at ${nested.join(", ")}` : null,
                    changed.length > 0 ? `rule files changed: ${changed.join(", ")}` : null,
                ].filter((r): r is string => r !== null);
                for (const reason of reasons) {
                    outcome.failed = outcome.failed ? `${outcome.failed} | ${reason}` : reason;
                }
                const probe = { probe: e.probe, session: e.session, id: e.id };
                outcome.snapshot = this.snapshots.capture(
                    probe,
                    project,
                    dir,
                    before,
                    tools,
                    !!outcome.failed,
                    after,
                );
            } catch (caught) {
                if (!(caught instanceof GitBound)) throw caught;
                const reason = `snapshot: ${caught.message}`;
                outcome.failed = outcome.failed ? `${outcome.failed} | ${reason}` : reason;
            }
            check();
        }
        // After the turn and, for a probe, its settled background jobs: the check this turn earned.
        await this.restarting;
        const owedAfter = this.owedStores();
        if (owedAfter) outcome.stores = [...(outcome.stores ?? []), ...owedAfter];
        return outcome;
    }

    /** Reports a daemon that is gone, and returns whether it did. */
    private checkDaemon(e: ScenarioEvent): boolean {
        if (!this.daemon || this.daemonAlive()) return false;
        this.o.onDaemonExit({ after: e.id });
        return true;
    }

    private project(e: ScenarioEvent): string {
        const project = e.project ?? this.sessionProject;
        if (typeof project !== "string") throw new HarnessFailure(`event ${e.id} names no project`);
        return project;
    }

    private applyDiff(e: ScenarioEvent): void {
        const workspace = this.workspace(this.project(e));
        const stat = lstatSync(workspace, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) {
            throw new HarnessFailure(`workspace ${workspace} is a symlink or lies behind one`);
        }
        if (!stat?.isDirectory()) {
            throw new HarnessFailure(`workspace ${workspace} is not a directory`);
        }
        const expected = join(realpathSync(this.armDir), relative(this.armDir, workspace));
        if (realpathSync(workspace) !== expected) {
            throw new HarnessFailure(`workspace ${workspace} is a symlink or lies behind one`);
        }
        const dir = realpathSync(workspace);
        const path = resolve(dir, String(e.path));
        const inside = path.startsWith(`${dir}/`);
        const present = (at: string) => lstatSync(at, { throwIfNoEntry: false }) !== undefined;
        let ancestor = dirname(path);
        while (inside && ancestor !== dir && !present(ancestor)) ancestor = dirname(ancestor);
        let parent = "";
        try {
            parent = inside ? realpathSync(ancestor) : "";
        } catch {
            parent = "";
        }
        const contained = parent === dir || parent.startsWith(`${dir}/`);
        const target = lstatSync(path, { throwIfNoEntry: false });
        if (!inside || !contained || target?.isSymbolicLink()) {
            throw new HarnessFailure(`apply_diff path ${String(e.path)} leaves ${dir}`);
        }
        if (target !== undefined && !target.isFile()) {
            throw new HarnessFailure(`apply_diff path ${String(e.path)} is not a regular file`);
        }
        mkdirSync(dirname(path), { recursive: true });
        // The file is written whole and renamed into place, so a hard link the agent left at
        // the path keeps its other name's content; the mode it had carries over.
        writeWhole(path, String(e.content));
        if (target !== undefined) chmodSync(path, target.mode & 0o7777);
        this.withPristineRepo(dir, this.project(e), () => {
            const blob = this.workspaceGit(dir, ["hash-object", "-w", "--no-filters", "--", path]);
            const executable = (lstatSync(path).mode & 0o111) !== 0;
            const entry = `${executable ? "100755" : "100644"},${blob},${relative(dir, path)}`;
            const head = this.workspaceGit(dir, ["rev-parse", "--verify", "HEAD"]);
            const scratch = { GIT_INDEX_FILE: join(this.armDir, "apply-diff.index") };
            rmSync(`${scratch.GIT_INDEX_FILE}.lock`, { force: true });
            this.workspaceGit(dir, ["read-tree", head], scratch);
            this.workspaceGit(dir, ["update-index", "--add", "--cacheinfo", entry], scratch);
            const tree = this.workspaceGit(dir, ["write-tree"], scratch);
            rmSync(scratch.GIT_INDEX_FILE, { force: true });
            try {
                this.workspaceGit(dir, ["update-index", "--add", "--cacheinfo", entry]);
            } catch (caught) {
                if (caught instanceof GitBound)
                    rmSync(join(dir, ".git", "index.lock"), { force: true });
                throw caught;
            }
            if (tree === this.workspaceGit(dir, ["rev-parse", `${head}^{tree}`])) return;
            const message = `Add ${String(e.path)}`;
            // The commit carries the event's scenario instant, so paired arms and a resumed
            // delivery produce the same commit.
            const date = `@${Math.floor((this.o.baseMs + e.scenario_ms) / 1000)} +0000`;
            const commit = this.workspaceGit(
                dir,
                ["commit-tree", tree, "-p", head, "-m", message],
                { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, TZ: "UTC" },
            );
            this.workspaceGit(dir, ["update-ref", "HEAD", commit, head]);
        });
    }

    /** Workspace git operations override agent-controlled execution settings to constrain which programs git can invoke. */
    private workspaceGit(dir: string, args: string[], extra: Record<string, string> = {}): string {
        const gitDir = join(dir, ".git");
        const scope = {
            GIT_DIR: gitDir,
            GIT_WORK_TREE: dir,
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_NAMESPACE: "",
            ...extra,
        };
        const off = [
            `core.hooksPath=${join(this.armDir, "no-hooks")}`,
            "core.fsmonitor=false",
            "commit.gpgsign=false",
        ];
        const argv = [...off.flatMap((setting) => ["-c", setting]), ...args];
        return git(dir, argv, scope, this.o.turnDeadlineMs).trim();
    }

    /**
     * The agent can write the workspace repository's config, hooks, and object-store
     * pointers. While `fn` runs, the repository's config is the clone's baseline, so an
     * include, filter driver, or command the agent configured is out of git's view; the
     * agent's config returns afterwards. A symlink under `.git` or an `alternates` file
     * stops the run.
     */
    private withPristineRepo<T>(dir: string, project: string, fn: () => T): T {
        const gitDir = join(dir, ".git");
        if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory()) {
            throw new HarnessFailure(`${gitDir} is not a directory`);
        }
        const deadline = Date.now() + this.o.turnDeadlineMs;
        let seen = 0;
        const pending = [gitDir];
        for (let at = pending.shift(); at !== undefined; at = pending.shift()) {
            for (const entry of entriesOf(at)) {
                if (
                    ++seen > (this.o.gitDirEntryCap ?? GIT_DIR_ENTRY_CAP) ||
                    Date.now() > deadline
                ) {
                    throw new HarnessFailure(
                        `${relative(dir, gitDir)} walk: too many entries or timed out`,
                    );
                }
                const path = join(at, entry.name);
                if (entry.isDirectory()) {
                    pending.push(path);
                    continue;
                }
                if (entry.isFile()) continue;
                const kind = entry.isSymbolicLink()
                    ? "a symlink; git would write through it"
                    : "not a regular file";
                throw new HarnessFailure(`${relative(dir, path)} is ${kind}`);
            }
        }
        for (const redirect of ["objects/info/alternates", "commondir", "gitdir"]) {
            if (existsSync(join(gitDir, redirect))) {
                throw new HarnessFailure(`.git/${redirect} redirects git to another repository`);
            }
        }
        const config = join(gitDir, "config");
        const aside = join(gitDir, "config.sim-aside");
        if (existsSync(aside)) renameSync(aside, config);
        if (!lstatSync(config, { throwIfNoEntry: false })?.isFile()) {
            throw new HarnessFailure(`${relative(dir, config)} is not a file`);
        }
        renameSync(config, aside);
        try {
            copyFileSync(join(this.armDir, `${project}.gitconfig`), config);
            return fn();
        } finally {
            renameSync(aside, config);
        }
    }

    /** The transcript store templates of the host version now running. */
    private transcriptPaths(): string[] {
        const upgraded = this.o.hostVersions?.upgradeTranscriptPaths;
        return this.upgraded && upgraded ? upgraded : this.o.transcriptPaths;
    }

    /** The newest modification time under the store paths, so a new transcript shows as a change. */
    private storeMark(host: SimHost): number {
        const env = host.transcriptEnv();
        // Symlinks count as nothing: the host writes into this tree, and a link could lead out of it.
        const newest = (path: string): number => {
            const st = lstatSync(path, { throwIfNoEntry: false });
            if (!st || st.isSymbolicLink()) return 0;
            if (!st.isDirectory()) return st.mtimeMs;
            return Math.max(st.mtimeMs, ...readdirSync(path).map((f) => newest(join(path, f))));
        };
        return Math.max(0, ...this.transcriptPaths().map((t) => newest(expandTemplate(t, env))));
    }

    private checkTranscripts(host: SimHost): void {
        const env = host.transcriptEnv();
        const templates = this.transcriptPaths();
        const paths = templates.map((t) => expandTemplate(t, env));
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
        const missing = paths.filter((p, i) => !present(templates[i] as string, p));
        const after = this.upgraded ? "first session_end after host_upgrade" : "first session_end";
        // An upgraded host shares its store path with the version before it, so the check also
        // requires the session that just ended to have changed the store.
        const fresh =
            this.storeMarkAtOpen === null ? null : this.storeMark(host) > this.storeMarkAtOpen;
        const record = { checked_after: after, templates, paths, missing, fresh };
        writeWhole(join(this.armDir, "transcripts.json"), JSON.stringify(record));
        if (missing.length > 0) throw new Error(`transcript store missing: ${missing.join(", ")}`);
        if (fresh === false) {
            throw new Error(`no new transcript in ${paths.join(", ")} after the upgraded session`);
        }
        this.storeMarkAtOpen = null;
        this.transcriptsChecked = true;
    }

    async fault(f: FaultEpisode, at?: ScenarioEvent): Promise<Record<string, unknown>> {
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
            this.checkDaemonDirs();
            const restart = this.restartDaemon(this.daemon, f.id);
            restart.catch(() => undefined);
            this.restarting = restart;
            return restart;
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
        if (f.type === "host_upgrade") return this.upgradeHost();
        if (f.type === "two_hosts_one_daemon") return this.secondClient(at);
        this.switched = { fault: f.id, from: this.model };
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
        this.transcriptsChecked = false;
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
        if (!second) return;
        try {
            second.drainTools();
            await second.closeSession();
            this.second = null;
            this.secondSession = null;
        } finally {
            if (record) this.recordState();
        }
    }

    /** Opens the second client on the session's workspace and records it with its session. */
    private async attachSecond(at: ScenarioEvent): Promise<SimHost> {
        const second = this.newHost(false);
        this.second = second;
        this.secondSession = at.session;
        await this.track(
            second.openSession(
                this.workspaceDir(this.project(at)),
                `${at.session}-b`,
                this.daemon?.connectionFile ?? null,
            ),
        );
        // A stop in progress owns the second client's close; a client the arm no longer holds
        // is closed here.
        if (this.second !== second) await second.closeSession();
        if (this.stopping || this.second !== second) {
            throw new HarnessFailure("the arm stopped while the second client opened");
        }
        this.recordState();
        return second;
    }

    /** A second client's host process must still run at the primary session's `session_end`. */
    private requireSecondAttached(): void {
        if (!this.second) return;
        const pid = this.second.hostPid();
        if (pid === null || !running(pid)) {
            // The violation is recorded before the throw, so a resumed arm fails the same way.
            this.secondExited = this.secondSession;
            this.recordState();
            throw new HarnessFailure(
                `the second client exited before the primary session's session_end (pid ${pid})`,
            );
        }
    }

    private async secondClient(at?: ScenarioEvent): Promise<Record<string, unknown>> {
        if (!this.daemon) return { skipped: "arm runs no daemon" };
        if (at?.kind !== "session_start") {
            throw new HarnessFailure("two_hosts_one_daemon fires at a session_start");
        }
        const session = `${at.session}-b`;
        try {
            const second = await this.attachSecond(at);
            const result = await second.prompt(SECOND_CLIENT_PROMPT, this.o.turnDeadlineMs);
            return {
                second_session: session,
                second_host_pid: second.hostPid(),
                daemon_pid: this.daemonPid(),
                outcome: result.error ?? "ok",
                attached_until: "the primary session's session_end, or the run's stop",
            };
        } catch (caught) {
            // A stop in progress owns the second client's close.
            if (!this.stopping) await this.closeSecond().catch(() => undefined);
            throw caught;
        }
    }

    async deleteFact(
        statement: string,
        others: readonly string[] = [],
        plan: DeletionPlan = {},
    ): Promise<Deletion | { skipped: string }> {
        if (!this.daemon) return { skipped: "arm runs no daemon" };
        if (!existsSync(this.storeDb)) return { skipped: "no store yet" };
        try {
            const onSpawn = (child: ReturnType<typeof Bun.spawn>) => {
                this.deleting = child;
                void child.exited.finally(() => {
                    if (this.deleting === child) this.deleting = null;
                });
            };
            return await deleteFactNotes(
                this.storeDb,
                statement,
                others,
                onSpawn,
                this.dataDir,
                plan,
            );
        } catch (caught) {
            return { skipped: `deletion failed: ${String(caught).slice(0, 300)}` };
        }
    }

    get storeDb(): string {
        return join(this.dataDir, "eidnara", "context", "store.db");
    }

    private async restartDaemon(
        daemon: DaemonStack,
        fault: string,
    ): Promise<Record<string, unknown>> {
        const before = this.daemonPid();
        // An earlier restart's check that a served pass has earned is taken from this daemon.
        const stores = this.owedStores();
        this.o.sampleDaemon?.();
        await daemon.crash();
        const store = checkStore(this.storeDb);
        // Marked before the start, so a pass the replacement serves while its start settles counts.
        const mark = this.pluginLogLength();
        await daemon.restart();
        this.noteDaemon();
        this.storeFaults.set(fault, mark);
        this.recordState();
        this.o.sampleDaemon?.();
        return {
            signal: "SIGKILL",
            pid_before: before,
            pid_after: this.daemonPid(),
            restarted_by: "harness",
            store,
            ...(stores ? { stores } : {}),
        };
    }

    /** The store checks whose restart the plugin log now shows a served pass after, if any. */
    private owedStores(): TurnOutcome["stores"] {
        const passed = [...this.storeFaults].filter(([, mark]) => this.passedSince(mark));
        if (passed.length === 0 || !this.daemon) return undefined;
        const store = checkStore(this.storeDb);
        for (const [fault, mark] of passed) {
            this.storeFaults.delete(fault);
            this.settledFaults.set(fault, mark);
        }
        return passed.map(([fault]) => ({ fault, store }));
    }

    private get pluginLog(): string {
        return join(this.o.armRoot, "eidnara.log");
    }

    private pluginLogLength(): number {
        return existsSync(this.pluginLog) ? statSync(this.pluginLog).size : 0;
    }

    /**
     * Whether the plugin log, past `mark`, records a pass the daemon served. The suffix is read
     * in bounded chunks; the unfinished last line of one chunk heads the next, so a record split
     * across chunks is still read whole, and a line longer than a chunk is dropped unmatched.
     */
    private passedSince(mark: number): boolean {
        // The agent can write the arm root, so the log opens without following a link and is
        // read only up to the size of the single-link regular file the descriptor holds.
        let fd: number;
        try {
            fd = openSync(
                this.pluginLog,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
        } catch (caught) {
            const code = (caught as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return false;
            if (code === "ELOOP") {
                throw new HarnessFailure(`plugin log ${this.pluginLog} is a symlink`);
            }
            throw caught;
        }
        try {
            const st = fstatSync(fd);
            if (!st.isFile() || st.nlink !== 1) {
                throw new HarnessFailure(
                    `plugin log ${this.pluginLog} is not a single-link regular file`,
                );
            }
            const chunk = Buffer.alloc(LOG_CHUNK_BYTES);
            let carry = "";
            let position = mark;
            for (;;) {
                const n =
                    position >= st.size
                        ? 0
                        : readSync(
                              fd,
                              chunk,
                              0,
                              Math.min(chunk.length, st.size - position),
                              position,
                          );
                if (n === 0) return SERVED_PASS.test(carry);
                position += n;
                const text = carry + chunk.subarray(0, n).toString("utf8");
                const cut = text.lastIndexOf("\n");
                if (cut < 0) {
                    carry = text.length > LOG_CHUNK_BYTES ? "" : text;
                    continue;
                }
                if (SERVED_PASS.test(text.slice(0, cut))) return true;
                carry = text.slice(cut + 1);
            }
        } finally {
            closeSync(fd);
        }
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

    /**
     * Settles the store checks the arm still owes, then stops everything it runs. A failed finish
     * is recorded, so a resume of an otherwise exhausted arm cannot heal it.
     */
    async finish(): Promise<TurnOutcome> {
        try {
            const stores = this.owedStores();
            await this.stop(true);
            return stores ? { stores } : {};
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
    async stop(checkFinalStore = false): Promise<void> {
        // A host open or daemon start in flight settles first, so the stop closes what it opened.
        this.stopping = true;
        await this.inflight;
        await this.restarting.catch(() => undefined);
        const deleting = this.deleting;
        if (deleting) {
            deleting.kill();
            await deleting.exited;
        }
        let failure: unknown = null;
        try {
            await this.host?.closeSession();
            this.host = null;
            this.sessionProject = null;
        } catch (caught) {
            failure = caught;
        }
        try {
            await this.closeSecond(false);
        } catch (caught) {
            failure ??= caught;
        }
        try {
            const daemon = this.daemon;
            await daemon?.stop();
            this.daemon = null;
            if (daemon && checkFinalStore) {
                // The final store check reads the store the stopped daemon left.
                const check = checkStore(this.storeDb);
                writeWhole(join(this.armDir, "store-check.json"), `${JSON.stringify(check)}\n`);
                const notes = memoryNotes(this.storeDb);
                writeWhole(join(this.armDir, "memory.json"), `${JSON.stringify(notes)}\n`);
                // Eidnara keeps its memories in the Kernel registry; the stopped daemon's stores
                // are kept beside the arm, since the loop-mounted store is unmounted next.
                // A fresh directory replaces any earlier archive, a planted link included, so
                // the copies land only inside the arm directory.
                const kept = join(this.armDir, "final-store");
                rmSync(kept, { recursive: true, force: true });
                mkdirSync(kept, { mode: 0o700 });
                if (existsSync(this.dataDir)) {
                    const context = join(realpathSync(this.dataDir), "eidnara", "context");
                    for (const [within, name] of [
                        [context, "store.db"],
                        [join(context, "kernel"), "kernel.sqlite"],
                    ] as const) {
                        for (const suffix of ["", "-wal", "-shm"]) {
                            archiveStoreFile(within, name + suffix, join(kept, name + suffix));
                        }
                    }
                }
                const objects = kernelObjects(join(kept, "kernel.sqlite"));
                writeWhole(
                    join(this.armDir, "kernel-objects.json"),
                    `${JSON.stringify(objects)}\n`,
                );
            }
        } catch (caught) {
            failure ??= caught;
        }
        try {
            this.unmount(this.dataDir);
        } catch (caught) {
            failure ??= caught;
        }
        // At the run's end a fill a session_end never cleared comes off, whole, before the mount
        // does; an aborting stop keeps the recorded ballast so a resume refills it.
        if (checkFinalStore) {
            try {
                this.clearStoreFill();
            } catch (caught) {
                failure ??= caught;
            }
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
