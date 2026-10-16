import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { DaemonStack, type HostContext, OpencodeSimHost, PiSimHost } from "./arms";

type Untyped = any;

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

const runDir = () => realpathSync(mkdtempSync(join(tmpdir(), "sim-arms-")));

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
