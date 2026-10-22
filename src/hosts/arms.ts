import { type ChildProcess, spawn } from "node:child_process";
import {
    closeSync,
    constants,
    existsSync,
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
import { dirname, isAbsolute, join, relative } from "node:path";
import type { SimConfig } from "../config/config";
import { withDeadline } from "../run/deadline";
import { nodeInstall } from "../run/interception";
import { launch, plainPath, shellQuote } from "../run/launcher";
import { piCli } from "../run/preflight";
import { parentPid, processStart, stopOwnedTree } from "../run/procs";
import { FAKETIME_LIB, faketimeEnv } from "../run/timeinject";
import { sandboxPath, toolbinDir, toolchainEnv } from "../run/toolchain";
import { ARM_PROFILES, type ArmName } from "./profiles";

export type { ArmName };

// biome-ignore lint/suspicious/noExplicitAny: v1 harness modules are imported by runtime path.
type Untyped = any;
async function v1(config: SimConfig, path: string): Promise<Untyped> {
    return import(join(config.eidnara_checkout, path));
}

/**
 * `base`, created if missing: its nearest existing ancestor must resolve to itself, so the
 * new directories remain beneath that verified ancestor.
 */
function realBase(base: string): string {
    let existing = base;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    if (realpathSync(existing) !== existing) {
        throw new Error(
            `${base} is reached through a symlink; control files need a real directory`,
        );
    }
    mkdirSync(base, { recursive: true });
    return base;
}

/**
 * `base/rel`, walked one component at a time: each existing component must be a real
 * directory, and each missing one is created only after its parent passed, so a symlink
 * anywhere in `rel` stops the walk before anything is created beyond it.
 */
function realDir(base: string, rel: string): string {
    let dir = realBase(base);
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
    /** The model of Eidnara's own summarizer and researcher calls; the agent model by default. */
    sideModel?: string;
    now?: () => number;
    /**
     * The host invokes `onTool` as it records a run; `drainTools` invokes it for the runs it
     * adds itself. A run with a `call` id may be reported at its start with a null exit and
     * again at its end, and the later report replaces the earlier one.
     */
    onTool?: (run: ToolRun) => void;
    /** Runs once the host process exists, before its readiness wait. */
    onSpawn?: () => void;
    /** Reads a process's start identity; the default reads `/proc`. */
    procStart?: (pid: number) => string | null;
}

export interface ToolRun {
    command: string;
    exit: number | null;
    scenario_ms: number;
    /** The host's id for the run, when it reports a start before the end; a later report with the same id replaces the earlier one. */
    call?: string;
    /** Set on a run reported after its turn, at recovery time; the recorder attributes it to no turn. */
    recovered?: true;
}

const TARGET_KEYS = ["path", "filePath", "pattern", "file_path"];

export function toolCommand(tool: string, args: Record<string, unknown> | undefined): string {
    if (typeof args?.command === "string") return args.command;
    const key = TARGET_KEYS.find((k) => typeof args?.[k] === "string");
    if (!key || !args) return `${tool} ${JSON.stringify(args ?? {})}`;
    const rest = Object.entries(args).filter(([k, v]) => k !== key && v !== undefined);
    const scalars = rest
        .filter(([, v]) => typeof v !== "string" && typeof v !== "object")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .sort();
    const body = rest
        .filter(([, v]) => typeof v === "string" || typeof v === "object")
        .map(([, v]) => (typeof v === "string" ? v : JSON.stringify(v)));
    const head = [`${tool} ${args[key]}`, ...scalars].join(" ");
    return [head, ...body].join("\n");
}

export interface PromptResult {
    error?: string;
    /** The host never sent the text: the turn failed before its prompt. */
    undelivered?: true;
    /** The user aborted the turn through the host's abort path. */
    interrupted?: boolean;
}

export const eidnaraOn = (arm: ArmName) => ARM_PROFILES[arm].plugin;

/** An A/A control arm `host~aa` runs as `host` under its own label. */
export const armBase = (label: string) => label.split("~")[0] as ArmName;
/** A control label: a run arm, a tilde, and a tag; nothing a path could carry. */
export const CONTROL_LABEL = /^[a-z-]+~[a-z0-9]+$/;

/**
 * Admits a manifest order of pre-registered arms and A/A controls: a control's label matches
 * `CONTROL_LABEL`, its arm is in `pairs` and runs right before it, and each arm has at most one.
 */
export function requireOrder(
    order: readonly string[],
    arms: readonly string[],
    pairs: readonly (readonly string[])[],
): void {
    for (const arm of order) {
        const base = armBase(arm);
        const known =
            arms.includes(base) &&
            (arm === base ||
                (CONTROL_LABEL.test(arm) && pairs.some(([x, y]) => x === base && y === base)));
        if (!known) throw new Error(`manifest arm ${arm} is not a pre-registered arm`);
    }
    const controls = order.filter((arm) => arm !== armBase(arm));
    for (const control of controls) {
        const base = armBase(control);
        if (!order.includes(base)) throw new Error(`manifest arm ${control} runs without ${base}`);
        if (order.indexOf(control) !== order.indexOf(base) + 1) {
            throw new Error(`manifest arm ${control} runs apart from ${base}`);
        }
        if (controls.filter((c) => armBase(c) === base).length > 1) {
            throw new Error(`manifest order runs two A/A controls of ${base}`);
        }
    }
}

/**
 * `requireSeedOrder` requires at least one run arm, the run arms in `seedOrder`'s relative
 * order, and each A/A control right after its arm, once, for a registered `[arm, arm]` pair.
 */
export function requireSeedOrder(
    order: unknown,
    seedOrder: readonly string[],
    pairs: readonly (readonly string[])[],
): asserts order is string[] {
    const shown = JSON.stringify(order);
    if (!Array.isArray(order) || !order.every((a) => typeof a === "string")) {
        throw new Error(`manifest order ${shown} is not a list of arm labels`);
    }
    requireOrder(order, seedOrder, pairs);
    const runArms = order.filter((a) => a === armBase(a));
    const kept = seedOrder.filter((a) => runArms.includes(a));
    if (runArms.length === 0 || JSON.stringify(kept) !== JSON.stringify(runArms)) {
        throw new Error(
            `manifest order ${shown} does not keep the seed order ${JSON.stringify(seedOrder)}`,
        );
    }
}
const modelRef = (model: string) => `amazon-bedrock/${model}`;

export function piModels(ctx: Pick<HostContext, "model" | "sideModel">): string[] {
    return [...new Set([ctx.model, ...(ctx.sideModel ? [ctx.sideModel] : [])])];
}

/**
 * The user-tier `eidnara.jsonc` an Eidnara arm writes. `compaction.enabled` is the arm's
 * `eidnara_compaction`; with it false the plugin keeps its knowledge layer (memory, injection,
 * notes, search) and leaves the context window to the host.
 */
export function eidnaraUserConfig(
    connectionFile: string,
    model: string,
    arm: ArmName,
): Record<string, unknown> {
    return {
        enabled: true,
        host: { connection_file: connectionFile },
        compaction: { enabled: ARM_PROFILES[arm].eidnara_compaction },
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

/** The daemon configuration the hermetic host stack hands `direct_host_fixture`. */
export const fixtureDaemonConfig = (model: string): Record<string, unknown> => ({
    history_summarizer: { module_model: modelRef(model) },
});

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

    pid(stack: Untyped = this.stack): number | null {
        return stack?.child?.pid ?? null;
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
        // Each start regenerates the runtime, which lives beside the arm; the arm root and the
        // arm directory both have to be real directories before anything is removed.
        realBase(this.ctx.root);
        const armDir = realBase(dirname(this.ctx.root));
        rmSync(this.runtimeDir, { recursive: true, force: true });
        const runtimeDir = realDir(armDir, "runtime");
        // The store sits beside the arm root, so its walk starts at the arm directory both share.
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
            daemonConfig: fixtureDaemonConfig(this.ctx.model),
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

    /** Set between `crash` and the `restart` that starts the replacement. */
    private crashed = false;

    /**
     * Kills the daemon by SIGKILL; the store stays as the kill left it until `restart` starts
     * the replacement. The dead generation's last bytes stream to the log while it dies.
     */
    async crash(): Promise<void> {
        await this.stack.crashHost();
        this.crashed = true;
    }

    /** Starts the replacement daemon, killing the current one first unless `crash` already did. */
    async restart(): Promise<void> {
        if (!this.crashed) await this.stack.crashHost();
        this.crashed = false;
        // A start that fails still captured the new generation's output; it reaches the log too.
        try {
            await this.stack.startHost();
        } finally {
            this.attach();
        }
    }

    async stop(): Promise<void> {
        const stack = this.stack;
        if (!stack) return;
        const failures: unknown[] = [];
        let stopConfirmed = true;
        try {
            await stack.terminateHost();
        } catch (caught) {
            // terminateHost gives up after SIGTERM; the stack's SIGKILL path ends the daemon.
            failures.push(caught);
            await stack.crashHost().catch((killFailure: unknown) => {
                failures.push(killFailure);
                stopConfirmed = false;
            });
        }
        // A daemon whose forced stop is unconfirmed stays tracked, so a later stop can retry.
        if (failures.length === 0 || stopConfirmed) this.stack = null;
        if (this.logError !== undefined) failures.push(this.logError);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new Error(`daemon stop failed: ${failures.map(String).join("; ")}`);
        }
    }
}

/** How long a close whose launch is confirmed gone waits for the runtime to report the exit. */
export const PI_EXIT_EVENT_MS = 1_000;

function exitEvent(child: ChildProcess, ms: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            child.off("exit", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        child.once("exit", done);
    });
}

/** Runs each step in order, whatever the earlier ones did, and returns their failures. */
async function settleAll(steps: Array<() => Promise<unknown>>): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const step of steps) {
        try {
            await step();
        } catch (caught) {
            failures.push(caught);
        }
    }
    return failures;
}

