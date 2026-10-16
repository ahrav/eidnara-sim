import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/config";
import { running } from "../run/procs";
import {
    DaemonStack,
    type HostContext,
    nodeInstall,
    OpencodeSimHost,
    opencodeInstall,
    PiSimHost,
} from "./arms";

type Untyped = any;

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function context(run: string): HostContext {
    const root = join(run, "arm");
    mkdirSync(root);
    const bin = join(run, "oc/node_modules/opencode-ai/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode.exe"), "", { mode: 0o755 });
    return {
        config: { ...loadConfig(), opencode_binary: join(bin, "opencode.exe") },
        arm: "host",
        host: "pi",
        root,
        launcher: join(run, "sandbox.sh"),
        offsetFile: join(run, "clock/offset"),
        keep: [root],
        proxyHttp1: "http://127.0.0.1:1",
        proxyHttp2: "http://127.0.0.1:2",
        model: "m",
        contextLimit: 1000,
    };
}

const runDir = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "sim-arms-")));
    dirs.push(d);
    return d;
};

const PORT = "45981";

/** Stands in for the v1 harness modules `arms.ts` imports from `eidnara_checkout`. */
function fakeV1(run: string): string {
    const checkout = join(run, "eidnara");
    const e2e = join(checkout, "packages/e2e-tests");
    mkdirSync(join(e2e, "src/pi-runner"), { recursive: true });
    mkdirSync(join(e2e, "src/opencode-runner"), { recursive: true });
    mkdirSync(join(e2e, "node_modules/@opencode-ai/sdk/dist"), { recursive: true });
    writeFileSync(
        join(e2e, "src/pi-runner/rpc-client.ts"),
        `export class PiRpcProtocol {}
export class PiRpcProcess {
    constructor(public child: any) { globalThis.__simPiChild = child; }
    sendCommand() {
        if (globalThis.__simGetState === "refuse") return Promise.resolve({ success: false, error: "no model" });
        if (globalThis.__simGetState === "ok") return Promise.resolve({ success: true, data: {} });
        return Promise.reject(new Error("get_state failed"));
    }
    shutdown() { return Promise.resolve(); }
}
`,
    );
    writeFileSync(
        join(e2e, "src/opencode-runner/spawn.ts"),
        `export async function spawnOpencode(opts: any) {
    globalThis.__simSpawnOpts = opts;
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 300; exit 0", "sh", "serve", "${PORT}"]);
    // The runner answers once the server is observable, as the real one does after readiness.
    const { readFileSync } = await import("node:fs");
    for (let i = 0; i < 200; i++) {
        try {
            if (readFileSync("/proc/" + child.pid + "/cmdline", "utf8").includes("serve")) break;
        } catch {}
        await Bun.sleep(5);
    }
    return { url: "http://127.0.0.1:${PORT}", port: ${PORT}, kill: async () => child.kill() };
}
`,
    );
    writeFileSync(
        join(e2e, "node_modules/@opencode-ai/sdk/dist/index.js"),
        `export function createOpencodeClient() {
    return { session: {
        list: async () => {
            if (globalThis.__simList === "error") return { error: { name: "ServerError" } };
            throw new Error("list failed");
        },
        create: async () => { globalThis.__simCreated = true; return { data: { id: "fresh" } }; },
    } };
}
`,
    );
    writeFileSync(join(run, "sandbox.sh"), "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const cli = join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "setInterval(() => {}, 1000);\n");
    return checkout;
}

function serving(): number[] {
    const uid = process.getuid?.();
    return readdirSync("/proc")
        .filter((e) => /^\d+$/.test(e))
        .map(Number)
        .filter((pid) => {
            try {
                const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
                return (
                    statSync(`/proc/${pid}`).uid === uid &&
                    cmd.includes("serve") &&
                    cmd.includes(PORT)
                );
            } catch {
                return false;
            }
        });
}

async function gone(pid: number): Promise<boolean> {
    for (let i = 0; i < 100 && running(pid); i++) await Bun.sleep(50);
    return !running(pid);
}

function fakeRpc(opts: { promptFails?: boolean; ends: Untyped[]; drainEnds?: boolean }) {
    const commands: string[] = [];
    const listeners: Array<(e: Untyped) => void> = [];
    let served = 0;
    return {
        commands,
        onEvent(listener: (e: Untyped) => void) {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        sendCommand(method: string): Promise<Untyped> {
            if (method !== "get_state") commands.push(method);
            if (method === "prompt" && opts.promptFails) return Promise.reject(new Error("boom"));
            if (method === "get_state") {
                return Promise.resolve({
                    success: true,
                    data: { isStreaming: false, isCompacting: false },
                });
            }
            return Promise.resolve({ success: true });
        },
        waitForEvent(predicate: (e: Untyped) => boolean, o: { timeoutMs: number }) {
            const stillRunning = commands.includes("abort") && opts.drainEnds === false;
            if (stillRunning) return Promise.reject(new Error(`timeout ${o.timeoutMs}`));
            for (; served < opts.ends.length; served++) {
                const event = opts.ends[served];
                for (const l of [...listeners]) l(event);
                if (predicate(event)) {
                    served++;
                    return Promise.resolve(event);
                }
            }
            return Promise.reject(new Error(`no agent_end within ${o.timeoutMs}`));
        },
    };
}

/** Replays `script` as timed Pi events after the prompt; get_state reports busy until `idleAt` ms. */
function liveRpc(script: Array<[number, Untyped]>, idleAt: number) {
    const listeners: Array<(e: Untyped) => void> = [];
    let started = 0;
    const emit = (e: Untyped) => {
        for (const l of [...listeners]) l(e);
    };
    return {
        onEvent(listener: (e: Untyped) => void) {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        sendCommand(method: string): Promise<Untyped> {
            if (method === "prompt") {
                started = Date.now();
                for (const [ms, e] of script) setTimeout(() => emit(e), ms);
            }
            if (method === "get_state") {
                const busy = Date.now() - started < idleAt;
                return Promise.resolve({
                    success: true,
                    data: { isStreaming: busy, isCompacting: false },
                });
            }
            return Promise.resolve({ success: true });
        },
        waitForEvent(predicate: (e: Untyped) => boolean, o: { timeoutMs: number }) {
            return new Promise((resolve, reject) => {
                const off = this.onEvent((e: Untyped) => {
                    if (!predicate(e)) return;
                    off();
                    clearTimeout(timer);
                    resolve(e);
                });
                const timer = setTimeout(() => {
                    off();
                    reject(new Error(`no agent_end within ${o.timeoutMs}`));
                }, o.timeoutMs);
            });
        },
    };
}

function piHost(ctx: HostContext): PiSimHost {
    const host = new PiSimHost(ctx);
    (host as Untyped).settleMs = 1;
    (host as Untyped).drainMs = 200;
    return host;
}

test("a Pi turn waits through an agent_end that Pi will retry", async () => {
    const host = piHost(context(runDir()));
    const retrying = {
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }],
    };
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    (host as Untyped).rpc = fakeRpc({ ends: [retrying, final] });
    expect(await host.prompt("hi", 1_000)).toEqual({});
});

test("a Pi prompt Pi refuses returns its error without aborting or draining a turn", async () => {
    const host = piHost(context(runDir()));
    const rpc = fakeRpc({ ends: [] });
    rpc.sendCommand = (method: string) => {
        rpc.commands.push(method);
        return Promise.resolve({ success: false, error: "busy" });
    };
    (host as Untyped).rpc = rpc;
    expect(await host.prompt("hi", 1_000)).toEqual({ error: '{"success":false,"error":"busy"}' });
    expect(rpc.commands).toEqual(["prompt"]);
});

test("a Pi turn whose abort cannot drain the previous turn fails the session", async () => {
    const host = piHost(context(runDir()));
    const rpc = fakeRpc({ promptFails: true, ends: [], drainEnds: false });
    (host as Untyped).rpc = rpc;
    await expect(host.prompt("hi", 1_000)).rejects.toThrow(/agent_end/);
    expect(rpc.commands).toEqual(["prompt", "abort"]);
});

test("a settled OpenCode turn leaves no deadline timer holding the runtime", async () => {
    const script = `
import { OpencodeSimHost } from "./src/hosts/arms";
import { loadConfig } from "./src/config/config";
const run = process.argv[1];
const host = new OpencodeSimHost({
    config: loadConfig(), arm: "host", host: "opencode", root: run + "/arm", launcher: run + "/sandbox.sh",
    offsetFile: run + "/offset", keep: [run + "/arm"], proxyHttp1: "", proxyHttp2: "", model: "m", contextLimit: 1,
});
(host as any).sid = "s";
(host as any).client = { session: { prompt: async () => ({ data: { info: {} } }) } };
console.log(JSON.stringify(await host.prompt("hi", 20_000)));
`;
    const started = Date.now();
    const child = Bun.spawn(["bun", "-e", script, runDir()], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
    if (code === null) child.kill("SIGKILL");
    expect(code).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("{}\n");
    expect(Date.now() - started).toBeLessThan(5_000);
}, 15_000);

test("the OpenCode wrapper stops before the launcher when its launch record cannot be written", async () => {
    const run = runDir();
    const ctx = { ...context(run), host: "opencode" as const, root: join(run, "gone", "arm") };
    const host = new OpencodeSimHost(ctx);
    const path = (host as Untyped).writeWrapper(["/bin/sh", "-c", "touch ran"]) as string;
    const r = Bun.spawnSync([path], { cwd: run, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(70);
    expect(existsSync(join(run, "ran"))).toBe(false);
});

test("the daemon's harness runtime lives beside the arm, outside what the host can write", () => {
    const run = runDir();
    const stack = new DaemonStack({
        config: loadConfig(),
        root: join(run, "arm", "r"),
        dataDir: join(run, "arm", "s", "d"),
        logFile: join(run, "arm", "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    expect(stack.runtimeDir).toBe(join(run, "arm", "runtime"));
});

test("the OpenCode wrapper lives outside every path the sandbox keeps writable", async () => {
    const ctx = { ...context(runDir()), host: "opencode" as const };
    const host = new OpencodeSimHost(ctx);
    const path = (host as Untyped).writeWrapper(["/x/sandbox.sh", "--", "/x/opencode"]) as string;
    for (const kept of ctx.keep) expect(path.startsWith(`${kept}/`)).toBe(false);
    const record = join(dirname(ctx.root), "opencode.launch");
    expect(await Bun.file(path).text()).toBe(
        `#!/bin/sh\nr='${record}'\nprintf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" > "$r.$$" || exit 70\nmv -f "$r.$$" "$r" || exit 70\nexec '/x/sandbox.sh' '--' '/x/opencode' "$@"\n`,
    );
});

test("a Pi session whose readiness check fails stops the launcher tree it spawned", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = context(run);
    const config = { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout };
    const host = new PiSimHost({ ...ctx, config });
    const outcome = await host.openSession(join(run, "arm"), "s1", null).then(
        () => "opened",
        (e: unknown) => String(e),
    );
    const child = (globalThis as Untyped).__simPiChild;
    try {
        expect(outcome).toContain("get_state failed");
        expect(await gone(child.pid)).toBe(true);
    } finally {
        child.kill("SIGKILL");
        await host.closeSession().catch(() => undefined);
    }
});

test("an OpenCode session whose SDK setup fails stops the server it spawned", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const config = { ...ctx.config, eidnara_checkout: checkout };
    const host = new OpencodeSimHost({ ...ctx, config });
    const outcome = await host.openSession(join(run, "arm"), "s1", null).then(
        () => "opened",
        (e: unknown) => String(e),
    );
    await Bun.sleep(200);
    const left = serving();
    for (const pid of left) process.kill(pid, "SIGKILL");
    await host.closeSession().catch(() => undefined);
    expect(outcome).toContain("list failed");
    expect(left).toEqual([]);
});

test("an OpenCode session reports its spawn before the SDK setup runs", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const config = { ...ctx.config, eidnara_checkout: checkout };
    const spawned: Array<number | null> = [];
    const host = new OpencodeSimHost({
        ...ctx,
        config,
        onSpawn: () => void spawned.push(host.hostPid()),
    });
    await host.openSession(ctx.root, "s1", null).catch(() => undefined);
    await Bun.sleep(200);
    for (const pid of serving()) process.kill(pid, "SIGKILL");
    await host.closeSession().catch(() => undefined);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toBeNull();
});

test("the Pi launcher runs only once the host's pid is recorded", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const marker = join(run, "launched");
    writeFileSync(join(run, "sandbox.sh"), `#!/bin/sh\ntouch '${marker}'\nexec sleep 300\n`, {
        mode: 0o755,
    });
    const ctx = context(run);
    const host = new PiSimHost({
        ...ctx,
        config: { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout },
        onSpawn: () => {
            throw new Error("state.json: ENOSPC");
        },
    });
    await expect(host.openSession(ctx.root, "s1", null)).rejects.toThrow("ENOSPC");
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
    const child = (globalThis as Untyped).__simPiChild;
    expect(await gone(child.pid)).toBe(true);
});

test("a Pi session whose readiness response is a refusal fails and stops the launcher tree", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = context(run);
    const config = { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout };
    const host = new PiSimHost({ ...ctx, config });
    (globalThis as Untyped).__simGetState = "refuse";
    const opened = host.openSession(join(run, "arm"), "s1", null).then(
        () => "opened",
        (e: unknown) => String(e),
    );
    const outcome = await opened;
    const child = (globalThis as Untyped).__simPiChild;
    try {
        expect(outcome).toMatch(/no model/);
        expect(await gone(child.pid)).toBe(true);
    } finally {
        (globalThis as Untyped).__simGetState = undefined;
        child.kill("SIGKILL");
        await host.closeSession().catch(() => undefined);
    }
});

test("an OpenCode session-list error fails the open instead of creating a second session", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const config = { ...ctx.config, eidnara_checkout: checkout };
    const host = new OpencodeSimHost({ ...ctx, config });
    (globalThis as Untyped).__simList = "error";
    (globalThis as Untyped).__simCreated = false;
    const outcome = await host.openSession(join(run, "arm"), "s1", null).then(
        () => "opened",
        (e: unknown) => String(e),
    );
    try {
        expect(outcome).toMatch(/ServerError/);
        expect((globalThis as Untyped).__simCreated).toBe(false);
    } finally {
        (globalThis as Untyped).__simList = undefined;
        await host.closeSession().catch(() => undefined);
        for (const pid of serving()) process.kill(pid, "SIGKILL");
    }
});

test("a rejected OpenCode prompt request aborts the turn before reporting the error", async () => {
    const run = runDir();
    const host = new OpencodeSimHost({ ...context(run), host: "opencode" });
    const calls: string[] = [];
    (host as Untyped).sid = "s";
    (host as Untyped).client = {
        session: {
            prompt: async () => {
                calls.push("prompt");
                throw new Error("socket hang up");
            },
            abort: async () => {
                calls.push("abort");
                return { data: true };
            },
        },
    };
    expect(await host.prompt("hi", 1_000)).toEqual({ error: "Error: socket hang up" });
    expect(calls).toEqual(["prompt", "abort"]);
    (host as Untyped).client.session.abort = async () => {
        throw new Error("abort failed");
    };
    await expect(host.prompt("hi", 1_000)).rejects.toThrow(/rejected prompt/);
});

test("Pi control files are written only through a real directory under the arm root", () => {
    const run = runDir();
    const ctx = context(run);
    const elsewhere = join(run, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(ctx.root, "home/.pi"), { recursive: true });
    symlinkSync(elsewhere, join(ctx.root, "home/.pi/agent"));
    const host = new PiSimHost(ctx);
    expect(() => (host as Untyped).writeConfigs(null)).toThrow(/symlink|real directory/);
    expect(existsSync(join(elsewhere, "settings.json"))).toBe(false);
});

test("a Pi control file that an agent replaced with a symlink is replaced, and its target kept", () => {
    const run = runDir();
    const ctx = context(run);
    const target = join(run, "precious.json");
    writeFileSync(target, "keep\n");
    const host = new PiSimHost(ctx);
    mkdirSync(host.agentDir, { recursive: true });
    symlinkSync(target, join(host.agentDir, "settings.json"));
    (host as Untyped).writeConfigs(null);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(join(host.agentDir, "settings.json")).isSymbolicLink()).toBe(false);
});

