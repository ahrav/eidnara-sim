import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GitBound, git } from "../git";
import type { CallView } from "../grade/artefacts";
import { processStart, running, stopOwnedTree } from "../run/procs";
import {
    type ArmDriver,
    HarnessFailure,
    type ScenarioEvent,
    type TurnOutcome,
} from "../run/scheduler";
import type { FaultEpisode } from "../scenario/faults";
import {
    DaemonStack,
    eidnaraOn,
    type HostContext,
    makeHost,
    type SimHost,
    type ToolRun,
} from "./arms";
import { SnapshotRecorder } from "./snapshot";
import { checkStore } from "./storecheck";

interface ArmState {
    model: number;
    daemon: { pid: number; start: string | null } | null;
    host: { pid: number; start: string | null } | null;
    /** Daemon restarts whose store check the journal may still lack, each with its plugin-log mark. */
    store_faults: Record<string, number>;
}

export interface DriverOptions extends Omit<HostContext, "root" | "model"> {
    armRoot: string;
    projects: Record<string, string>;
    models: string[];
    turnDeadlineMs: number;
    transcriptPaths: string[];
    loopStore: boolean;
    callsFor?: (session: string) => CallView[];
    /** Awaited after a probe turn and before its snapshot, so background calls the turn started are on record. */
    settle?: () => Promise<void>;
    /** Entries a walk of a workspace `.git` visits at most; the default is `GIT_DIR_ENTRY_CAP`. */
    gitDirEntryCap?: number;
    hostFactory?: (ctx: HostContext) => SimHost;
    onDaemonExit: (detail: Record<string, unknown>) => void;
    /**
     * Called when a daemon process is up (at reset, resume, and after a fault's restart) and
     * before a fault takes one down, so each daemon lifetime has a first and a last sample.
     */
    sampleDaemon?: () => void;
}

/** Entries a walk of the workspace `.git` visits at most; a wider tree stops the run. */
export const GIT_DIR_ENTRY_CAP = 200_000;

const IDENTITY = {
    GIT_AUTHOR_NAME: "sim-user",
    GIT_AUTHOR_EMAIL: "sim-user@users.noreply.github.com",
    GIT_COMMITTER_NAME: "sim-user",
    GIT_COMMITTER_EMAIL: "sim-user@users.noreply.github.com",
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
]);

export class HostDriver implements ArmDriver {
    host: SimHost | null = null;
    daemon: DaemonStack | null = null;
    private model = 0;
    private storeMount: string | null = null;
    private sessionProject: string | null = null;
    /** Host-reported tool runs carry the active user turn id, or null between turns. */
    private turn: string | null = null;
    private transcriptsChecked = false;

