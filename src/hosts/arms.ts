import { type ChildProcess, spawn } from "node:child_process";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import { withDeadline } from "../run/deadline";
import { launch, plainPath, shellQuote } from "../run/launcher";
import { piCli } from "../run/preflight";
import { parentPid, processStart, stopOwnedTree } from "../run/procs";
import { FAKETIME_LIB, faketimeEnv } from "../run/timeinject";
import { sandboxPath, toolbinDir, toolchainEnv } from "../run/toolchain";

// biome-ignore lint/suspicious/noExplicitAny: v1 harness modules are imported by runtime path.
type Untyped = any;
async function v1(config: SimConfig, path: string): Promise<Untyped> {
    return import(join(config.eidnara_checkout, path));
}

/**
 * `base/rel`, walked one component at a time: each existing component must be a real
 * directory, and each missing one is created only after its parent passed, so a symlink
 * anywhere in `rel` stops the walk before anything is created beyond it.
 */
function realDir(base: string, rel: string): string {
    mkdirSync(base, { recursive: true });
    let dir = base;
    for (const part of rel.split("/").filter((p) => p !== "")) {
        dir = join(dir, part);
        let stat: ReturnType<typeof lstatSync> | undefined;
        try {
            stat = lstatSync(dir);
        } catch {
            mkdirSync(dir);
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(
                `${dir} is a symlink or not a directory; control files need a real directory`,
            );
        }
    }
    return dir;
}

export const DUMMY_AWS = {
    AWS_ACCESS_KEY_ID: "AKIDSIMV2PLACEHOLDER",
    AWS_SECRET_ACCESS_KEY: "sim-v2/placeholder+secret",
    AWS_REGION: "us-west-2",
};

export type ArmName = "host" | "eidnara" | "eidnara-kl" | "eidnara-cf";

export interface HostContext {
    config: SimConfig;
    arm: ArmName;
    host: "pi" | "opencode";
    root: string;
    launcher: string;
    offsetFile: string;
    keep: string[];
    proxyHttp1: string;
    proxyHttp2: string;
    model: string;
    contextLimit: number;
    /** Runs once the host process exists, before its readiness wait. */
    onSpawn?: () => void;
}

export interface PromptResult {
    error?: string;
}

export const eidnaraOn = (arm: ArmName) => arm !== "host";
const modelRef = (model: string) => `amazon-bedrock/${model}`;

function eidnaraUserConfig(connectionFile: string, model: string): Record<string, unknown> {
    return {
        enabled: true,
        host: { connection_file: connectionFile },
        execute_threshold_percentage: 65,
        protected_tags: 20,
        history_budget_percentage: 0.15,
        history_summarizer: { model: modelRef(model) },
        context_researcher: { model: modelRef(model) },
        memory: {
            enabled: true,
            auto_promote: true,
            auto_capture: true,
            auto_search: { enabled: true },
            git_commit_indexing: { enabled: false },
        },
    };
}

export interface DaemonContext {
    config: SimConfig;
    root: string;
    dataDir: string;
    logFile: string;
    offsetFile: string;
    proxyHttp1: string;
    proxyHttp2: string;
    model: string;
}

export class DaemonStack {
    private stack: Untyped = null;
    connectionFile = "";

    constructor(private readonly ctx: DaemonContext) {}

    pid(): number | null {
        return this.stack?.child?.pid ?? null;
    }

    /** The harness runtime the daemon executes lives beside the arm, outside every path the host can write. */
    get runtimeDir(): string {
        return join(dirname(this.ctx.root), "runtime");
    }