test("a Pi turn whose end was observed before the prompt response failed keeps that result", async () => {
    const host = piHost(context(runDir()));
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const rpc = fakeRpc({ promptFails: true, ends: [final] });
    (host as Untyped).rpc = rpc;
    expect(await host.prompt("hi", 1_000)).toEqual({});
    expect(rpc.commands).toEqual(["prompt"]);
});

test("an OpenCode abort that stays pending past its deadline fails the session", async () => {
    const host = new OpencodeSimHost({ ...context(runDir()), host: "opencode" });
    (host as Untyped).sid = "s";
    (host as Untyped).abortWaitMs = 200;
    (host as Untyped).client = {
        session: {
            prompt: () => Bun.sleep(300).then(() => ({ data: { info: {} } })),
            abort: () => new Promise(() => undefined),
        },
    };
    await expect(host.prompt("hi", 50)).rejects.toThrow(/abort still pending/);
});

function fakeDaemonV1(run: string): string {
    const checkout = join(run, "eidnara");
    const e2e = join(checkout, "packages/e2e-tests/src");
    mkdirSync(join(e2e, "bedrock-peer"), { recursive: true });
    mkdirSync(join(e2e, "rust-runner"), { recursive: true });
    writeFileSync(
        join(e2e, "bedrock-peer/harness-runtime.ts"),
        `import { writeFileSync } from "node:fs";
export function detectHarnessRuntimeSources() { return { ok: true, sources: {} }; }
export function writeHarnessRuntime(args: { dir: string }) {
    writeFileSync(args.dir + "/runtime.json", "{}");
    return { dir: args.dir };
}
`,
    );
    writeFileSync(
        join(e2e, "rust-runner/hermetic-host.ts"),
        `export class HermeticHostStack {
    static async start() {
        return { connectionFile: "c", child: { pid: 1 }, hostLog: () => "", terminateHost: async () => undefined, restartHost: async () => undefined };
    }
}
`,
    );
    return checkout;
}

