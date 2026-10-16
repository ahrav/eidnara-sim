import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
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
    sendCommand() { return Promise.reject(new Error("get_state failed")); }
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
    return { session: { list: async () => { throw new Error("list failed"); } } };
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
    await expect(host.openSession(run, "s1", null)).rejects.toThrow("get_state failed");
    const child = (globalThis as Untyped).__simPiChild;
    try {
        expect(await gone(child.pid)).toBe(true);
    } finally {
        child.kill("SIGKILL");
    }
});

test("an OpenCode session whose SDK setup fails stops the server it spawned", async () => {
    const run = runDir();
    const checkout = fakeV1(run);
    const ctx = { ...context(run), host: "opencode" as const };
    const config = { ...ctx.config, eidnara_checkout: checkout };
    const host = new OpencodeSimHost({ ...ctx, config });
    await expect(host.openSession(run, "s1", null)).rejects.toThrow("list failed");
    await Bun.sleep(200);
    const left = serving();
    for (const pid of left) process.kill(pid, "SIGKILL");
    expect(left).toEqual([]);
});
