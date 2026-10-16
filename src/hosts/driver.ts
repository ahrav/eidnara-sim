import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GitBound, git } from "../git";
import type { CallView } from "../grade/artefacts";
import { sha256Hex } from "../prereg/canonical";
import { processStart, running, stopOwnedTree } from "../run/procs";
import { type ArmDriver, HarnessFailure, type ScenarioEvent } from "../run/scheduler";
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

interface ArmState {
    model: number;
    daemon: { pid: number; start: string | null } | null;
    host: { pid: number; start: string | null } | null;
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
    hostFactory?: (ctx: HostContext) => SimHost;
    onDaemonExit: (detail: Record<string, unknown>) => void;
}

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
]);

export class HostDriver implements ArmDriver {
    host: SimHost | null = null;
    daemon: DaemonStack | null = null;
    private model = 0;
    private storeMount: string | null = null;
    private sessionProject: string | null = null;
    private transcriptsChecked = false;

    private readonly snapshots: SnapshotRecorder;

    constructor(private readonly o: DriverOptions) {
        this.snapshots = new SnapshotRecorder(
            dirname(o.armRoot),
            o.arm,
            o.callsFor ?? (() => []),
            o.turnDeadlineMs,
        );
    }

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
        const onTool = (run: ToolRun) => this.snapshots.addTools([run]);
        return make({ ...this.o, keep, root: this.o.armRoot, model: this.currentModel(), onTool });
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
            const exclude = join(target, ".git", "info", "exclude");
            const digest = existsSync(exclude) ? sha256Hex(readFileSync(exclude, "utf8")) : null;
            this.snapshots.trackIgnoreRules(project, rules, digest);
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

    async event(e: ScenarioEvent): Promise<{ failed?: string; snapshot?: string }> {
        const host = this.requireHost();
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
            return {};
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
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs);
        if (this.daemon && this.daemonPid() === null) this.o.onDaemonExit({ after: e.id });
        const tools = host.drainTools();
        const outcome: { failed?: string; snapshot?: string } = {};
        if (result.error) outcome.failed = result.error;
        if (e.probe && before === null) {
            const reason = "snapshot: git timed out before the turn";
            outcome.failed = outcome.failed ? `${outcome.failed} | ${reason}` : reason;
        } else if (e.probe && before !== null) {
            await this.o.settle?.();
            try {
                const nested = this.snapshots.embedded(dir);
                const after = this.snapshots.tree(dir, nested);
                const reasons = [
                    nested.length > 0 ? `embedded repository at ${nested.join(", ")}` : null,
                    ...(() => {
                        const changed = this.snapshots.ignoreChanges(dir, project);
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
        if (!inside || !contained || lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
            throw new HarnessFailure(`apply_diff path ${String(e.path)} leaves ${dir}`);
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
            this.workspaceGit(dir, ["update-index", "--add", "--cacheinfo", entry]);
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
        const scope = { GIT_DIR: gitDir, GIT_WORK_TREE: dir, ...extra };
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
        for (const entry of readdirSync(gitDir, { recursive: true, withFileTypes: true })) {
            if (entry.isFile() || entry.isDirectory()) continue;
            const at = join(relative(dir, entry.parentPath), entry.name);
            const kind = entry.isSymbolicLink()
                ? "a symlink; git would write through it"
                : "not a regular file";
            throw new HarnessFailure(`${at} is ${kind}`);
        }
        if (existsSync(join(gitDir, "objects", "info", "alternates"))) {
            throw new HarnessFailure(".git/objects/info/alternates names another object store");
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
            const before = this.daemonPid();
            await this.daemon.restart();
            this.recordState();
            const after = this.daemonPid();
            return {
                signal: "SIGKILL",
                pid_before: before,
                pid_after: after,
                restarted_by: "harness",
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

    async finish(): Promise<void> {
        await this.stop();
    }

    async stop(): Promise<void> {
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