test("the daemon stack refuses a symlinked store directory and replaces a symlinked runtime", async () => {
    const run = runDir();
    const checkout = fakeDaemonV1(run);
    const root = join(run, "arm");
    const store = join(run, "s");
    const elsewhere = join(run, "elsewhere");
    for (const d of [root, store, elsewhere]) mkdirSync(d);
    const stack = (dataDir: string) =>
        new DaemonStack({
            config: { ...loadConfig(), eidnara_checkout: checkout },
            root,
            dataDir,
            logFile: join(run, "daemon.log"),
            offsetFile: join(run, "offset"),
            proxyHttp1: "",
            proxyHttp2: "",
            model: "m",
        });
    symlinkSync(elsewhere, join(store, "d"));
    await expect(stack(join(store, "d")).start()).rejects.toThrow(/symlink/);
    rmSync(join(store, "d"));
    rmSync(join(run, "runtime"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(run, "runtime"));
    await stack(join(store, "d")).start();
    expect(existsSync(join(elsewhere, "runtime.json"))).toBe(false);
    expect(lstatSync(join(run, "runtime")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(run, "runtime/runtime.json"))).toBe(true);
    expect(existsSync(join(root, "runtime"))).toBe(false);
});

test("OpenCode teardown targets the server this harness spawned, not another process on the port", async () => {
    const host = new OpencodeSimHost({ ...context(runDir()), host: "opencode" });
    // The decoy's parent exits at once, so the decoy is reparented away from this process.
    Bun.spawnSync([
        "/bin/sh",
        "-c",
        `/bin/sh -c 'sleep 300; exit 0' sh serve ${PORT} >/dev/null 2>&1 &`,
    ]);
    const real = Bun.spawn(["/bin/sh", "-c", "sleep 300; exit 0", "sh", "serve", PORT], {
        stdio: ["ignore", "ignore", "ignore"],
    });
    await Bun.sleep(100);
    (host as Untyped).oc = { port: Number(PORT) };
    try {
        expect(serving().length).toBe(2);
        expect(host.hostPid()).toBe(real.pid);
    } finally {
        (host as Untyped).oc = null;
        for (const pid of serving()) process.kill(pid, "SIGKILL");
    }
}, 10_000);

test("a Pi turn waits through Pi's post-run overflow compaction and its continuation", async () => {
    const host = piHost(context(runDir()));
    (host as Untyped).settleMs = 50;
    const overflow = {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "prompt is too long" }],
    };
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    (host as Untyped).rpc = liveRpc(
        [
            [0, overflow],
            [30, { type: "compaction_start", reason: "overflow" }],
            [60, { type: "compaction_end", reason: "overflow", willRetry: true }],
            [70, { type: "agent_start" }],
            [120, final],
        ],
        120,
    );
    expect(await host.prompt("hi", 5_000)).toEqual({});
});