    async start(): Promise<void> {
        const { config } = this.ctx;
        const hr = await v1(config, "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts");
        const hh = await v1(config, "packages/e2e-tests/src/rust-runner/hermetic-host.ts");
        const sources = hr.detectHarnessRuntimeSources();
        if (!sources.ok) throw new Error(`harness runtime sources: ${sources.reason}`);
        // The runtime is regenerated on every start, so whatever an earlier session left there goes first.
        rmSync(this.runtimeDir, { recursive: true, force: true });
        // The store sits beside the arm root, so its walk starts at the arm directory both share.
        const armDir = dirname(this.ctx.root);
        const runtimeDir = realDir(armDir, "runtime");
        const store = relative(armDir, this.ctx.dataDir);
        if (store.startsWith("..") || isAbsolute(store)) {
            throw new Error(`daemon store ${this.ctx.dataDir} lies outside ${armDir}`);
        }
        realDir(armDir, store);
        const harnessRuntime = hr.writeHarnessRuntime({
            dir: runtimeDir,
            sources: sources.sources,
            piInstall: config.pi_install,
            opencodeBaseUrl: this.ctx.proxyHttp1,
            piBaseUrl: this.ctx.proxyHttp2,
            anthropicSentinelUrl: this.ctx.proxyHttp1,
            credentials: {
                accessKeyId: DUMMY_AWS.AWS_ACCESS_KEY_ID,
                secretAccessKey: DUMMY_AWS.AWS_SECRET_ACCESS_KEY,
                region: DUMMY_AWS.AWS_REGION,
            },
        });
        this.stack = await hh.HermeticHostStack.start({
            dataDir: this.ctx.dataDir,
            fixtureBin: config.daemon_binary,
            startTimeoutMs: 300_000,
            harnessRuntime,
            credentialSource: DUMMY_AWS,
            daemonConfig: { history_summarizer: { module_model: modelRef(this.ctx.model) } },
            daemonEnv: faketimeEnv(this.ctx.offsetFile),
        });
        this.connectionFile = this.stack.connectionFile;
        this.attach();
    }

    private logError: unknown;

    /**
     * Every chunk the daemon writes goes to `daemon.log` as it arrives, so a kill at any point
     * loses nothing already written. O_NOFOLLOW makes a symlink left at the log path fail the
     * append instead of redirecting it, O_NONBLOCK turns a FIFO with no reader into ENXIO instead
     * of a blocked open, and anything but a regular file is refused; the first failure surfaces
     * at stop.
     */
    private append(chunk: Buffer): void {
        const flags =
            constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK;
        try {
            const fd = openSync(this.ctx.logFile, flags, 0o600);
            try {
                if (!fstatSync(fd).isFile())
                    throw new Error(`${this.ctx.logFile} is not a regular file`);
                for (let at = 0; at < chunk.length; ) at += writeSync(fd, chunk, at);
            } finally {
                closeSync(fd);
            }
        } catch (caught) {
            this.logError ??= caught;
        }
    }

    /**
     * Follows the current daemon generation's output; a restart attaches to the next one. The
     * output the stack captured while the generation started is written first, so the log opens
     * with the startup lines the readiness wait consumed.
     */
    private attach(): void {
        const stack = this.stack;
        if (!stack) return;
        const captured = `${stack.stdout ?? ""}${stack.stderr ?? ""}`;
        if (captured.length > 0) this.append(Buffer.from(captured));
        const child = stack.child;
        const sink = (chunk: Buffer) => this.append(chunk);
        child?.stdout?.on("data", sink);
        child?.stderr?.on("data", sink);
    }

    async restart(): Promise<void> {
        await this.stack.restartHost();
        this.attach();
    }

    async stop(): Promise<void> {
        const stack = this.stack;
        if (!stack) return;
        this.stack = null;
        const failures: unknown[] = [];
        try {
            await stack.terminateHost();
        } catch (caught) {
            // terminateHost gives up after SIGTERM; the stack's SIGKILL path ends the daemon.
            failures.push(caught);
            await stack.crashHost().catch((killFailure: unknown) => failures.push(killFailure));
        }
        if (this.logError !== undefined) failures.push(this.logError);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new Error(`daemon stop failed: ${failures.map(String).join("; ")}`);
        }
    }
}

function turnResult(outcome: Untyped): PromptResult {
    const messages = (outcome.messages ?? []) as Array<Record<string, Untyped>>;
    const last = messages.filter((m) => m.role === "assistant").at(-1);
    return last?.stopReason === "error" ? { error: String(last.errorMessage ?? "error") } : {};
}