    private readonly snapshots: SnapshotRecorder;
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
        const keep = eidnaraOn(this.o.arm) ? [...this.o.keep, this.storeRoot] : this.o.keep;
        const onTool = (run: ToolRun) => this.snapshots.addTools([run], this.turn);
        return make({ ...this.o, keep, root: this.o.armRoot, model: this.currentModel(), onTool });
    }

    private recordState(): void {
        const proc = (pid: number | null) =>
            pid === null ? null : { pid, start: processStart(pid) };
        const state: ArmState = {
            model: this.model,
            daemon: proc(this.daemonPid()),
            host: proc(this.sessionProject === null ? null : (this.host?.hostPid() ?? null)),
            store_faults: Object.fromEntries([...this.settledFaults, ...this.storeFaults]),
        };
        mkdirSync(this.armDir, { recursive: true });
        // Staged and renamed, so a kill mid-write leaves the previous state, never a torn file.
        const staged = `${this.stateFile}.${process.pid}`;
        writeFileSync(staged, JSON.stringify(state));
        renameSync(staged, this.stateFile);
    }

    private readState(): ArmState | null {
        if (!existsSync(this.stateFile)) return null;
        return JSON.parse(readFileSync(this.stateFile, "utf8")) as ArmState;
    }

    private async startArm(fresh: boolean): Promise<void> {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (this.o.loopStore && eidnaraOn(this.o.arm)) this.mountStore(fresh);
        if (eidnaraOn(this.o.arm)) {
            this.daemon = new DaemonStack({
                ...this.o,
                root: this.o.armRoot,
                dataDir: this.dataDir,
                logFile: join(this.armDir, "daemon.log"),
                model: this.currentModel(),
            });
            await this.daemon.start();
            this.recordState();
            this.o.sampleDaemon?.();
            appendFileSync(join(this.o.armRoot, "eidnara.log"), "");
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
            git(this.o.armRoot, ["clone", "--quiet", "--no-hardlinks", source, target]);
            copyFileSync(join(target, ".git", "config"), join(this.armDir, `${project}.gitconfig`));
            const tracked = ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"];
            const forced = git(source, tracked).split("\0").filter(Boolean);
            this.snapshots.trackIgnored(project, forced);
            const rules: Record<string, string> = {};
            const listed = git(source, [
                "ls-files",
                "-s",
                "-z",
                "--",
                ".gitignore",
                "**/.gitignore",
            ]);
            for (const row of listed.split("\0").filter(Boolean)) {
                const [meta, path] = row.split("\t") as [string, string];
                rules[path] = meta.split(" ")[1] as string;
            }
            this.snapshots.trackIgnoreRules(project, rules, this.snapshots.excludeDigest(target));
        }
        await this.startArm(true);
    }

    async resume(open: ScenarioEvent | null): Promise<void> {
        const state = this.readState();
        this.model = state?.model ?? 0;
        this.storeFaults = new Map(Object.entries(state?.store_faults ?? {}));
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
        // The scheduler journals the previous event's store checks before it sends the next event,
        // so the recorded obligations drop them here, not when the checks are returned.
        this.settledFaults.clear();
        this.recordState();
        if (e.kind === "session_start") {
            await this.openSession(e, host);
            return {};
        }
        if (e.kind === "session_end") {
            const project = this.project(e);
            host.drainTools();
            this.snapshots.sessionEnd(e.session, project, this.workspace(project));
            await host.closeSession();
            this.clearStoreFill();
            this.sessionProject = null;
            this.recordState();
            if (!this.transcriptsChecked) this.checkTranscripts(host);
            // The session's background passes have settled by now, so a check they earned runs
            // here, after the state write, so the recorded obligation outlives the journal append.
            const stores = this.owedStores();
            return stores ? { stores } : {};
        }
        if (e.kind === "apply_diff") {
            this.applyDiff(e);
            return {};
        }
        const project = this.project(e);
        const dir = this.workspace(project);
        let before: string | null = "";
        if (e.probe) {
            try {
                before = this.snapshots.tree(dir);
            } catch (caught) {
                if (!(caught instanceof GitBound)) throw caught;
                before = null;
            }
        }
        // A pass served between turns earned its check before this turn's own passes.
        const outcome: TurnOutcome = {};
        const owedBefore = this.owedStores();
        if (owedBefore) outcome.stores = owedBefore;
        this.turn = e.id;
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs);
        let reported = false;
        const checkDaemon = () => {
            if (reported || !this.daemon || this.daemonPid() !== null) return;
            reported = true;
            this.o.onDaemonExit({ after: e.id });
        };
        checkDaemon();
        const tools = host.drainTools();
        this.turn = null;
        if (result.error) outcome.failed = result.error;
        if (e.probe && before === null) {
            const reason = "snapshot: git timed out before the turn";
            outcome.failed = outcome.failed ? `${outcome.failed} | ${reason}` : reason;
        } else if (e.probe && before !== null) {
            await this.o.settle?.();
            try {
                const { nested, ignoreFiles } = this.snapshots.survey(dir);
                const after = this.snapshots.tree(dir, nested);
                const reasons = [
                    nested.length > 0 ? `embedded repository at ${nested.join(", ")}` : null,
                    ...(() => {
                        const changed = this.snapshots.ignoreChanges(dir, project, ignoreFiles);
                        return changed.length > 0
                            ? [`ignore rules changed: ${changed.join(", ")}`]
                            : [];
                    })(),
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
            checkDaemon();
        }
        // After the turn and, for a probe, its settled background jobs: the check this turn earned.
        await this.restarting;
        const owedAfter = this.owedStores();
        if (owedAfter) outcome.stores = [...(outcome.stores ?? []), ...owedAfter];
        return outcome;
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
        writeFileSync(path, String(e.content));
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
            const commit = this.workspaceGit(
                dir,
                ["commit-tree", tree, "-p", head, "-m", message],
                IDENTITY,
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
            for (const entry of readdirSync(at, { withFileTypes: true })) {
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
            const restart = this.restartDaemon(this.daemon, f.id);
            restart.catch(() => undefined);
            this.restarting = restart;
            return restart;
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

    private async restartDaemon(
        daemon: DaemonStack,
        fault: string,
    ): Promise<Record<string, unknown>> {
        const before = daemon.pid();
        // An earlier restart's check that a served pass has earned is taken from this daemon.
        const stores = this.owedStores();
        this.o.sampleDaemon?.();
        await daemon.crash();
        const store = checkStore(this.storeDb);
        // Marked before the start, so a pass the replacement serves while its start settles counts.
        const mark = this.pluginLogLength();
        await daemon.restart();
        this.storeFaults.set(fault, mark);
        this.recordState();
        this.o.sampleDaemon?.();
        return {
            signal: "SIGKILL",
            pid_before: before,
            pid_after: daemon.pid(),
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
        if (!existsSync(this.pluginLog)) return false;
        const fd = openSync(this.pluginLog, "r");
        try {
            const chunk = Buffer.alloc(LOG_CHUNK_BYTES);
            let carry = "";
            let position = mark;
            for (;;) {
                const n = readSync(fd, chunk, 0, chunk.length, position);
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

    get storeDb(): string {
        return join(this.dataDir, "eidnara", "context", "store.db");
    }

    /** Settles the store checks the arm still owes, then stops everything it runs. */
    async finish(): Promise<TurnOutcome> {
        const stores = this.owedStores();
        await this.stop(true);
        return stores ? { stores } : {};
    }

    async stop(checkFinalStore = false): Promise<void> {
        const host = this.host;
        const daemon = this.daemon;
        this.host = null;
        this.daemon = null;
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
                // Staged under an exclusive create and renamed into place, so a link left at the
                // report's path is replaced rather than written through.
                const report = join(this.armDir, "store-check.json");
                const staged = `${report}.${process.pid}`;
                writeFileSync(staged, `${JSON.stringify(check)}\n`, { flag: "wx" });
                renameSync(staged, report);
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