test("a control directory under a symlinked ancestor is refused before anything is created", () => {
    const run = runDir();
    const ctx = context(run);
    const elsewhere = join(run, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(ctx.root, "home"));
    symlinkSync(elsewhere, join(ctx.root, "home/.pi"));
    const host = new PiSimHost(ctx);
    expect(() => (host as Untyped).writeConfigs(null)).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "agent"))).toBe(false);
});

test("an OpenCode session under a symlinked home leaves the link's target untouched", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const elsewhere = join(run, "elsewhere");
    mkdirSync(join(elsewhere, "config"), { recursive: true });
    writeFileSync(join(elsewhere, "config/precious"), "keep\n");
    symlinkSync(elsewhere, join(ctx.root, "home"));
    const host = new OpencodeSimHost({
        ...ctx,
        config: { ...ctx.config, eidnara_checkout: checkout },
    });
    const outcome = await host.openSession(join(run, "arm"), "s1", null).then(
        () => "opened",
        (e: unknown) => String(e),
    );
    for (const pid of serving()) process.kill(pid, "SIGKILL");
    expect(outcome).toMatch(/symlink/);
    expect(readFileSync(join(elsewhere, "config/precious"), "utf8")).toBe("keep\n");
});

test("an OpenCode deadline whose abort fails stops the session", async () => {
    const host = new OpencodeSimHost({ ...context(runDir()), host: "opencode" });
    (host as Untyped).sid = "s";
    (host as Untyped).client = {
        session: {
            prompt: () => Bun.sleep(100).then(() => Promise.reject(new Error("late failure"))),
            abort: async () => ({ error: { name: "NotFound" } }),
        },
    };
    await expect(host.prompt("hi", 20)).rejects.toThrow(/not aborted/);
});