/** The canonical node preflight probes; `root` is the install tree the sandbox keeps read-only. */
export function nodeInstall(which: string): { exe: string; bin: string; root: string } {
    const exe = realpathSync(which);
    return { exe, bin: dirname(exe), root: resolve(exe, "../..") };
}

export const hostNode = () => nodeInstall(Bun.which("node") ?? "node");

/** Paths every sandboxed process of an arm reads but must not change: toolchains, the interposer, Eidnara sources, the clock. */
export function readOnlyPaths(ctx: {
    config: SimConfig;
    launcher: string;
    offsetFile: string;
}): string[] {
    const { config, launcher } = ctx;
    const interposer = dirname(dirname(FAKETIME_LIB));
    return [
        ...config.toolchain.keep,
        toolbinDir(launcher),
        interposer,
        config.eidnara_checkout,
        // The scheduler writes the scenario clock from outside; hosts only read it.
        dirname(ctx.offsetFile),
    ];
}

export abstract class SimHost {
    readonly toolchain: { path: string; env: Record<string, string> };

    constructor(readonly ctx: HostContext) {
        this.toolchain = toolchainEnv(ctx.config, ctx.launcher);
    }

    get timeEnv(): Record<string, string> {
        return faketimeEnv(this.ctx.offsetFile);
    }

    /** Paths the host reads but must not change: toolchains, the interposer, eidnara sources. */
    get readOnly(): string[] {
        return readOnlyPaths(this.ctx);
    }

    /** The launcher masks the run root, so a workspace exists inside the sandbox only below a kept path. */
    protected requireKeptWorkspace(cwd: string): void {
        const real = realpathSync(cwd);
        const kept = this.ctx.keep.map((k) => realpathSync(k));
        if (!kept.some((k) => real === k || real.startsWith(`${k}/`))) {
            throw new Error(`workspace ${cwd} is not under a kept path`);
        }
    }

    protected controlDir(rel: string): string {
        return realDir(this.ctx.root, rel);
    }

    /** The file is created fresh and renamed into place, so a symlink left at `path` is replaced, never followed. */
    protected writeControlFile(path: string, content: string): void {
        const staged = `${path}.${process.pid}`;
        writeFileSync(staged, content, { flag: "wx" });
        renameSync(staged, path);
    }

    // A launch whose start time was never read cannot be told from a reused pid, so it is
    // left alone; its launcher had already exited, which ends the sandbox's namespace.
    protected async stopTree(pid: number | null | undefined, start: string | null): Promise<void> {
        if (pid == null || start === null) return;
        if (!(await stopOwnedTree(pid, 10_000, start)))
            throw new Error(`host tree ${pid} survived SIGKILL`);
    }

    abstract openSession(cwd: string, session: string, connection: string | null): Promise<void>;
    abstract prompt(text: string, timeoutMs: number): Promise<PromptResult>;
    abstract closeSession(): Promise<void>;
    abstract transcriptEnv(): Record<string, string>;
    abstract hostPid(): number | null;
}

export class PiSimHost extends SimHost {
    private rpc: Untyped = null;
    private launchStart: string | null = null;
    readonly agentDir = join(this.ctx.root, "home/.pi/agent");

    private writeConfigs(connectionFile: string | null): void {
        const agentDir = this.controlDir("home/.pi/agent");
        const settings = {
            packages: [],
            defaultProvider: "amazon-bedrock",
            defaultModel: this.ctx.model,
            enabledModels: [modelRef(this.ctx.model)],
            compaction: { enabled: this.ctx.arm === "host" || this.ctx.arm === "eidnara-kl" },
            retry: { enabled: true },
            defaultThinkingLevel: "off",
            quietStartup: true,
            enableInstallTelemetry: false,
        };
        this.writeControlFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
        const model = {
            id: this.ctx.model,
            name: this.ctx.model,
            api: "bedrock-converse-stream",
            reasoning: false,
            input: ["text"],
            contextWindow: this.ctx.contextLimit,
            maxTokens: 8192,
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        };
        const providers = { "amazon-bedrock": { baseUrl: this.ctx.proxyHttp2, models: [model] } };
        this.writeControlFile(
            join(agentDir, "models.json"),
            JSON.stringify({ providers }, null, 2),
        );
        if (connectionFile) {
            const dir = this.controlDir("home/config/eidnara");
            const config = eidnaraUserConfig(connectionFile, this.ctx.model);
            this.writeControlFile(join(dir, "eidnara.jsonc"), JSON.stringify(config, null, 2));
        }
    }