function turnResult(outcome: Untyped): PromptResult {
    const messages = (outcome.messages ?? []) as Array<Record<string, Untyped>>;
    const last = messages.filter((m) => m.role === "assistant").at(-1);
    return last?.stopReason === "error" ? { error: String(last.errorMessage ?? "error") } : {};
}

/** The canonical node preflight probes; `root` is the install tree the sandbox keeps read-only. */
export { nodeInstall };

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
        // A staged file left by an interrupted write is removed, never followed, before the fresh one.
        rmSync(staged, { force: true });
        writeFileSync(staged, content, { flag: "wx" });
        renameSync(staged, path);
    }

    // A launch whose start time was never read cannot be told from a reused pid, so it is
    // left alone; its launcher had already exited, which ends the sandbox's namespace.
    // Returns whether the stop was confirmed through the launch's identity.
    protected async stopTree(
        pid: number | null | undefined,
        start: string | null,
    ): Promise<boolean> {
        if (pid == null || start === null) return false;
        if (!(await stopOwnedTree(pid, 10_000, start)))
            throw new Error(`host tree ${pid} survived SIGKILL`);
        return true;
    }

    abstract openSession(cwd: string, session: string, connection: string | null): Promise<void>;
    abstract prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult>;
    private closing: Promise<void> | null = null;

    /** Closes the session; concurrent callers share one in-progress close. */
    closeSession(): Promise<void> {
        this.closing ??= this.shutdownSession().finally(() => {
            this.closing = null;
        });
        return this.closing;
    }

    protected abstract shutdownSession(): Promise<void>;
    abstract transcriptEnv(): Record<string, string>;
    abstract hostPid(): number | null;

    private tools: ToolRun[] = [];

    protected logTool(
        tool: string,
        args: Record<string, unknown> | undefined,
        exit: number | null,
        scenario_ms = this.ctx.now?.() ?? 0,
        call?: string,
    ) {
        const run: ToolRun = { command: toolCommand(tool, args), exit, scenario_ms };
        if (call) run.call = call;
        this.tools.push(run);
        this.ctx.onTool?.(run);
    }

    protected unfinished(): ToolRun[] {
        return [];
    }

    drainTools(): ToolRun[] {
        const open = this.unfinished();
        for (const run of open) this.ctx.onTool?.(run);
        return [...this.tools.splice(0), ...open];
    }

    /** The launch identity the state records: the pid and the start captured when it was launched. */
    hostIdentity(): { pid: number; start: string | null } | null {
        const pid = this.hostPid();
        return pid === null ? null : { pid, start: (this.ctx.procStart ?? processStart)(pid) };
    }
}