test("a refused Pi get_state while settling does not count the turn as settled", async () => {
    const host = piHost(context(runDir()));
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const rpc = liveRpc([[0, final]], 0);
    const send = rpc.sendCommand.bind(rpc);
    rpc.sendCommand = (method: string) =>
        method === "get_state" ? Promise.resolve({ success: false, error: "busy" }) : send(method);
    (host as Untyped).rpc = rpc;
    await expect(host.prompt("hi", 2_000)).rejects.toThrow(/still running/);
});

test("settling a Pi turn stays within the turn deadline when get_state hangs", async () => {
    const host = piHost(context(runDir()));
    (host as Untyped).settleMs = 50;
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const rpc = liveRpc([[0, final]], 0);
    const send = rpc.sendCommand.bind(rpc);
    rpc.sendCommand = (method: string, _p?: Untyped, o?: { timeoutMs: number }) =>
        method === "get_state"
            ? Bun.sleep(o?.timeoutMs ?? 0).then(() =>
                  Promise.reject(new Error("get_state timeout")),
              )
            : send(method);
    (host as Untyped).rpc = rpc;
    const started = Date.now();
    await expect(host.prompt("hi", 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
});

function daemonStack(run: string, logFile = join(run, "daemon.log")) {
    return new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile,
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
}

function fakeChild() {
    const { PassThrough } = require("node:stream");
    return { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() };
}

test("appending the daemon log refuses a symlink left at the log path", async () => {
    const run = runDir();
    const target = join(run, "precious");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(run, "daemon.log"));
    let terminated = false;
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            terminated = true;
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("log\n");
    await Bun.sleep(20);
    await expect(stack.stop()).rejects.toThrow(/ELOOP|symbolic link/);
    expect(terminated).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
});

test("a daemon that outlives SIGTERM is killed before stop reports the failure", async () => {
    const run = runDir();
    let crashed = false;
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    (stack as Untyped).stack = {
        hostLog: () => "",
        terminateHost: async () => {
            throw new Error("direct host fixture did not exit after SIGTERM");
        },
        crashHost: async () => {
            crashed = true;
        },
    };
    await expect(stack.stop()).rejects.toThrow(/SIGTERM/);
    expect(crashed).toBe(true);
    expect(stack.pid()).toBeNull();
});

test("Pi runs in the session workspace, which the host names as the launcher's start directory", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const cli = join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(
        cli,
        'require("fs").writeFileSync(process.env.HOME + "/cwd", process.cwd()); setInterval(() => {}, 1000);\n',
    );
    writeFileSync(
        join(run, "sandbox.sh"),
        '#!/bin/sh\nstart="$1"; shift\nwhile [ "$1" != "--" ]; do shift; done\nshift\ncd "$start"\nexec "$@"\n',
        { mode: 0o755 },
    );
    const ctx = context(run);
    const workspace = join(ctx.root, "ws");
    mkdirSync(workspace);
    const host = new PiSimHost({
        ...ctx,
        config: { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout },
    });
    (globalThis as Untyped).__simGetState = "ok";
    try {
        await host.openSession(workspace, "s1", null);
        const file = join(ctx.root, "home/cwd");
        for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(20);
        expect(readFileSync(file, "utf8")).toBe(workspace);
    } finally {
        (globalThis as Untyped).__simGetState = undefined;
        await host.closeSession().catch(() => undefined);
    }
});

