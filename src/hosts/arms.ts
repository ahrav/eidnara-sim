import { type ChildProcess, spawn } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    linkSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import { launch, plainPath, shellQuote } from "../run/launcher";
import { processStart, running, stopOwnedTree } from "../run/procs";
import { FAKETIME_LIB, faketimeEnv } from "../run/timeinject";
import { toolbinDir, toolchainEnv } from "../run/toolchain";

// biome-ignore lint/suspicious/noExplicitAny: v1 harness modules are imported by runtime path.
type Untyped = any;
async function v1(config: SimConfig, path: string): Promise<Untyped> {
    return import(join(config.eidnara_checkout, path));
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
    now?: () => number;
    /**
     * The host invokes `onTool` as it records a run; `drainTools` invokes it for the runs it
     * adds itself. A run with a `call` id may be reported at its start with a null exit and
     * again at its end, and the later report replaces the earlier one.
     */
    onTool?: (run: ToolRun) => void;
}

export interface ToolRun {
    command: string;
    exit: number | null;
    scenario_ms: number;
    /** The host's id for the run, when it reports a start before the end; a later report with the same id replaces the earlier one. */
    call?: string;
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
    /** The user aborted the turn through the host's abort path. */
    interrupted?: boolean;
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

interface LogMarker {
    pending: string[];
    copying: { source: string; target_bytes: number } | null;
    /** A killed lifetime's stdout, held until its log is saved, so a resume saves it too. */
    stdout?: string;
    /** The log's length before the held stdout was appended; set while that append is in flight. */
    stdout_target?: number;
    /** The daemon process writing the live log, when one is up; recovery stops it before reading. */
    owner?: { pid: number; start: string | null } | null;
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

/** Appends `source` to `target` a megabyte at a time, so a long daemon log stays off the heap. */
function appendFileFrom(source: string, target: string): void {
    const fd = openSync(source, "r");
    try {
        const chunk = Buffer.alloc(1 << 20);
        for (;;) {
            const read = readSync(fd, chunk, 0, chunk.length, null);
            if (read === 0) break;
            appendFileSync(target, chunk.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
}

export class DaemonStack {
    private stack: Untyped = null;
    /** The v1 hermetic-host module the stack came from. */
    private hh: Untyped = null;
    connectionFile = "";

    constructor(private readonly ctx: DaemonContext) {}

    pid(stack: Untyped = this.stack): number | null {
        return stack?.child?.pid ?? null;
    }

    /** Names the marker a `start` after a harness kill reads to find the logs still to save. */
    private get logSourceFile(): string {
        return `${this.ctx.logFile}.source`;
    }

    /**
     * The marker lists the stderr logs not yet saved to `daemon.log`, in order, and the copy
     * in progress with `daemon.log`'s length before it. It is replaced through a rename.
     */
    private writeMarker(marker: LogMarker): void {
        const tmp = `${this.logSourceFile}.tmp`;
        writeFileSync(tmp, JSON.stringify(marker));
        renameSync(tmp, this.logSourceFile);
    }

    private readMarker(): LogMarker | null {
        if (!existsSync(this.logSourceFile)) return null;
        const text = readFileSync(this.logSourceFile, "utf8");
        try {
            const parsed = JSON.parse(text) as Partial<LogMarker>;
            return {
                pending: parsed.pending ?? [],
                copying: parsed.copying ?? null,
                owner: parsed.owner ?? null,
                ...(typeof parsed.stdout === "string" ? { stdout: parsed.stdout } : {}),
                ...(typeof parsed.stdout_target === "number"
                    ? { stdout_target: parsed.stdout_target }
                    : {}),
            };
        } catch {
            throw new Error(`${this.logSourceFile}: unreadable daemon log recovery marker`);
        }
    }

    /** The live daemon's identity, so a recovery after a kill can tell it from a reused pid. */
    private owner(): LogMarker["owner"] {
        const pid = this.pid();
        return pid === null ? null : { pid, start: processStart(pid) };
    }

    /** Records the live stack's stderr log as the one log still to save, and the daemon writing it. */
    noteLogSource(): void {
        const live = String(this.stack?.logPath ?? "");
        this.writeMarker({ pending: [live], copying: null, owner: this.owner() });
    }

    /**
     * Appends one log to `daemon.log` exactly once: the marker commits the copy before the
     * source is removed, so a kill between the two leaves an orphan file, never a lost or
     * doubled lifetime.
     */
    private absorb(source: string, rest: string[], owner: LogMarker["owner"] = null): void {
        const start = existsSync(this.ctx.logFile) ? statSync(this.ctx.logFile).size : 0;
        this.writeMarker({ pending: rest, copying: { source, target_bytes: start }, owner });
        appendFileFrom(source, this.ctx.logFile);
        this.writeMarker({ pending: rest, copying: null, owner });
        rmSync(source, { force: true });
    }

    /**
     * Saves every log the marker lists that still exists, in order. A copy an earlier kill
     * cut short is rolled back to the length the marker recorded before it runs again, so each
     * log is appended once. A clean `stop` or `restart` leaves no log behind, so this finds
     * one only after a kill.
     */
    async recoverLog(): Promise<void> {
        const marker = this.readMarker();
        if (!marker) return;
        const { owner } = marker;
        if (owner && running(owner.pid) && processStart(owner.pid) === owner.start) {
            if (!(await stopOwnedTree(owner.pid, 10_000))) {
                throw new Error(`daemon ${owner.pid} from the last lifetime survived SIGKILL`);
            }
        }
        this.drain(marker, []);
    }

    /**
     * Saves every log the marker lists that still exists, in order, then the `extra` ones: a
     * copy an earlier kill cut short is rolled back to the length the marker recorded before
     * it runs again, and two names of one inode (the held link before a restart replaced the
     * live path) are saved once, so each lifetime is appended once. The marker is removed at
     * the end.
     */
    /**
     * Appends a marker's held stdout once. The marker records the log's length before the append,
     * so an append a kill cut short is rolled back to that length and runs again; the returned
     * marker, written to disk, has dropped the stdout.
     */
    private saveHeldStdout(marker: LogMarker): LogMarker {
        const { stdout, stdout_target, ...rest } = marker;
        if (stdout === undefined) return marker;
        const start =
            stdout_target ?? (existsSync(this.ctx.logFile) ? statSync(this.ctx.logFile).size : 0);
        if (stdout_target !== undefined && existsSync(this.ctx.logFile)) {
            truncateSync(this.ctx.logFile, stdout_target);
        } else {
            this.writeMarker({ ...rest, stdout, stdout_target: start });
        }
        appendFileSync(this.ctx.logFile, stdout);
        this.writeMarker(rest);
        return rest;
    }

    private drain(marker: LogMarker | null, extra: string[]): void {
        let pending = [...(marker?.pending ?? [])];
        // The held stdout goes first, as `restart` would have written it.
        if (marker?.stdout !== undefined) this.saveHeldStdout(marker);
        if (marker?.copying) {
            if (existsSync(this.ctx.logFile)) {
                truncateSync(this.ctx.logFile, marker.copying.target_bytes);
            }
            pending = [marker.copying.source, ...pending];
        }
        pending = [...new Set([...pending, ...extra])].filter((p) => p !== "");
        const seenInodes = new Set<string>();
        pending = pending.filter((p) => {
            if (!existsSync(p)) return true;
            const st = statSync(p);
            const key = `${st.dev}:${st.ino}`;
            if (seenInodes.has(key)) {
                rmSync(p, { force: true });
                return false;
            }
            seenInodes.add(key);
            return true;
        });
        while (pending.length > 0) {
            const [source, ...rest] = pending as [string, ...string[]];
            if (existsSync(source)) this.absorb(source, rest);
            else this.writeMarker({ pending: rest, copying: null });
            pending = rest;
        }
        rmSync(this.logSourceFile, { force: true });
    }

    async start(): Promise<void> {
        await this.recoverLog();
        const { config } = this.ctx;
        const hr = await v1(config, "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts");
        const hh = await v1(config, "packages/e2e-tests/src/rust-runner/hermetic-host.ts");
        this.hh = hh;
        const sources = hr.detectHarnessRuntimeSources();
        if (!sources.ok) throw new Error(`harness runtime sources: ${sources.reason}`);
        const runtimeDir = join(this.ctx.root, "runtime");
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        mkdirSync(this.ctx.dataDir, { recursive: true, mode: 0o700 });
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
        this.noteLogSource();
    }

    /**
     * Appends the daemon's stdout and stderr since the last host start, each line once. The
     * v1 stack keeps the last 256 KiB of each stream in memory and writes every stderr chunk
     * to a log file it truncates at each host start, so stderr is read whole from that file
     * (`logPath`, a private field the stack's own `diagnostics` view reads the same way) and
     * stdout from the `diagnostics` view.
     */
    private get held(): string {
        return `${this.ctx.logFile}.held`;
    }

    /** The dying lifetime's stdout, held with its log until the replacement is up. */
    private heldStdout: string | null = null;

    /**
     * Holds the live lifetime's output for `restart` to save once the old daemon is dead. `held`
     * is a hard link to the live log: the stack replaces the log path when the new daemon
     * starts, and the link keeps the old inode readable until the old daemon's last write has
     * landed. The marker names the held log and the live one, so a kill at any point leaves
     * both findable; it names the live one alone once the held copy is saved.
     */
    private hold(): void {
        const { stdout } = this.hh.__hermeticHostTest.diagnostics(this.stack);
        const live = String(this.stack.logPath ?? "");
        rmSync(this.held, { force: true });
        if (existsSync(live)) linkSync(live, this.held);
        this.heldStdout = stdout;
        this.writeMarker({
            pending: [this.held, live],
            copying: null,
            owner: this.owner(),
            stdout,
        });
    }

    /**
     * Kills the daemon by SIGKILL; the store stays as the kill left it until `restart`, which
     * saves the dead lifetime's held log.
     */
    async crash(): Promise<void> {
        this.hold();
        await this.stack.crashHost();
    }

    /** Starts the replacement daemon, killing the current one first unless `crash` already did. */
    async restart(): Promise<void> {
        if (this.heldStdout === null) this.hold();
        const live = String(this.stack.logPath ?? "");
        await this.stack.restartHost();
        // The replacement owns the marker from here, so a kill before the logs are saved still
        // lets a resume stop it before starting another daemon against the same store; the held
        // stdout then lands through the marker, so a kill mid-append rolls it back.
        const owner = this.owner();
        const marker = this.readMarker();
        if (marker) {
            const owned = { ...marker, owner };
            this.writeMarker(owned);
            this.saveHeldStdout(owned);
        }
        this.heldStdout = null;
        this.absorb(this.held, [live], owner);
        this.writeMarker({ pending: [live], copying: null, owner });
    }

    /**
     * Stops the daemon, then saves every log the marker still lists, the live one included,
     * and last its stdout (read after termination, so a line written while handling SIGTERM
     * is in it, and appended after any rollback so the rollback cannot erase it); nothing is
     * left to recover.
     */
    async stop(): Promise<void> {
        const stack = this.stack;
        if (!stack) return;
        await stack.terminateHost();
        this.stack = null;
        const { stdout } = this.hh.__hermeticHostTest.diagnostics(stack);
        // A held stdout belongs to the lifetime the marker names as owner. When that is still the
        // stack's lifetime (a kill that failed), the stack's stdout covers it and the marker drops
        // its own; when a replacement came up and then failed, the held copy is the old lifetime's
        // only stdout and lands ahead of the replacement's output. The stack's stdout goes last,
        // after any rollback the drains perform, so a rollback cannot erase it.
        const live = String(stack.logPath ?? "");
        const marker = this.readMarker();
        const stackPid = this.pid(stack);
        const sameLifetime =
            marker?.owner?.pid != null &&
            marker.owner.pid === stackPid &&
            marker.owner.start === processStart(stackPid as number);
        const {
            stdout: _held,
            stdout_target: _target,
            ...rest
        } = marker ?? { pending: [], copying: null };
        this.heldStdout = null;
        if (marker?.stdout !== undefined && !sameLifetime) {
            this.drain({ ...marker, pending: marker.pending.filter((p) => p !== live) }, []);
            this.drain(null, [live]);
            appendFileSync(this.ctx.logFile, stdout);
            return;
        }
        if (marker?.stdout !== undefined) this.writeMarker(rest);
        this.drain(marker ? rest : null, [live]);
        appendFileSync(this.ctx.logFile, stdout);
    }
}

function nodeRoot(): string {
    return resolve(realpathSync(Bun.which("node") ?? "node"), "../..");
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
        const { config, launcher } = this.ctx;
        const interposer = dirname(dirname(FAKETIME_LIB));
        return [
            ...config.toolchain.keep,
            toolbinDir(launcher),
            interposer,
            config.eidnara_checkout,
        ];
    }

    protected async stopTree(pid: number | null | undefined): Promise<void> {
        if (pid == null) return;
        if (!(await stopOwnedTree(pid, 10_000)))
            throw new Error(`host tree ${pid} survived SIGKILL`);
    }

    abstract openSession(cwd: string, session: string, connection: string | null): Promise<void>;
    abstract prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult>;
    abstract closeSession(): Promise<void>;
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
}

export class PiSimHost extends SimHost {
    private rpc: Untyped = null;
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
        mkdirSync(this.agentDir, { recursive: true });
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
        writeFileSync(join(this.agentDir, "settings.json"), JSON.stringify(settings, null, 2));
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
        writeFileSync(join(this.agentDir, "models.json"), JSON.stringify({ providers }, null, 2));
        if (connectionFile) {
            const dir = join(this.ctx.root, "home/config/eidnara");
            mkdirSync(dir, { recursive: true });
            const config = eidnaraUserConfig(connectionFile, this.ctx.model);
            writeFileSync(join(dir, "eidnara.jsonc"), JSON.stringify(config, null, 2));
        }
    }

    async openSession(cwd: string, session: string, connection: string | null): Promise<void> {
        const { config } = this.ctx;
        const rpcClient = await v1(config, "packages/e2e-tests/src/pi-runner/rpc-client.ts");
        this.writeConfigs(connection);
        const cli = join(
            config.pi_install,
            "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        );
        const args = [cli, "--mode", "rpc", "--session-id", `sim-${session}`];
        args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes");
        if (connection)
            args.push("--extension", join(config.eidnara_checkout, "packages/pi-plugin"));
        args.push("--model", modelRef(this.ctx.model));
        const home = join(this.ctx.root, "home");
        const tools = this.toolchain;
        const env = {
            PATH: `${join(nodeRoot(), "bin")}:${tools.path}:/usr/local/bin:/usr/bin:/bin`,
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
        const node = join(nodeRoot(), "bin/node");
        const ro = [...this.readOnly, nodeRoot(), config.pi_install];
        const argv = launch(this.ctx.launcher, this.ctx.keep, this.timeEnv, [node, ...args], ro);
        const child: ChildProcess = spawn(argv[0] as string, argv.slice(1), {
            cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
        spawnError.catch(() => undefined);
        this.rpc = new rpcClient.PiRpcProcess(child, new rpcClient.PiRpcProtocol(), {
            stderrLimit: 20_000,
        });
        this.started.clear();
        this.rpc.onEvent((e: Untyped) => this.toolEvent(e));
        const ready = this.rpc.sendCommand("get_state", {}, { timeoutMs: 120_000 });
        await Promise.race([ready, spawnError]);
    }

    hostPid(): number | null {
        return this.rpc?.child?.pid ?? null;
    }

    private agentEnd(timeoutMs: number): Promise<Untyped> {
        const end = this.rpc.waitForEvent((e: Untyped) => e.type === "agent_end", {
            timeoutMs,
            label: "agent_end",
        });
        end.catch(() => undefined);
        return end;
    }

    /** How long an aborted turn may take to report `agent_end` before the Pi process is killed. */
    private drainWaitMs = 30_000;

    /**
     * Runs one turn. A turn that fails or times out is aborted; an `agent_end` that already
     * arrived (checked after one event-loop tick, so a same-tick end counts) settles the drain,
     * otherwise a fresh waiter runs for the drain wait. A Pi that
     * reports no `agent_end` in that time is still running the old turn, so its process is
     * killed and the session's later prompts fail at once. A tool event from that turn can
     * then never land on a later turn's record.
     */
    async prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        if (!this.rpc) return { error: "Pi process killed after an undrained abort" };
        const end = this.agentEnd(timeoutMs);
        let ended = false;
        end.then(
            () => {
                ended = true;
            },
            () => undefined,
        );
        try {
            const response = await this.rpc.sendCommand("prompt", { message: text }, { timeoutMs });
            if (response.success === false) {
                throw new Error(JSON.stringify(response).slice(0, 2000));
            }
            const cut = interruptMs === undefined ? null : Bun.sleep(interruptMs).then(() => null);
            const first = await Promise.race(cut ? [end, cut] : [end]);
            // A failed abort is read off `end` like a landed one: the original waiter still
            // holds the agent's ending, or waits on for it under the turn deadline.
            if (first === null) {
                const abort = this.rpc.sendCommand("abort", {}, { timeoutMs: 60_000 });
                await Promise.race([abort.catch(() => undefined), end.catch(() => undefined)]);
            }
            // The interrupt is read off the agent's own last message: an abort that reached Pi
            // after the agent had finished leaves a stop reason other than `aborted`.
            const outcome = first ?? (await end);
            const messages = (outcome.messages ?? []) as Array<Record<string, Untyped>>;
            const last = messages.filter((m) => m.role === "assistant").at(-1);
            if (last?.stopReason === "aborted") return { interrupted: true };
            return last?.stopReason === "error"
                ? { error: String(last.errorMessage ?? "error") }
                : {};
        } catch (caught) {
            await Bun.sleep(0);
            const drained = ended ? Promise.resolve() : this.agentEnd(this.drainWaitMs);
            await this.rpc.sendCommand("abort", {}, { timeoutMs: 60_000 }).catch(() => undefined);
            const settled = await drained.then(
                () => true,
                () => false,
            );
            const error = String(caught).slice(0, 2000);
            if (settled) return { error };
            await this.closeSession();
            return {
                error: `${error} | Pi process killed after an undrained abort`.slice(0, 2000),
            };
        }
    }

    async closeSession(): Promise<void> {
        const rpc = this.rpc;
        this.rpc = null;
        if (!rpc) return;
        rpc.child.stdin?.end();
        try {
            await this.stopTree(rpc.child.pid);
        } finally {
            await rpc.shutdown(10_000);
        }
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

    async openSession(cwd: string, session: string, connection: string | null): Promise<void> {
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
        const sbin = join(this.ctx.root, "sbin");
        mkdirSync(sbin, { recursive: true });
        const binary = plainPath(config.opencode_binary);
        const ro = [...this.readOnly, dirname(dirname(dirname(binary)))];
        const launcher = plainPath(this.ctx.launcher);
        const argv = launch(launcher, this.ctx.keep, this.timeEnv, [binary], ro);
        const wrapper = `#!/bin/sh\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`;
        writeFileSync(join(sbin, "opencode"), wrapper, { mode: 0o755 });
        const env = {
            configDir: join(this.home, "config"),
            dataDir: join(this.home, "data"),
            cacheDir: join(this.home, "cache"),
            workdir: cwd,
        };
        for (const d of [env.configDir, env.dataDir, env.cacheDir])
            mkdirSync(d, { recursive: true });
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
                PATH: `${sbin}:${this.toolchain.path}:${process.env.PATH ?? ""}`,
            },
        });
        const sdkPath = "packages/e2e-tests/node_modules/@opencode-ai/sdk/dist/index.js";
        const sdk = await import(join(config.eidnara_checkout, sdkPath));
        this.client = sdk.createOpencodeClient({ baseUrl: this.oc.url });
        const listed = await this.client.session.list({ query: { directory: cwd } });
        const latest = ((listed.data ?? []) as Array<Record<string, Untyped>>)
            .filter((s) => s.title === `sim-${session}`)
            .at(0);
        if (latest) {
            this.sid = String(latest.id);
            await this.recoverTools(120_000);
            return;
        }
        const created = await this.client.session.create({
            query: { directory: cwd },
            body: { title: `sim-${session}`, permission: NON_INTERACTIVE },
        });
        if (!created.data)
            throw new Error(`session.create failed: ${JSON.stringify(created.error)}`);
        this.sid = created.data.id;
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
        const pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e) && serves(e));
        return pids.length > 0 ? Math.min(...pids.map(Number)) : null;
    }

    /** Lists the session's messages within `deadlineMs`; a listing that stalls past it throws. */
    private async messages(
        deadlineMs: number,
    ): Promise<Array<{ info: Untyped; parts: Untyped[] }>> {
        const call = this.client.session.messages({ path: { id: this.sid } });
        call.catch(() => undefined);
        const listed = await Promise.race([call, Bun.sleep(deadlineMs).then(() => null)]);
        if (listed === null) throw new Error(`session.messages timed out after ${deadlineMs} ms`);
        if (listed.error || !listed.data) {
            throw new Error(`session.messages failed: ${JSON.stringify(listed.error ?? null)}`);
        }
        return listed.data as Array<{ info: Untyped; parts: Untyped[] }>;
    }

    private async logTurnTools(
        seen: Set<string>,
        startScenario: number,
        deadlineMs: number,
    ): Promise<void> {
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
    }

    /**
     * On reattaching to a session the killed harness left open, reports every tool part the
     * session's messages hold, keyed by the part's id, so a run the interrupted turn executed
     * reaches the recorder; a run it already holds keeps its recorded start time.
     */
    async recoverTools(deadlineMs: number): Promise<void> {
        const now = this.ctx.now?.() ?? 0;
        for (const m of await this.messages(deadlineMs)) {
            for (const part of m.parts.filter((p) => p.type === "tool")) {
                const command = toolCommand(part.tool, part.state?.input);
                const exit = EXIT[part.state?.status] ?? null;
                this.ctx.onTool?.({ command, exit, scenario_ms: now, call: callId(part) });
            }
        }
    }

    /**
     * Runs one turn under `timeoutMs` and then logs the tool parts of the messages it added, on
     * every outcome: the next turn treats those messages as seen, so a turn that errored or hit
     * its deadline logs its tools here or never. The deadline also bounds the message listings
     * before and after the turn: a listing that stalls before the turn fails the turn, and one
     * that stalls after it fails the turn as a capture gap, since its tool runs are then
     * unknown. A failed turn whose listing also fails keeps its own error and names the gap.
     */
    async prompt(text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        const deadline = Date.now() + timeoutMs;
        const remaining = () => Math.max(1_000, deadline - Date.now());
        let seen: Set<string>;
        try {
            seen = new Set((await this.messages(timeoutMs)).map((m) => String(m.info?.id)));
        } catch (caught) {
            return { error: `tool capture: ${String(caught)}`.slice(0, 2000) };
        }
        const startScenario = this.ctx.now?.() ?? 0;
        // The listing spent part of the turn's deadline; the turn gets the rest.
        const outcome = await this.turn(text, remaining(), interruptMs, timeoutMs);
        try {
            await this.logTurnTools(seen, startScenario, remaining());
        } catch (caught) {
            const gap = `tool capture: ${String(caught)}`;
            return {
                ...outcome,
                error: (outcome.error ? `${outcome.error} | ${gap}` : gap).slice(0, 2000),
            };
        }
        return outcome;
    }

    /** How long an aborted turn may take to settle before the run is stopped. */
    private drainWaitMs = 30_000;

    private drained(): Promise<null> {
        return Bun.sleep(this.drainWaitMs).then(() => null);
    }

    /** How long an abort request may take to answer before the turn is left to run on. */
    private abortWaitMs = 5_000;

    /**
     * Asks OpenCode to abort the session's running prompt. `now` is true once it answered that
     * it did within the wait; `late` settles with the request's eventual answer, so an abort
     * that lands after the wait is still read as the interrupt.
     */
    private abortSession(): { now: Promise<boolean>; late: Promise<boolean>; cancel: () => void } {
        const controller = new AbortController();
        const late: Promise<boolean> = this.client.session
            .abort({ path: { id: this.sid }, signal: controller.signal })
            .then((r: Untyped) => r?.data === true && !r?.error)
            .catch(() => false);
        const now = Promise.race([late, Bun.sleep(this.abortWaitMs).then(() => false)]);
        return { now, late, cancel: () => controller.abort() };
    }

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
        const settled = call.then(
            (result: Untyped) => ({ result }),
            (caught: unknown) => ({ caught }),
        );
        const deadline = Date.now() + timeoutMs;
        const left = () => Math.max(0, deadline - Date.now());
        const wait = Math.min(timeoutMs, interruptMs ?? timeoutMs);
        let first = await Promise.race([settled, Bun.sleep(wait).then(() => null)]);
        if (first === null && wait < timeoutMs) {
            // `session.abort` answers true once it stopped a running prompt; a refusal, an error,
            // or a stall leaves the turn to run on under its own deadline, reported as it ends.
            const abort = this.abortSession();
            if (await abort.now) {
                const drained = await Promise.race([settled, this.drained()]);
                if (drained === null) throw new Error("OpenCode turn still running after abort");
                return { interrupted: true };
            }
            first = await Promise.race([settled, Bun.sleep(left()).then(() => null)]);
            // The request outlived its wait; an answer that arrived with the prompt's end
            // means the abort ended the turn. A request still open is cancelled here, so it
            // cannot reach the session's next prompt.
            const landed = await Promise.race([abort.late, Bun.sleep(0).then(() => false)]);
            abort.cancel();
            if (first !== null && landed) return { interrupted: true };
        }
        if (first === null) {
            const abort = this.abortSession();
            await abort.now;
            const drained = await Promise.race([settled, this.drained()]);
            abort.cancel();
            if (drained === null) throw new Error("OpenCode turn still running after abort");
            return { error: `turn deadline ${wholeMs} ms` };
        }
        if ("caught" in first) {
            const tail = String(this.oc?.stderr?.() ?? "").slice(-600);
            return { error: `${String(first.caught)} | serve stderr: ${tail}`.slice(0, 2000) };
        }
        const { result } = first;
        if (result.error) return { error: JSON.stringify(result.error).slice(0, 2000) };
        const info = result.data?.info;
        return info?.error ? { error: JSON.stringify(info.error).slice(0, 2000) } : {};
    }

    async closeSession(): Promise<void> {
        const oc = this.oc;
        const pid = this.hostPid();
        this.oc = null;
        this.client = null;
        if (!oc) return;
        try {
            await this.stopTree(pid);
        } finally {
            await oc.kill();
        }
    }

    transcriptEnv(): Record<string, string> {
        return { XDG_DATA_HOME: join(this.home, "data") };
    }
}

export function makeHost(ctx: HostContext): SimHost {
    return ctx.host === "pi" ? new PiSimHost(ctx) : new OpencodeSimHost(ctx);
}