export class PiSimHost extends SimHost {
    private rpc: Untyped = null;
    private launchStart: string | null = null;
    readonly agentDir = join(this.ctx.root, "home/.pi/agent");
    private readonly started = new Map<
        string,
        { tool: string; args: Record<string, unknown>; scenario_ms: number }
    >();

    protected override unfinished(): ToolRun[] {
        const open = [...this.started.entries()];
        this.started.clear();
        return open.map(([call, t]) => ({
            command: toolCommand(t.tool, t.args),
            exit: null,
            scenario_ms: t.scenario_ms,
            call,
        }));
    }

    /**
     * A tool run is timed from its start event, the moment the action began, and reported to
     * the recorder at that moment with a null exit, so a kill before the end event leaves the
     * run on record; the end event reports it again with its exit.
     */
    private toolEvent(e: Untyped): void {
        if (e.type === "tool_execution_start") {
            const scenario_ms = this.ctx.now?.() ?? 0;
            this.started.set(e.toolCallId, { tool: e.toolName, args: e.args, scenario_ms });
            const command = toolCommand(e.toolName, e.args);
            this.ctx.onTool?.({ command, exit: null, scenario_ms, call: e.toolCallId });
        }
        if (e.type !== "tool_execution_end") return;
        const run = this.started.get(e.toolCallId);
        this.started.delete(e.toolCallId);
        if (!run) return;
        const exit = e.isError === true ? 1 : 0;
        this.logTool(run.tool, run.args, exit, run.scenario_ms, e.toolCallId);
    }