test("the protected OpenCode install is the canonical binary's, not the symlink's", () => {
    const run = runDir();
    const real = join(run, "real/node_modules/opencode-ai/bin");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "opencode.exe"), "", { mode: 0o755 });
    const linked = join(run, "linked/node_modules/opencode-ai/bin");
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(real, "opencode.exe"), join(linked, "opencode.exe"));
    const install = opencodeInstall({
        ...loadConfig(),
        opencode_binary: join(linked, "opencode.exe"),
    });
    expect(install.binary).toBe(join(real, "opencode.exe"));
    expect(install.root).toBe(join(run, "real/node_modules"));
});

test("the daemon's output reaches daemon.log as it is written, through a graceful stop", async () => {
    const run = runDir();
    const stack = daemonStack(run);
    const child = fakeChild();
    let onDiskAtTerminate = "";
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            onDiskAtTerminate = await Bun.file(join(run, "daemon.log")).text();
            child.stderr.write("shutting down cleanly\n");
            await Bun.sleep(20);
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("booted\n");
    await Bun.sleep(20);
    await stack.stop();
    expect(onDiskAtTerminate).toBe("booted\n");
    expect(await Bun.file(join(run, "daemon.log")).text()).toBe("booted\nshutting down cleanly\n");
});

test("a restarted daemon's output follows the previous generation's in daemon.log", async () => {
    const run = runDir();
    const stack = daemonStack(run);
    const first = fakeChild();
    const second = fakeChild();
    const inner = {
        child: first,
        crashHost: async () => undefined,
        startHost: async () => void (inner.child = second),
        terminateHost: async () => undefined,
    };
    (stack as Untyped).stack = inner;
    (stack as Untyped).attach();
    first.stdout.write("booted\n");
    await Bun.sleep(20);
    await stack.restart();
    second.stdout.write("booted\n");
    await Bun.sleep(20);
    await stack.stop();
    expect(await Bun.file(join(run, "daemon.log")).text()).toBe("booted\nbooted\n");
});

test("stopping the daemon stack terminates the daemon even when the log cannot be appended", async () => {
    const run = runDir();
    let terminated = false;
    const stack = daemonStack(run, join(run, "missing-dir", "daemon.log"));
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            terminated = true;
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("log\n");
    await Bun.sleep(20);
    await expect(stack.stop()).rejects.toThrow(/ENOENT/);
    expect(terminated).toBe(true);
});

test("OpenCode gets the hosts' sandbox PATH, not the harness's ambient one", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const host = new OpencodeSimHost({
        ...ctx,
        config: { ...ctx.config, eidnara_checkout: checkout },
    });
    const ambient = process.env.PATH;
    process.env.PATH = `/sim-ambient-marker:${ambient}`;
    try {
        await host.openSession(join(run, "arm"), "s1", null).catch(() => undefined);
    } finally {
        process.env.PATH = ambient;
        for (const pid of serving()) process.kill(pid, "SIGKILL");
    }
    const path = (globalThis as Untyped).__simSpawnOpts.extraEnv.PATH as string;
    expect(path.includes("/sim-ambient-marker")).toBe(false);
    expect(path.endsWith(":/usr/local/bin:/usr/bin:/bin")).toBe(true);
});

test("the daemon store is walked from the arm directory, so a symlinked ancestor is refused", async () => {
    const run = runDir();
    const checkout = fakeDaemonV1(run);
    const root = join(run, "arm");
    const elsewhere = join(run, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(run, "daemon"));
    const stack = new DaemonStack({
        config: { ...loadConfig(), eidnara_checkout: checkout },
        root,
        dataDir: join(run, "daemon/store"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    await expect(stack.start()).rejects.toThrow(/symlink/);
    expect(existsSync(join(elsewhere, "store"))).toBe(false);
});

test("Pi launches the canonical node that preflight probed, whatever its install layout", () => {
    const run = runDir();
    mkdirSync(join(run, "opt/runtime"), { recursive: true });
    writeFileSync(join(run, "opt/runtime/node"), "", { mode: 0o755 });
    symlinkSync(join(run, "opt/runtime/node"), join(run, "node-link"));
    const install = nodeInstall(join(run, "node-link"));
    expect(install.exe).toBe(join(run, "opt/runtime/node"));
    expect(install.bin).toBe(join(run, "opt/runtime"));
    expect(install.root).toBe(join(run, "opt/runtime"));
});

test("the output a daemon wrote while starting reaches daemon.log once the stack is up", async () => {
    const run = runDir();
    const stack = daemonStack(run);
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        stdout: "starting out\n",
        stderr: "starting err\n",
        terminateHost: async () => undefined,
    };
    (stack as Untyped).attach();
    child.stdout.write("live\n");
    await Bun.sleep(20);
    await stack.stop();
    expect(readFileSync(join(run, "daemon.log"), "utf8")).toBe(
        "starting out\nstarting err\nlive\n",
    );
});

test("the daemon log keeps what the daemon wrote while it shut down", async () => {
    const run = runDir();
    let terminated = false;
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            terminated = true;
            child.stderr.write("shutting down\n");
            await Bun.sleep(20);
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("running\n");
    await Bun.sleep(20);
    await stack.stop();
    expect(terminated).toBe(true);
    expect(readFileSync(join(run, "daemon.log"), "utf8")).toBe("running\nshutting down\n");
});

test("a standalone OpenCode binary keeps its own directory read-only, not the filesystem root", () => {
    const run = runDir();
    mkdirSync(join(run, "opt"));
    writeFileSync(join(run, "opt/opencode"), "", { mode: 0o755 });
    const install = opencodeInstall({
        ...loadConfig(),
        opencode_binary: join(run, "opt/opencode"),
    });
    expect(install.binary).toBe(join(run, "opt/opencode"));
    expect(install.root).toBe(join(run, "opt"));
});

test("a Pi turn stays open while compaction has promised a continuation", async () => {
    const host = piHost(context(runDir()));
    (host as Untyped).settleMs = 50;
    const overflow = {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "prompt is too long" }],
    };
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const rpc = liveRpc(
        [
            [0, overflow],
            [20, { type: "compaction_start", reason: "overflow" }],
            [40, { type: "compaction_end", reason: "overflow", willRetry: true }],
            [400, { type: "agent_start" }],
            [450, final],
        ],
        0,
    );
    (host as Untyped).rpc = rpc;
    expect(await host.prompt("hi", 5_000)).toEqual({});
});