    async openSession(cwd: string, session: string, connection: string | null): Promise<void> {
        this.requireKeptWorkspace(cwd);
        const { config } = this.ctx;
        const rpcClient = await v1(config, "packages/e2e-tests/src/pi-runner/rpc-client.ts");
        this.writeConfigs(connection);
        const cli = piCli(config);
        const args = [cli, "--mode", "rpc", "--session-id", `sim-${session}`];
        args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes");
        if (connection)
            args.push("--extension", join(config.eidnara_checkout, "packages/pi-plugin"));
        args.push("--model", modelRef(this.ctx.model));
        const node = hostNode();
        const home = join(this.ctx.root, "home");
        const tools = this.toolchain;
        const env = {
            PATH: `${node.bin}:${sandboxPath(tools.path)}`,
            ...tools.env,
            ...DUMMY_AWS,
            HOME: home,
            PI_CODING_AGENT_DIR: this.agentDir,
            XDG_CONFIG_HOME: join(home, "config"),
            XDG_DATA_HOME: join(home, "data"),
            XDG_CACHE_HOME: join(home, "cache"),
            EIDNARA_LOG_PATH: join(this.ctx.root, "eidnara.log"),
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
        };
        const ro = [...this.readOnly, node.root, config.pi_install];
        const argv = launch(
            this.ctx.launcher,
            this.ctx.keep,
            this.timeEnv,
            [node.exe, ...args],
            ro,
            cwd,
        );
        // The shell waits for one line on fd 3 before it execs the launcher, so Pi starts only once
        // the driver has recorded the pid; stdin stays Pi's RPC channel. A harness that dies first
        // closes the pipe and the shell exits, and a record that fails ends the shell the same way.
        const gated = ["/bin/sh", "-c", 'read _ <&3 && exec 3<&- "$@"', "sh", ...argv];
        const child: ChildProcess = spawn(gated[0] as string, gated.slice(1), {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        this.launchStart = child.pid === undefined ? null : processStart(child.pid);
        const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
        spawnError.catch(() => undefined);
        this.rpc = new rpcClient.PiRpcProcess(child, new rpcClient.PiRpcProtocol(), {
            stderrLimit: 20_000,
        });
        const gate = child.stdio[3] as import("node:stream").Writable | null;
        try {
            this.ctx.onSpawn?.();
        } catch (caught) {
            gate?.destroy();
            child.kill("SIGKILL");
            this.rpc = null;
            throw caught;
        }
        gate?.end("\n");
        const ready = this.rpc.sendCommand("get_state", {}, { timeoutMs: 120_000 });
        try {
            const state = await Promise.race([ready, spawnError]);
            if (state.success === false) {
                throw new Error(`Pi get_state refused: ${JSON.stringify(state).slice(0, 2000)}`);
            }
        } catch (caught) {
            await this.closeSession();
            throw caught;
        }
    }

    hostPid(): number | null {
        return this.rpc?.child?.pid ?? null;
    }

    // Pi emits `agent_end` with `willRetry: true` before it retries a failed request itself,
    // so the turn is over only at an end Pi will not retry.
    private agentEnd(timeoutMs: number, signal?: AbortSignal): Promise<Untyped> {
        const end = this.rpc.waitForEvent(
            (e: Untyped) => e.type === "agent_end" && e.willRetry !== true,
            { timeoutMs, label: "agent_end", signal },
        );
        end.catch(() => undefined);
        return end;
    }

    async prompt(text: string, timeoutMs: number): Promise<PromptResult> {
        const deadline = Date.now() + timeoutMs;
        const watch = { activity: 0, last: undefined as Untyped, promised: 0 };
        const off = this.rpc.onEvent((e: Untyped) => {
            if (e.type === "agent_start" || e.type === "compaction_start") watch.activity++;
            // compaction_end with willRetry promises a fresh run, which settles only at its own end.
            if (e.type === "compaction_end" && e.willRetry === true) {
                watch.activity++;
                watch.promised++;
            }
            if (e.type === "agent_start" && watch.promised > 0) watch.promised--;
            if (e.type === "agent_end" && e.willRetry !== true) {
                watch.activity++;
                watch.last = e;
            }
        });
        const waiting = new AbortController();
        const end = this.agentEnd(timeoutMs, waiting.signal);
        let settling = false;
        try {
            const response = await this.rpc.sendCommand("prompt", { message: text }, { timeoutMs });
            if (response.success === false) {
                waiting.abort();
                return { error: JSON.stringify(response).slice(0, 2000) };
            }
            await end;
            settling = true;
            return turnResult(await this.settle(watch, deadline));
        } catch (caught) {
            // An agent_end already seen settles the turn, whatever became of the prompt response.
            if (watch.last && !settling) {
                settling = true;
                try {
                    return turnResult(await this.settle(watch, deadline));
                } catch {
                    // A settle that fails here takes the abort-and-drain path below.
                }
            }
            const drained = this.agentEnd(this.drainMs);
            await this.rpc.sendCommand("abort", {}, { timeoutMs: 60_000 }).catch(() => undefined);
            // A turn that outlives the abort would end during the next turn and be taken for it.
            await drained.catch((reason: unknown) => {
                throw new Error(
                    `Pi turn still running ${this.drainMs} ms after abort (${String(reason)})`,
                );
            });
            return { error: String(caught).slice(0, 2000) };
        } finally {
            off();
        }
    }

    // After its last agent_end, Pi may compact and continue the run, emitting compaction_start
    // and a fresh agent_start. The turn is settled once Pi reports itself idle and a quiet window
    // passes with neither, and the turn's result is then the last agent_end Pi will not retry.
    protected settleMs = 1_000;
    protected drainMs = 30_000;

    private async settle(
        watch: { activity: number; last: Untyped; promised: number },
        deadline: number,
    ): Promise<Untyped> {
        for (;;) {
            const mark = watch.activity;
            await Bun.sleep(Math.max(0, Math.min(this.settleMs, deadline - Date.now())));
            // The state check gets the turn's remaining time, with at least 1 s to answer.
            const timeoutMs = Math.max(1_000, deadline - Date.now());
            const state = await this.rpc.sendCommand("get_state", {}, { timeoutMs });
            if (state.success === false) {
                throw new Error(`Pi get_state refused while settling: ${JSON.stringify(state)}`);
            }
            const busy = state.data?.isStreaming === true || state.data?.isCompacting === true;
            if (!busy && watch.promised === 0 && watch.activity === mark) return watch.last;
            if (Date.now() >= deadline) throw new Error("Pi turn still busy at its deadline");
        }
    }

    async closeSession(): Promise<void> {
        const rpc = this.rpc;
        this.rpc = null;
        if (!rpc) return;
        rpc.child.stdin?.end();
        try {
            await this.stopTree(rpc.child.pid, this.launchStart);
        } finally {
            await rpc.shutdown(10_000);
        }
    }

    transcriptEnv(): Record<string, string> {
        return { PI_CODING_AGENT_DIR: this.agentDir };
    }
}

export class OpencodeSimHost extends SimHost {
    private oc: Untyped = null;
    private client: Untyped = null;
    private sid: string | null = null;
    private readonly home = join(this.ctx.root, "home");
    protected abortWaitMs = 30_000;
    private launched: { pid: number | null; start: string | null } | null = null;

    async openSession(cwd: string, session: string, connection: string | null): Promise<void> {
        this.requireKeptWorkspace(cwd);
        const { config } = this.ctx;
        const spawnMod = await v1(config, "packages/e2e-tests/src/opencode-runner/spawn.ts");
        const extra: Record<string, unknown> = {
            model: modelRef(this.ctx.model),
            small_model: modelRef(this.ctx.model),
            share: "disabled",
        };
        if (!connection || this.ctx.arm === "eidnara-kl") {
            extra.compaction = { auto: true, prune: true };
        }
        if (!connection) extra.plugin = [];
        const { binary, root } = opencodeInstall(config);
        const ro = [...this.readOnly, root];
        const launcher = plainPath(this.ctx.launcher);
        const hostbin = dirname(
            this.writeWrapper(launch(launcher, this.ctx.keep, this.timeEnv, [binary], ro, cwd)),
        );
        // The v1 runner rewrites the configuration on each spawn, so an earlier session's files go first.
        rmSync(join(this.controlDir("home"), "config"), { recursive: true, force: true });
        const env = {
            configDir: this.controlDir("home/config"),
            dataDir: this.controlDir("home/data"),
            cacheDir: this.controlDir("home/cache"),
            workdir: cwd,
        };
        const eidnara = connection
            ? {
                  eidnaraConfig: eidnaraUserConfig(connection, this.ctx.model),
                  userHostConnectionFile: connection,
              }
            : {};
        this.oc = await spawnMod.spawnOpencode({
            mockProviderURL: this.ctx.proxyHttp1,
            existingEnv: env,
            provisionHost: false,
            modelContextLimit: this.ctx.contextLimit,
            modelOutputLimit: 8192,
            modelId: this.ctx.model,
            bedrock: {
                baseURL: this.ctx.proxyHttp1,
                region: DUMMY_AWS.AWS_REGION,
                model: this.ctx.model,
                anthropicSentinelURL: this.ctx.proxyHttp1,
            },
            openCodeConfigExtra: extra,
            ...eidnara,
            extraEnv: {
                ...this.toolchain.env,
                ...DUMMY_AWS,
                HOME: this.home,
                XDG_STATE_HOME: join(this.home, "state"),
                EIDNARA_LOG_PATH: join(this.ctx.root, "eidnara.log"),
                PATH: `${hostbin}:${sandboxPath(this.toolchain.path)}`,
            },
        });
        const launchedPid = this.hostPid();
        this.launched = {
            pid: launchedPid,
            start: launchedPid === null ? null : processStart(launchedPid),
        };
        this.ctx.onSpawn?.();
        const sdkPath = "packages/e2e-tests/node_modules/@opencode-ai/sdk/dist/index.js";
        try {
            const sdk = await import(join(config.eidnara_checkout, sdkPath));
            this.client = sdk.createOpencodeClient({ baseUrl: this.oc.url });
            this.sid = await this.findOrCreateSession(cwd, session);
        } catch (caught) {
            await this.closeSession();
            throw caught;
        }
    }

    private async findOrCreateSession(cwd: string, session: string): Promise<string> {
        const listed = await this.client.session.list({ query: { directory: cwd } });
        if (listed.error) throw new Error(`session.list failed: ${JSON.stringify(listed.error)}`);
        const latest = ((listed.data ?? []) as Array<Record<string, Untyped>>)
            .filter((s) => s.title === `sim-${session}`)
            .at(0);
        if (latest) return String(latest.id);
        const created = await this.client.session.create({
            query: { directory: cwd },
            body: { title: `sim-${session}` },
        });
        if (!created.data)
            throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);
        return created.data.id;
    }

    /**
     * The wrapper records its own pid and start time beside the arm before it execs the launcher,
     * so a harness killed during the server's startup leaves a record the next resume can reap.
     */
    private writeWrapper(argv: string[]): string {
        const dir = join(dirname(this.ctx.launcher), "hostbin", this.ctx.arm);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "opencode");
        const staged = `${path}.${process.pid}`;
        const record = shellQuote(join(dirname(this.ctx.root), "opencode.launch"));
        // The record is staged and renamed whole, and a record that cannot be written ends the
        // wrapper before the launcher, so the server never runs unrecorded.
        const script = [
            "#!/bin/sh",
            `r=${record}`,
            `printf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" > "$r.$$" || exit 70`,
            `mv -f "$r.$$" "$r" || exit 70`,
            `exec ${argv.map(shellQuote).join(" ")} "$@"`,
            "",
        ].join("\n");
        writeFileSync(staged, script, { mode: 0o755 });
        renameSync(staged, path);
        return path;
    }

