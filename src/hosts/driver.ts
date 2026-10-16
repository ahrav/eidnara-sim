import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { processStart, running, stopOwnedTree } from "../run/procs";
import { type ArmDriver, HarnessFailure, type ScenarioEvent } from "../run/scheduler";
import type { FaultEpisode } from "../scenario/faults";
import {
    type DaemonContext,
    DaemonStack,
    eidnaraOn,
    type HostContext,
    makeHost,
    type SimHost,
} from "./arms";

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
    /** Wall time of scenario time 0, the same value the clock offset targets. */
    baseMs: number;
    hostFactory?: (ctx: HostContext) => SimHost;
    daemonFactory?: (ctx: DaemonContext) => DaemonStack;
    onDaemonExit: (detail: Record<string, unknown>) => void;
}

const git = (cwd: string, args: string[], dateMs?: number) => {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "sim-user",
        GIT_AUTHOR_EMAIL: "sim-user@users.noreply.github.com",
        GIT_COMMITTER_NAME: "sim-user",
        GIT_COMMITTER_EMAIL: "sim-user@users.noreply.github.com",
    };
    if (dateMs !== undefined) {
        env.GIT_AUTHOR_DATE = `@${Math.floor(dateMs / 1000)} +0000`;
        env.GIT_COMMITTER_DATE = env.GIT_AUTHOR_DATE;
    }
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
};

/** The rename publishes a complete file, so a kill mid-write leaves the previous one. */
function writeWhole(path: string, text: string): void {
    const staged = `${path}.${process.pid}`;
    writeFileSync(staged, text);
    renameSync(staged, path);
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

const BETWEEN_SESSIONS = new Set(["daemon_restart", "plugin_reload", "model_switch"]);

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
        const onSpawn = () => this.recordState();
        return make({ ...this.o, keep, root: this.o.armRoot, model: this.currentModel(), onSpawn });
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
        writeWhole(this.stateFile, JSON.stringify(state));
    }

    private readState(): ArmState | null {
        if (!existsSync(this.stateFile)) return null;
        return JSON.parse(readFileSync(this.stateFile, "utf8")) as ArmState;
    }

    private get ballast(): string | null {
        return this.storeMount ? join(this.storeMount, "ballast") : null;
    }

    private async startArm(fresh: boolean): Promise<void> {
        mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
        if (this.o.loopStore && eidnaraOn(this.o.arm)) this.mountStore(fresh);
        const filled = this.ballast !== null && existsSync(this.ballast);
        if (filled) this.clearStoreFill();
        if (eidnaraOn(this.o.arm)) {
            const make = this.o.daemonFactory ?? ((ctx: DaemonContext) => new DaemonStack(ctx));
            this.daemon = make({
                ...this.o,
                root: this.o.armRoot,
                dataDir: this.dataDir,
                logFile: join(this.armDir, "daemon.log"),
                model: this.currentModel(),
            });
            await this.daemon.start();
            this.recordState();
        }
        if (filled) this.fillStore();
        this.host = this.newHost();
        this.recordState();
    }

    async reset(): Promise<void> {
        await this.stop();
        this.model = 0;
        this.transcriptsChecked = false;
        await this.reapStale();
        for (const dir of [this.o.armRoot, this.storeRoot])
            rmSync(dir, { recursive: true, force: true });
        rmSync(this.image, { force: true });
        mkdirSync(join(this.o.armRoot, "workspaces"), { recursive: true });
        for (const [project, source] of Object.entries(this.o.projects)) {
            const target = this.workspace(project);
            git(this.o.armRoot, ["clone", "--quiet", "--no-hardlinks", source, target]);
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
                if (!(await stopOwnedTree(proc.pid, 5_000))) {
                    throw new HarnessFailure(`recorded process ${proc.pid} survived SIGKILL`);
                }
            }
        }
        if (spawnSync("findmnt", ["-n", "-M", this.storeRoot]).status === 0) {
            run(["sudo", "-n", "umount", this.storeRoot]);
        }
    }

    private async openSession(e: ScenarioEvent, host: SimHost): Promise<void> {
        this.sessionProject = this.project(e);
        const connection = this.daemon?.connectionFile ?? null;
        await host.openSession(this.workspace(this.sessionProject), e.session, connection);
        this.recordState();
    }

    async event(e: ScenarioEvent): Promise<{ failed?: string }> {
        const host = this.requireHost();
        if (e.kind === "session_start") {
            await this.openSession(e, host);
            return {};
        }
        if (e.kind === "session_end") {
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
        const result = await host.prompt(String(e.text), this.o.turnDeadlineMs);
        if (this.daemon && this.daemonPid() === null) this.o.onDaemonExit({ after: e.id });
        return result.error ? { failed: result.error } : {};
    }

    private project(e: ScenarioEvent): string {
        const project = e.project ?? this.sessionProject;
        if (typeof project !== "string") throw new HarnessFailure(`event ${e.id} names no project`);
        return project;
    }

    private applyDiff(e: ScenarioEvent): void {
        const dir = realpathSync(this.workspace(this.project(e)));
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
        writeFileSync(path, String(e.content));
        git(dir, ["add", "--", path]);
        if (
            spawnSync("git", ["diff", "--cached", "--quiet", "--", path], { cwd: dir }).status === 0
        ) {
            return;
        }
        const message = `Add ${String(e.path)}`;
        const when = this.o.baseMs + e.scenario_ms;
        git(dir, ["commit", "--quiet", "--no-verify", "-m", message, "--", path], when);
    }

    private checkTranscripts(host: SimHost): void {
        const env = host.transcriptEnv();
        const paths = this.o.transcriptPaths.map((t) => expandTemplate(t, env));
        const missing = paths.filter((p) => !existsSync(p));
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

    private fillStore(): Record<string, unknown> {
        if (!this.storeMount) return { skipped: "arm runs no loop-mounted store" };
        const ballast = join(this.storeMount, "ballast");
        const free = run(["df", "-B1", "--output=avail", this.storeMount])
            .trim()
            .split("\n")
            .at(-1);
        spawnSync("fallocate", ["-l", String(free), ballast]);
        const append = ["if=/dev/zero", `of=${ballast}`, "bs=1M", "oflag=append", "conv=notrunc"];
        spawnSync("dd", append);
        const df = run(["df", "--output=avail", this.storeMount]);
        const avail = Number(df.trim().split("\n").at(-1));
        if (avail !== 0) throw new HarnessFailure(`store_full left ${avail} KiB free`);
        return { mount: this.storeMount, avail_kb: avail };
    }

    private clearStoreFill(): void {
        if (this.ballast) rmSync(this.ballast, { force: true });
    }

    async finish(): Promise<void> {
        await this.stop();
    }

    async stop(): Promise<void> {
        const host = this.host;
        const daemon = this.daemon;
        this.host = null;
        this.daemon = null;
        this.sessionProject = null;
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