test("OpenCode counts an abort as confirmed only when the server answers true", async () => {
    const host = new OpencodeSimHost({ ...context(runDir()), host: "opencode" });
    (host as Untyped).sid = "s";
    (host as Untyped).client = {
        session: {
            prompt: async () => {
                throw new Error("socket hang up");
            },
            abort: async () => ({ data: false }),
        },
    };
    await expect(host.prompt("hi", 1_000)).rejects.toThrow(/not aborted/);
});

test("a FIFO left at the daemon log path fails the append without blocking teardown", async () => {
    const run = runDir();
    expect(Bun.spawnSync(["mkfifo", join(run, "daemon.log")]).exitCode).toBe(0);
    let terminated = false;
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            terminated = true;
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("log\n");
    await Bun.sleep(20);
    const outcome = await Promise.race([
        stack.stop().then(
            () => "stopped",
            (e: unknown) => String(e),
        ),
        Bun.sleep(2_000).then(() => "hung"),
    ]);
    expect(outcome).toMatch(/ENXIO|not a regular file/);
    expect(terminated).toBe(true);
});

test("a failed SIGKILL fallback still records the log and reports both failures", async () => {
    const run = runDir();
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const child = fakeChild();
    (stack as Untyped).stack = {
        child,
        terminateHost: async () => {
            throw new Error("did not exit after SIGTERM");
        },
        crashHost: async () => {
            throw new Error("did not exit after SIGKILL");
        },
    };
    (stack as Untyped).attach();
    child.stdout.write("last words\n");
    await Bun.sleep(20);
    await expect(stack.stop()).rejects.toThrow(/SIGTERM[\s\S]*SIGKILL/);
    expect(readFileSync(join(run, "daemon.log"), "utf8")).toBe("last words\n");
});

test("the scenario clock directory is read-only inside host sandboxes", () => {
    const run = runDir();
    const ctx = { ...context(run), offsetFile: join(run, "clock/offset") };
    expect(new PiSimHost(ctx).readOnly).toContain(join(run, "clock"));
});

test("a session workspace outside every kept path is refused before launch", async () => {
    const run = runDir();
    const host = new PiSimHost(context(run));
    const outside = join(run, "elsewhere");
    mkdirSync(outside);
    await expect(host.openSession(outside, "s1", null)).rejects.toThrow(
        `workspace ${outside} is not under a kept path`,
    );
});

test("a launch whose identity was never captured is not signalled at teardown", async () => {
    const host = new PiSimHost(context(runDir()));
    const child = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(100);
    try {
        await (host as Untyped).stopTree(child.pid, null);
        expect(running(child.pid)).toBe(true);
    } finally {
        child.kill("SIGKILL");
    }
});

test("an OpenCode session list that never answers fails the open and stops the server", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    writeFileSync(
        join(checkout, "packages/e2e-tests/node_modules/@opencode-ai/sdk/dist/index.js"),
        "export function createOpencodeClient() { return { session: { list: () => new Promise(() => {}) } }; }\n",
    );
    const ctx = { ...context(run), host: "opencode" as const };
    const host = new OpencodeSimHost({
        ...ctx,
        config: { ...ctx.config, eidnara_checkout: checkout },
    });
    (host as Untyped).setupMs = 200;
    const outcome = await Promise.race([
        host.openSession(join(run, "arm"), "s1", null).then(
            () => "opened",
            (e: unknown) => String(e),
        ),
        Bun.sleep(3_000).then(() => "hung"),
    ]);
    await Bun.sleep(100);
    const left = serving();
    for (const pid of left) process.kill(pid, "SIGKILL");
    expect(outcome).toMatch(/session setup/);
    expect(left).toEqual([]);
});

