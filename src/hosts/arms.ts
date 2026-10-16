import { type ChildProcess, spawn } from "node:child_process";
import {
    appendFileSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import { withDeadline } from "../run/deadline";
import { launch, plainPath, shellQuote } from "../run/launcher";
import { stopOwnedTree } from "../run/procs";
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

    async start(): Promise<void> {
        const { config } = this.ctx;
        const hr = await v1(config, "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts");
        const hh = await v1(config, "packages/e2e-tests/src/rust-runner/hermetic-host.ts");
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
    }

    private saveLog(): void {
        if (this.stack) appendFileSync(this.ctx.logFile, this.stack.hostLog());
    }

    async restart(): Promise<void> {
        this.saveLog();
        await this.stack.restartHost();
    }

    async stop(): Promise<void> {
        const stack = this.stack;
        if (!stack) return;
        try {
            this.saveLog();
        } finally {
            await stack.terminateHost();
            this.stack = null;
        }
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
    abstract prompt(text: string, timeoutMs: number): Promise<PromptResult>;
    abstract closeSession(): Promise<void>;
    abstract transcriptEnv(): Record<string, string>;
    abstract hostPid(): number | null;
}

export class PiSimHost extends SimHost {
    private rpc: Untyped = null;
    readonly agentDir = join(this.ctx.root, "home/.pi/agent");

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
        const ready = this.rpc.sendCommand("get_state", {}, { timeoutMs: 120_000 });
        try {
            await Promise.race([ready, spawnError]);
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
        const waiting = new AbortController();
        const end = this.agentEnd(timeoutMs, waiting.signal);
        try {
            const response = await this.rpc.sendCommand("prompt", { message: text }, { timeoutMs });
            if (response.success === false) {
                waiting.abort();
                return { error: JSON.stringify(response).slice(0, 2000) };
            }
            const outcome = await end;
            const messages = (outcome.messages ?? []) as Array<Record<string, Untyped>>;
            const last = messages.filter((m) => m.role === "assistant").at(-1);
            return last?.stopReason === "error"
                ? { error: String(last.errorMessage ?? "error") }
                : {};
        } catch (caught) {
            const drained = this.agentEnd(30_000);
            await this.rpc.sendCommand("abort", {}, { timeoutMs: 60_000 }).catch(() => undefined);
            // A turn that outlives the abort would end during the next turn and be taken for it.
            await drained.catch((reason: unknown) => {
                throw new Error(`Pi turn still running 30 s after abort (${String(reason)})`);
            });
            return { error: String(caught).slice(0, 2000) };
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
        const binary = plainPath(config.opencode_binary);
        const ro = [...this.readOnly, dirname(dirname(dirname(binary)))];
        const launcher = plainPath(this.ctx.launcher);
        const hostbin = dirname(
            this.writeWrapper(launch(launcher, this.ctx.keep, this.timeEnv, [binary], ro)),
        );
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
                PATH: `${hostbin}:${this.toolchain.path}:${process.env.PATH ?? ""}`,
            },
        });
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

    private writeWrapper(argv: string[]): string {
        const dir = join(dirname(this.ctx.launcher), "hostbin", this.ctx.arm);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "opencode");
        const staged = `${path}.${process.pid}`;
        writeFileSync(staged, `#!/bin/sh\nexec ${argv.map(shellQuote).join(" ")} "$@"\n`, {
            mode: 0o755,
        });
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
        const pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e) && serves(e));
        return pids.length > 0 ? Math.min(...pids.map(Number)) : null;
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
            await withDeadline(
                abort.catch(() => undefined),
                5_000,
            );
            const drained = await withDeadline(settled, 30_000);
            if (drained === null) throw new Error("OpenCode turn still running 30 s after abort");
            return { error: `turn deadline ${timeoutMs} ms` };
        }
        if ("caught" in first) return { error: String(first.caught).slice(0, 2000) };
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
