import { spawnSync } from "node:child_process";
import {
    constants,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
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
    armBase,
    DaemonStack,
    eidnaraOn,
    type HostContext,
    makeHost,
    type SimHost,
    type ToolRun,
} from "./arms";
import { entriesOf, SnapshotRecorder } from "./snapshot";
import { checkStore, type Deletion, deleteFactNotes, memoryNotes } from "./storecheck";

interface ArmState {
    model: number;
    upgraded?: boolean;
    second?: { pid: number; start: string | null } | null;
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
    /** Awaited after a probe turn and before its snapshot, so background calls the turn started are on record. */
    settle?: () => Promise<void>;
    /** Entries a walk of a workspace `.git` visits at most; the default is `GIT_DIR_ENTRY_CAP`. */
    gitDirEntryCap?: number;
    hostFactory?: (ctx: HostContext) => SimHost;
    /** The host's pinned and `config.upgrade` versions, as the run's preflight recorded them. */
    hostVersions?: { from: string; to: string | null };
    onDaemonExit: (detail: Record<string, unknown>) => void;
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
    /** Daemon restarts that the end of the current or next turn owes a store check. */
    private storeFaults: string[] = [];

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

    /**
     * The primary host reports its tool runs to the snapshot recorder; a second client's runs
     * stay out of the primary session's command log.
     */
    private newHost(primary = true): SimHost {
        const make = this.o.hostFactory ?? makeHost;
        const arm = armBase(this.o.arm);
        const keep = eidnaraOn(arm) ? [...this.o.keep, this.storeRoot] : this.o.keep;
        const up = this.upgraded ? (this.o.config.upgrade ?? {}) : {};
        const config = { ...this.o.config, ...up };
        const onTool = (run: ToolRun) => this.snapshots.addTools([run]);
        return make({
            ...this.o,
            config,
            arm,
            keep,
            root: this.o.armRoot,
            model: this.currentModel(),
            ...(primary ? { onTool } : {}),
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
            git(this.o.armRoot, ["clone", "--quiet", "--no-hardlinks", source, target]);
            const baseline = join(this.armDir, `${project}.gitconfig`);
            rmSync(baseline, { force: true });
            copyFileSync(join(target, ".git", "config"), baseline, constants.COPYFILE_EXCL);
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
        await this.startArm(true);
    }

    async resume(open: ScenarioEvent | null): Promise<void> {
        const state = this.readState();
        this.model = state?.model ?? 0;
        this.upgraded = state?.upgraded ?? false;
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
        await host.openSession(dir, e.session, connection);
        this.recordState();
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
            this.snapshots.logTurnTools(host.drainTools(), null);
            this.snapshots.sessionEnd(e.session, project, this.workspace(project));
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
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs, interruptMs);
        let reported = false;
        const checkDaemon = () => {
            if (reported || !this.daemon || this.daemonPid() !== null) return;
            reported = true;
            this.o.onDaemonExit({ after: e.id });
        };
        checkDaemon();
        const tools = host.drainTools();
        this.snapshots.logTurnTools(tools, e.id);
        const outcome: TurnOutcome = result.interrupted ? { user: { interrupted: true } } : {};
        if (result.error) outcome.failed = result.error;
        if (this.storeFaults.length > 0 && this.daemon) {
            const store = checkStore(this.storeDb);
            outcome.stores = this.storeFaults.map((fault) => ({ fault, store }));
            this.storeFaults = [];
        }
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
            checkDaemon();
        }
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
        try {
            second.drainTools();
            await second.closeSession();
        } finally {
            if (record) this.recordState();
        }
    }

    private async secondClient(at?: ScenarioEvent): Promise<Record<string, unknown>> {
        if (!this.daemon) return { skipped: "arm runs no daemon" };
        if (at?.kind !== "session_start") {
            throw new HarnessFailure("two_hosts_one_daemon fires at a session_start");
        }
        const second = this.newHost(false);
        const session = `${at.session}-b`;
        this.second = second;
        try {
            await second.openSession(
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
        this.host = null;
        this.daemon = null;
        let failure: unknown = null;
        for (const close of [() => host?.closeSession(), () => this.closeSecond(false)]) {
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