test("a Pi abort that never answers does not delay a drain that already ended", async () => {
    const host = piHost(context(runDir()));
    const final = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const rpc = liveRpc([[50, final]], 0);
    const send = rpc.sendCommand.bind(rpc);
    rpc.sendCommand = (method: string) => {
        if (method === "prompt") return send(method).then(() => Promise.reject(new Error("lost")));
        if (method === "abort") return new Promise(() => {});
        return send(method);
    };
    (host as Untyped).rpc = rpc;
    (host as Untyped).drainMs = 2_000;
    const started = Date.now();
    expect(await host.prompt("hi", 5_000)).toEqual({ error: "Error: lost" });
    expect(Date.now() - started).toBeLessThan(1_000);
});

test("a daemon whose forced shutdown is unconfirmed stays tracked for another stop", async () => {
    const run = runDir();
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const fake = {
        hostLog: () => "",
        terminateHost: async () => {
            throw new Error("did not exit after SIGTERM");
        },
        crashHost: async () => {
            throw new Error("did not exit after SIGKILL");
        },
    };
    (stack as Untyped).stack = fake;
    await expect(stack.stop()).rejects.toThrow(/SIGKILL/);
    expect((stack as Untyped).stack).toBe(fake);
});

test("a restart records the old daemon's output after it is killed and before the new start", async () => {
    const run = runDir();
    const calls: string[] = [];
    const stack = daemonStack(run);
    const old = fakeChild();
    const fresh = fakeChild();
    const inner = {
        child: old,
        crashHost: async () => {
            calls.push("crash");
            old.stderr.write("last bytes\n");
            await Bun.sleep(20);
        },
        startHost: async () => {
            calls.push("start");
            inner.child = fresh;
        },
        restartHost: async () => {
            calls.push("restart");
        },
    };
    (stack as Untyped).stack = inner;
    (stack as Untyped).attach();
    old.stdout.write("before kill\n");
    await Bun.sleep(20);
    await stack.restart();
    expect(calls).toEqual(["crash", "start"]);
    expect(readFileSync(join(run, "daemon.log"), "utf8")).toBe("before kill\nlast bytes\n");
});

test("a Pi turn ending just before its deadline still waits the full quiet window", async () => {
    const host = piHost(context(runDir()));
    (host as Untyped).settleMs = 200;
    const end = { type: "agent_end", willRetry: false, messages: [{ role: "assistant" }] };
    const late = { type: "agent_start" };
    const final = {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "late" }],
    };
    (host as Untyped).rpc = liveRpc(
        [
            [250, end],
            [400, late],
            [420, final],
        ],
        0,
    );
    const started = Date.now();
    const outcome = await host.prompt("hi", 300).catch((e: unknown) => String(e));
    expect(outcome).not.toEqual({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(440);
});

test("a staged control file left by an earlier session does not block the next write", () => {
    const ctx = context(runDir());
    const host = new PiSimHost(ctx);
    mkdirSync(host.agentDir, { recursive: true });
    writeFileSync(join(host.agentDir, `settings.json.${process.pid}`), "stale\n");
    (host as Untyped).writeConfigs(null);
    expect(
        JSON.parse(readFileSync(join(host.agentDir, "settings.json"), "utf8")).defaultModel,
    ).toBe("m");
});

test("a Pi session whose shutdown is unconfirmed keeps its handle for another close", async () => {
    const host = new PiSimHost(context(runDir()));
    const rpc = {
        child: { pid: 4242, stdin: { end: () => undefined } },
        shutdown: async () => {
            throw new Error("did not exit");
        },
    };
    (host as Untyped).rpc = rpc;
    (host as Untyped).stopTree = async () => {
        throw new Error("host tree 4242 survived SIGKILL");
    };
    await expect(host.closeSession()).rejects.toThrow(/survived SIGKILL/);
    expect(host.hostPid()).toBe(4242);
});

test("an OpenCode session whose shutdown is unconfirmed keeps its handle for another close", async () => {
    const host = new OpencodeSimHost({ ...context(runDir()), host: "opencode" });
    const oc = {
        port: 1,
        kill: async () => {
            throw new Error("did not exit");
        },
    };
    (host as Untyped).oc = oc;
    (host as Untyped).launched = { pid: 4242, start: "1" };
    (host as Untyped).stopTree = async () => {
        throw new Error("host tree 4242 survived SIGKILL");
    };
    await expect(host.closeSession()).rejects.toThrow(/survived SIGKILL/);
    expect((host as Untyped).oc).toBe(oc);
});

test("a standalone node keeps its own directory read-only, not the filesystem root", () => {
    const run = runDir();
    mkdirSync(join(run, "opt"));
    writeFileSync(join(run, "opt/node"), "", { mode: 0o755 });
    expect(nodeInstall(join(run, "opt/node")).root).toBe(join(run, "opt"));
    mkdirSync(join(run, "install/bin"), { recursive: true });
    writeFileSync(join(run, "install/bin/node"), "", { mode: 0o755 });
    expect(nodeInstall(join(run, "install/bin/node")).root).toBe(join(run, "install"));
});

test("a control tree whose base is a symlink is refused before anything is created", () => {
    const run = runDir();
    const elsewhere = join(run, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(run, "arm-link"));
    const ctx = { ...context(run), root: join(run, "arm-link") };
    const host = new PiSimHost(ctx);
    expect(() => (host as Untyped).writeConfigs(null)).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
});