    hostPid(): number | null {
        if (!this.oc) return null;
        const port = String(this.oc.port);
        const serves = (pid: string) => {
            try {
                const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
                return cmd.includes("serve") && cmd.includes(port);
            } catch {
                return false;
            }
        };
        // The v1 runner spawns the wrapper as this process's child, and the wrapper execs the
        // launcher, so the launcher root is the one serving process whose parent is this process.
        const pids = readdirSync("/proc")
            .filter((e) => /^\d+$/.test(e) && serves(e))
            .map(Number)
            .filter((pid) => parentPid(pid) === process.pid);
        return pids.length === 1 ? (pids[0] as number) : null;
    }

    async prompt(text: string, timeoutMs: number): Promise<PromptResult> {
        const model = { providerID: "amazon-bedrock", modelID: this.ctx.model };
        const call = this.client.session.prompt({
            path: { id: this.sid },
            body: { model, parts: [{ type: "text", text }] },
        });
        const settled: Promise<{ result: Untyped } | { caught: unknown }> = call.then(
            (result: Untyped) => ({ result }),
            (caught: unknown) => ({ caught }),
        );
        const first = await withDeadline(settled, timeoutMs);
        if (first === null) {
            const abort = this.client.session.abort({ path: { id: this.sid } });
            // An abort still in flight when the next turn starts would cancel that turn instead.
            const answered = await withDeadline(
                abort.then(
                    (r: Untyped) => r?.data === true,
                    () => false,
                ),
                this.abortWaitMs,
            );
            if (answered === null) {
                throw new Error(
                    `OpenCode abort still pending ${this.abortWaitMs} ms after the deadline`,
                );
            }
            if (!answered) throw new Error("OpenCode turn not aborted after its deadline");
            const drained = await withDeadline(settled, 30_000);
            if (drained === null) throw new Error("OpenCode turn still running 30 s after abort");
            return { error: `turn deadline ${timeoutMs} ms` };
        }
        if ("caught" in first) {
            // The request failed with the server's answer unknown, so the turn is aborted before the next one.
            const abort = this.client.session.abort({ path: { id: this.sid } }).then(
                (r: Untyped) => r?.data === true,
                () => false,
            );
            const error = String(first.caught).slice(0, 2000);
            if (!(await withDeadline(abort, this.abortWaitMs))) {
                throw new Error(`OpenCode turn not aborted after a rejected prompt (${error})`);
            }
            return { error };
        }
        const { result } = first;
        if (result.error) return { error: JSON.stringify(result.error).slice(0, 2000) };
        const info = result.data?.info;
        return info?.error ? { error: JSON.stringify(info.error).slice(0, 2000) } : {};
    }

    async closeSession(): Promise<void> {
        const oc = this.oc;
        const launched = this.launched ?? { pid: this.hostPid(), start: null };
        this.oc = null;
        this.client = null;
        this.launched = null;
        if (!oc) return;
        try {
            await this.stopTree(launched.pid, launched.start);
        } finally {
            await oc.kill();
        }
    }

    transcriptEnv(): Record<string, string> {
        return { XDG_DATA_HOME: join(this.home, "data") };
    }
}

export function opencodeInstall(config: SimConfig): { binary: string; root: string } {
    const binary = plainPath(realpathSync(config.opencode_binary));
    // An npm install keeps its package tree read-only; a standalone binary keeps its own directory.
    const npm = /\/node_modules\/opencode-ai\/bin\/[^/]+$/.test(binary);
    return { binary, root: npm ? dirname(dirname(dirname(binary))) : dirname(binary) };
}

export function makeHost(ctx: HostContext): SimHost {
    return ctx.host === "pi" ? new PiSimHost(ctx) : new OpencodeSimHost(ctx);
}