    private writeConfigs(connectionFile: string | null): void {
        const agentDir = this.controlDir("home/.pi/agent");
        const settings = {
            packages: [],
            defaultProvider: "amazon-bedrock",
            defaultModel: this.ctx.model,
            enabledModels: piModels(this.ctx).map(modelRef),
            compaction: { enabled: ARM_PROFILES[this.ctx.arm].host_compaction },
            retry: { enabled: true },
            defaultThinkingLevel: "off",
            quietStartup: true,
            enableInstallTelemetry: false,
        };
        this.writeControlFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
        const models = piModels(this.ctx).map((id) => ({
            id,
            name: id,
            api: "bedrock-converse-stream",
            reasoning: false,
            input: ["text"],
            contextWindow: this.ctx.contextLimit,
            maxTokens: 8192,
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        }));
        const providers = { "amazon-bedrock": { baseUrl: this.ctx.proxyHttp2, models } };
        this.writeControlFile(
            join(agentDir, "models.json"),
            JSON.stringify({ providers }, null, 2),
        );
        if (connectionFile) {
            const dir = this.controlDir("home/config/eidnara");
            const config = eidnaraUserConfig(
                connectionFile,
                this.ctx.sideModel ?? this.ctx.model,
                this.ctx.arm,
            );
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
        const read = this.ctx.procStart ?? processStart;
        this.launchStart = child.pid === undefined ? null : read(child.pid);
        const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
        spawnError.catch(() => undefined);
        this.rpc = new rpcClient.PiRpcProcess(child, new rpcClient.PiRpcProtocol(), {
            stderrLimit: 20_000,
        });
        this.started.clear();
        this.rpc.onEvent((e: Untyped) => this.toolEvent(e));
        const gate = child.stdio[3] as import("node:stream").Writable | null;
        try {
            // The record names the launch by pid and start; a start the kernel did not report
            // leaves nothing the next reap could match, so the gated shell ends unreleased.
            if (this.launchStart === null) {
                throw new Error(`Pi launch ${child.pid} has no start identity`);
            }
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

    override hostIdentity(): { pid: number; start: string | null } | null {
        const pid = this.hostPid();
        return pid === null ? null : { pid, start: this.launchStart };
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

    async prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        if (!this.rpc)
            return { error: "Pi process is gone; the prompt was never sent", undelivered: true };
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
        let ended = false;
        end.then(
            () => {
                ended = true;
            },
            () => undefined,
        );
        let settling = false;
        let accepted = false;
        try {
            const response = await this.rpc.sendCommand("prompt", { message: text }, { timeoutMs });
            if (response.success === false) {
                waiting.abort();
                return { error: JSON.stringify(response).slice(0, 2000), undelivered: true };
            }
            accepted = true;
            const first =
                interruptMs === undefined ? await end : await withDeadline(end, interruptMs);
            if (first === null) {
                // The user's abort ends the turn through Pi's abort path. The turn's own waiter
                // reads the ending, whether the abort landed, failed, or stalls, within the drain
                // wait; an abort that reached Pi after the agent had finished leaves a stop
                // reason other than `aborted`, and the turn reports as it ended.
                this.rpc
                    .sendCommand("abort", {}, { timeoutMs: this.drainMs })
                    .catch(() => undefined);
                const ending = await withDeadline(end, this.drainMs).catch(() => null);
                if (ending === null) {
                    waiting.abort();
                    throw new Error(
                        `Pi turn still running ${this.drainMs} ms after the user's abort`,
                    );
                }
                const messages = (ending.messages ?? []) as Array<Record<string, Untyped>>;
                const last = messages.filter((m) => m.role === "assistant").at(-1);
                if (last?.stopReason === "aborted") return { interrupted: true };
                settling = true;
                return turnResult((await this.settle(watch, deadline)) ?? ending);
            }
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
            // The drain waiter is armed before one event-loop tick passes, so no agent_end falls
            // between listeners. An end the turn's own waiter saw (a same-tick end included)
            // settles the drain at once unless a settle was tried, since a failed settle leaves
            // Pi possibly still running.
            const fresh = this.agentEnd(this.drainMs);
            await Bun.sleep(0);
            const drained = ended && !settling ? Promise.resolve() : fresh;
            // The abort runs alongside the drain, so an abort that never answers cannot delay it.
            this.rpc.sendCommand("abort", {}, { timeoutMs: this.drainMs }).catch(() => undefined);
            // A turn that outlives the abort would end during the next turn and be taken for it.
            await drained.catch((reason: unknown) => {
                throw new Error(
                    `Pi turn still running ${this.drainMs} ms after abort (${String(reason)})`,
                );
            });
            // A prompt the command never accepted was never received.
            const receipt = accepted ? {} : { undelivered: true as const };
            return { error: String(caught).slice(0, 2000), ...receipt };
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
            // The quiet window always runs in full; a late continuation must have room to appear.
            await Bun.sleep(this.settleMs);
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

    // The handle is cleared only after the whole teardown succeeds, so a failed close can be retried.
    // A stop that stopTree confirms is the proof of exit; the launcher's exit event can trail it.
    protected async shutdownSession(): Promise<void> {
        const rpc = this.rpc;
        if (!rpc) return;
        rpc.child.stdin?.end();
        let confirmed = false;
        const failures = await settleAll([
            async () => {
                confirmed = await this.stopTree(rpc.child.pid, this.launchStart);
            },
            () => (confirmed ? exitEvent(rpc.child, PI_EXIT_EVENT_MS) : rpc.shutdown(10_000)),
        ]);
        if (failures.length > 0) throw failures[0];
        this.rpc = null;
    }

    transcriptEnv(): Record<string, string> {
        return { PI_CODING_AGENT_DIR: this.agentDir };
    }
}

const NON_INTERACTIVE = ["question", "plan_enter", "plan_exit"].map((permission) => ({
    permission,
    action: "deny",
    pattern: "*",
}));

/** A tool part's exit by its OpenCode status; a pending or running part has none. */
const EXIT: Record<string, number> = { completed: 0, error: 1 };

/** An OpenCode tool part's stable id, which keys its run across the turn's listing and a resume. */
const callId = (part: Untyped): string | undefined => {
    const id = part.callID ?? part.id;
    return typeof id === "string" ? `oc:${id}` : undefined;
};

export class OpencodeSimHost extends SimHost {
    private oc: Untyped = null;
    private client: Untyped = null;
    private sid: string | null = null;
    private readonly home = join(this.ctx.root, "home");
    protected abortWaitMs = 30_000;
    protected setupMs = 120_000;
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
        if (ARM_PROFILES[this.ctx.arm].host_compaction) {
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
                  eidnaraConfig: eidnaraUserConfig(
                      connection,
                      this.ctx.sideModel ?? this.ctx.model,
                      this.ctx.arm,
                  ),
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
            const found = await withDeadline(this.findOrCreateSession(cwd, session), this.setupMs);
            if (found === null)
                throw new Error(`OpenCode session setup still pending after ${this.setupMs} ms`);
            this.sid = found.id;
            if (found.existing) await this.recoverTools(this.setupMs);
        } catch (caught) {
            await this.closeSession();
            throw caught;
        }
    }

    /** The session titled for `session`, reattached when the killed harness left it, else created. */
    private async findOrCreateSession(
        cwd: string,
        session: string,
    ): Promise<{ id: string; existing: boolean }> {
        const listed = await this.client.session.list({ query: { directory: cwd } });
        if (listed.error) throw new Error(`session.list failed: ${JSON.stringify(listed.error)}`);
        const latest = ((listed.data ?? []) as Array<Record<string, Untyped>>)
            .filter((s) => s.title === `sim-${session}`)
            .at(0);
        if (latest) return { id: String(latest.id), existing: true };
        const created = await this.client.session.create({
            query: { directory: cwd },
            body: { title: `sim-${session}`, permission: NON_INTERACTIVE },
        });
        if (!created.data)
            throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);
        return { id: created.data.id, existing: false };
    }

    /**
     * The wrapper records its own pid and start time beside the arm before it execs the launcher,
     * so a harness killed during the server's startup leaves a record the next resume can reap.
     * It then execs only while the harness that spawned it is still that process, so a wrapper the
     * kernel scheduled after the harness died ends before the launcher instead of running a server
     * no record reached recovery in time to name.
     */
    private writeWrapper(
        argv: string[],
        harness: { pid: number; start: string | null } = {
            pid: process.pid,
            start: processStart(process.pid),
        },
    ): string {
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
            `s=$(awk '{print $22}' /proc/$$/stat) && [ -n "$s" ] || exit 70`,
            `printf '%s %s\\n' "$$" "$s" > "$r.$$" || exit 70`,
            `mv -f "$r.$$" "$r" || exit 70`,
            `[ "${harness.pid} $(awk '{print $22}' /proc/${harness.pid}/stat 2>/dev/null)" = ${shellQuote(`${harness.pid} ${harness.start ?? ""}`)} ] || exit 70`,
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

    /** Lists the session's messages within `deadlineMs`; a listing that stalls past it throws. */
    private async messages(
        deadlineMs: number,
    ): Promise<Array<{ info: Untyped; parts: Untyped[] }>> {
        const controller = new AbortController();
        const call = this.client.session.messages({
            path: { id: this.sid },
            signal: controller.signal,
        });
        call.catch(() => undefined);
        const listed: Untyped = await withDeadline(call as Promise<Untyped>, deadlineMs);
        if (listed === null) {
            controller.abort();
            throw new Error(`session.messages timed out after ${deadlineMs} ms`);
        }
        if (listed.error || !listed.data) {
            throw new Error(`session.messages failed: ${JSON.stringify(listed.error ?? null)}`);
        }
        return listed.data as Array<{ info: Untyped; parts: Untyped[] }>;
    }

    /** Logs the tools of the turn's own messages, listed within `deadlineMs`, and returns those messages. */
    private async logTurnTools(
        seen: Set<string>,
        startScenario: number,
        deadlineMs: number,
    ): Promise<Array<{ info: Untyped; parts: Untyped[] }>> {
        const listed = await this.messages(deadlineMs);
        const fresh = listed.filter((m) => !seen.has(String(m.info?.id)));
        const origin = Math.min(...fresh.map((m) => Number(m.info?.time?.created ?? Infinity)));
        for (const m of fresh) {
            for (const part of m.parts.filter((p) => p.type === "tool")) {
                const at = Number(part.state?.time?.start ?? origin);
                const ms = startScenario + (Number.isFinite(origin) ? Math.max(0, at - origin) : 0);
                const exit = EXIT[part.state?.status] ?? null;
                this.logTool(part.tool, part.state?.input, exit, ms, callId(part));
            }
        }
        return fresh;
    }

    /**
     * On reattaching to a session the killed harness left open, reports every tool part the
     * session's messages hold, keyed by the part's id, so a run the interrupted turn executed
     * reaches the recorder; a run it already holds keeps its recorded start time.
     */
    async recoverTools(deadlineMs: number): Promise<void> {
        this.recoverParts(await this.messages(deadlineMs));
    }

    /**
     * The message ids the last turn saw before its post-turn listing failed; the next turn's
     * pre-turn listing reports the tool parts of every message beyond them.
     */
    private unlogged: Set<string> | null = null;

    private recoverParts(messages: Array<{ info: Untyped; parts: Untyped[] }>): void {
        const now = this.ctx.now?.() ?? 0;
        for (const m of messages) {
            for (const part of m.parts.filter((p) => p.type === "tool")) {
                const command = toolCommand(part.tool, part.state?.input);
                const exit = EXIT[part.state?.status] ?? null;
                this.ctx.onTool?.({
                    command,
                    exit,
                    scenario_ms: now,
                    call: callId(part),
                    recovered: true,
                });
            }
        }
    }

    /**
     * Runs one turn under `timeoutMs` and then logs the tool parts of the messages it added, on
     * every outcome: the next turn treats those messages as seen, so a turn that errored or hit
     * its deadline logs its tools here or never. The deadline is absolute and bounds the message
     * listings before and after the turn together with the turn itself: the turn gets what the
     * pre-turn listing left minus a reserve for the post-turn listing (a quarter of the deadline,
     * at most one second); a listing that stalls before the turn fails the turn, and one that
     * stalls after it fails the turn as a capture gap, since its tool runs are then unknown. A
     * failed turn whose listing also fails keeps its own error and names the gap. A scheduled
     * `interruptMs` aborts the turn through OpenCode's abort path once it elapses, and the turn
     * reports `interrupted`. A turn that returns while its last assistant step has not finished
     * fails, so the next turn never sends a conversation that ends on that step.
     */
    async prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        const deadline = Date.now() + timeoutMs;
        const remaining = () => Math.max(0, deadline - Date.now());
        /** Kept back from the turn so the post-turn tool listing fits inside the same deadline. */
        const reserve = Math.min(1_000, Math.floor(timeoutMs / 4));
        if (timeoutMs <= 0) {
            return {
                error: `turn deadline ${timeoutMs} ms spent before the prompt`,
                undelivered: true,
            };
        }
        let seen: Set<string>;
        try {
            const listed = await this.messages(timeoutMs);
            if (this.unlogged)
                this.recoverParts(listed.filter((m) => !this.unlogged?.has(String(m.info?.id))));
            this.unlogged = null;
            seen = new Set(listed.map((m) => String(m.info?.id)));
        } catch (caught) {
            return { error: `tool capture: ${String(caught)}`.slice(0, 2000), undelivered: true };
        }
        const startScenario = this.ctx.now?.() ?? 0;
        if (remaining() <= reserve) {
            return {
                error: `turn deadline of ${timeoutMs} ms passed during the message listing`,
                undelivered: true,
            };
        }
        const outcome = await this.turn(text, remaining() - reserve, interruptMs, timeoutMs);
        let listed: Array<{ info: Untyped; parts: Untyped[] }>;
        try {
            if (remaining() === 0) throw new Error("turn deadline passed before the tool listing");
            listed = await this.logTurnTools(seen, startScenario, remaining());
        } catch (caught) {
            this.unlogged = seen;
            const gap = `tool capture: ${String(caught)}`;
            return {
                ...outcome,
                error: (outcome.error ? `${outcome.error} | ${gap}` : gap).slice(0, 2000),
            };
        }
        if (outcome.error || outcome.interrupted) return outcome;
        const last = listed.filter((m) => m.info?.role === "assistant").at(-1);
        if (last?.info?.error) return { error: JSON.stringify(last.info.error).slice(0, 2000) };
        if (!last) return { error: "the turn returned without an assistant message of its own" };
        const finish = last.info?.finish;
        if (finish === "stop" || finish === "length") return outcome;
        // The step is still running; aborting it keeps it out of the next turn's transcript. An
        // abort still unanswered after `abortWaitMs` stops the run, since it would cancel the
        // next turn instead.
        const aborted = await withDeadline(
            this.client.session.abort({ path: { id: this.sid } }).then(
                () => true,
                () => true,
            ),
            this.abortWaitMs,
        );
        if (aborted === null) {
            throw new Error(
                `OpenCode abort still pending ${this.abortWaitMs} ms after an unfinished step`,
            );
        }
        return { error: `the turn returned before its last assistant step finished (${finish})` };
    }

    /**
     * Sends the prompt and waits for it under `timeoutMs`. A scheduled interrupt asks OpenCode to
     * abort: an abort answered true is the interrupt; an abort answered false or with an error
     * leaves the turn to run on under its deadline and report as it ends; an abort still
     * unanswered after `abortWaitMs` stops the run, since an abort in flight when the next turn
     * starts would cancel that turn instead. `wholeMs` is the turn's whole deadline, named in a
     * deadline error.
     */
    private async turn(
        text: string,
        timeoutMs: number,
        interruptMs?: number,
        wholeMs = timeoutMs,
    ): Promise<PromptResult> {
        const model = { providerID: "amazon-bedrock", modelID: this.ctx.model };
        const call = this.client.session.prompt({
            path: { id: this.sid },
            body: { model, parts: [{ type: "text", text }] },
        });
        const settled: Promise<{ result: Untyped } | { caught: unknown }> = call.then(
            (result: Untyped) => ({ result }),
            (caught: unknown) => ({ caught }),
        );
        const turnEnd = Date.now() + timeoutMs;
        const wait = Math.min(timeoutMs, interruptMs ?? timeoutMs);
        const abort = async (): Promise<boolean> => {
            const answered = await withDeadline<boolean>(
                this.client.session.abort({ path: { id: this.sid } }).then(
                    (r: Untyped) => r?.data === true && !r?.error,
                    () => false,
                ),
                this.abortWaitMs,
            );
            if (answered === null) {
                throw new Error(
                    `OpenCode abort still pending ${this.abortWaitMs} ms after the deadline`,
                );
            }
            return answered;
        };
        let first = await withDeadline(settled, wait);
        if (first === null && wait < timeoutMs) {
            if (await abort()) {
                const drained = await withDeadline(settled, 30_000);
                if (drained === null)
                    throw new Error("OpenCode turn still running 30 s after abort");
                return { interrupted: true };
            }
            first = await withDeadline(settled, Math.max(0, turnEnd - Date.now()));
        }
        if (first === null) {
            if (!(await abort())) throw new Error("OpenCode turn not aborted after its deadline");
            const drained = await withDeadline(settled, 30_000);
            if (drained === null) throw new Error("OpenCode turn still running 30 s after abort");
            return { error: `turn deadline ${wholeMs} ms` };
        }
        if ("caught" in first) {
            // The request failed with the server's answer unknown, so the turn is aborted before the next one.
            const tail = String(this.oc?.stderr?.() ?? "").slice(-600);
            const cause = String(first.caught);
            const error = (tail ? `${cause} | serve stderr: ${tail}` : cause).slice(0, 2000);
            if (!(await abort())) {
                throw new Error(`OpenCode turn not aborted after a rejected prompt (${error})`);
            }
            // A rejected prompt call never got an acknowledgement, so the text's receipt is
            // unknown and the turn counts as undelivered.
            return { error, undelivered: true };
        }
        const { result } = first;
        if (result.error) return { error: JSON.stringify(result.error).slice(0, 2000) };
        const info = result.data?.info;
        return info?.error ? { error: JSON.stringify(info.error).slice(0, 2000) } : {};
    }

    // The handles are cleared only after the whole teardown succeeds, so a failed close can be retried.
    // The launcher's exit, confirmed through its launch identity, settles the close; the kill
    // step's own report counts only while that confirmation is missing.
    protected async shutdownSession(): Promise<void> {
        const oc = this.oc;
        if (!oc) return;
        const launched = this.launched ?? { pid: this.hostPid(), start: null };
        let confirmed = false;
        const failures = await settleAll([
            async () => {
                confirmed = await this.stopTree(launched.pid, launched.start);
            },
            () =>
                oc.kill().catch((caught: unknown) => {
                    if (!confirmed) throw caught;
                }),
        ]);
        if (failures.length > 0) throw failures[0];
        this.oc = null;
        this.client = null;
        this.launched = null;
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
