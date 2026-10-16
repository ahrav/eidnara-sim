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
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { running } from "../run/procs";
import { DaemonStack, type HostContext, OpencodeSimHost, PiSimHost } from "./arms";

type Untyped = any;

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function context(run: string): HostContext {
    const root = join(run, "arm");
    mkdirSync(root);
    return {
        config: loadConfig(),
        arm: "host",
        host: "pi",
        root,
        launcher: join(run, "sandbox.sh"),
        offsetFile: join(run, "offset"),
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
        return Promise.reject(new Error("get_state failed"));
    }
    shutdown() { return Promise.resolve(); }
}
`,
    );
    writeFileSync(
        join(e2e, "src/opencode-runner/spawn.ts"),
        `export async function spawnOpencode() {
    const child = Bun.spawn(["/bin/sh", "-c", "sleep 300; exit 0", "sh", "serve", "${PORT}"]);
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
    let served = 0;
    return {
        commands,
        sendCommand(method: string): Promise<Untyped> {
            commands.push(method);
            if (method === "prompt" && opts.promptFails) return Promise.reject(new Error("boom"));
            return Promise.resolve({ success: true });
        },
        waitForEvent(predicate: (e: Untyped) => boolean, o: { timeoutMs: number }) {
            const stillRunning = commands.includes("abort") && opts.drainEnds === false;
            if (stillRunning) return Promise.reject(new Error(`timeout ${o.timeoutMs}`));
            for (; served < opts.ends.length; served++) {
                const event = opts.ends[served];
                if (predicate(event)) {
                    served++;
                    return Promise.resolve(event);
                }
            }
            return Promise.reject(new Error(`no agent_end within ${o.timeoutMs}`));
        },
    };
}

test("a Pi turn waits through an agent_end that Pi will retry", async () => {
    const host = new PiSimHost(context(runDir()));
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
    const host = new PiSimHost(context(runDir()));
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
    const host = new PiSimHost(context(runDir()));
    const rpc = fakeRpc({ promptFails: true, ends: [], drainEnds: false });
    (host as Untyped).rpc = rpc;
    await expect(host.prompt("hi", 1_000)).rejects.toThrow(/agent_end/);
    expect(rpc.commands).toEqual(["prompt", "abort"]);
});

test("stopping the daemon stack terminates the daemon even when the log cannot be appended", async () => {
    const run = runDir();
    let terminated = false;
    const stack = new DaemonStack({
        config: loadConfig(),
        root: run,
        dataDir: join(run, "data"),
        logFile: join(run, "missing-dir", "daemon.log"),
        offsetFile: join(run, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    (stack as Untyped).stack = {
        hostLog: () => "log",
        terminateHost: async () => {
            terminated = true;
        },
    };
    await expect(stack.stop()).rejects.toThrow(/ENOENT/);
    expect(terminated).toBe(true);
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

test("the OpenCode wrapper lives outside every path the sandbox keeps writable", async () => {
    const ctx = { ...context(runDir()), host: "opencode" as const };
    const host = new OpencodeSimHost(ctx);
    const path = (host as Untyped).writeWrapper(["/x/sandbox.sh", "--", "/x/opencode"]) as string;
    for (const kept of ctx.keep) expect(path.startsWith(`${kept}/`)).toBe(false);
    expect(await Bun.file(path).text()).toBe(
        `#!/bin/sh\nexec '/x/sandbox.sh' '--' '/x/opencode' "$@"\n`,
    );
});

test("a Pi session whose readiness check fails stops the launcher tree it spawned", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = context(run);
    const config = { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout };
    const host = new PiSimHost({ ...ctx, config });
    const outcome = await host.openSession(run, "s1", null).then(
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
    const outcome = await host.openSession(run, "s1", null).then(
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

test("a Pi session whose readiness response is a refusal fails and stops the launcher tree", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = context(run);
    const config = { ...ctx.config, eidnara_checkout: checkout, pi_install: checkout };
    const host = new PiSimHost({ ...ctx, config });
    (globalThis as Untyped).__simGetState = "refuse";
    const opened = host.openSession(run, "s1", null).then(
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
    const outcome = await host.openSession(run, "s1", null).then(
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
    const host = new PiSimHost(context(runDir()));
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
    rmSync(join(root, "runtime"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(root, "runtime"));
    await stack(join(store, "d")).start();
    expect(existsSync(join(elsewhere, "runtime.json"))).toBe(false);
    expect(lstatSync(join(root, "runtime")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(root, "runtime/runtime.json"))).toBe(true);
});
