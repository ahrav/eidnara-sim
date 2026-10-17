import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { type HostContext, OpencodeSimHost, PiSimHost, toolCommand } from "./arms";

test("a tool run reads as its bash command, or as the tool and its target path", () => {
    expect(toolCommand("bash", { command: "cargo test" })).toBe("cargo test");
    expect(toolCommand("read", { path: "src/db.rs" })).toBe("read src/db.rs");
    expect(toolCommand("edit", { filePath: "src/x.ts" })).toBe("edit src/x.ts");
    expect(toolCommand("eidnara_search", { query: "cap" })).toBe('eidnara_search {"query":"cap"}');
});

test("a structured write or edit keeps the content it wrote under its target path", () => {
    expect(
        toolCommand("write", { path: "src/cache.ts", content: "const cache = new Map();\n" }),
    ).toBe("write src/cache.ts\nconst cache = new Map();\n");
    const edits = [{ oldText: "let a", newText: "static A: Mutex<u8>" }];
    expect(toolCommand("edit", { path: "src/x.rs", edits })).toBe(
        `edit src/x.rs\n${JSON.stringify(edits)}`,
    );
    expect(toolCommand("read", { path: "src/db.rs", offset: 10, limit: 20 })).toBe(
        "read src/db.rs limit=20 offset=10",
    );
    expect(toolCommand("read", { path: "src/db.rs", offset: 200 })).not.toBe(
        toolCommand("read", { path: "src/db.rs", offset: 10 }),
    );
});

test("an OpenCode turn logs only its own messages' tools, timed in OpenCode's clock from the turn's first message", async () => {
    const fakeNow = 9_000_000_000;
    const old = {
        info: { id: "m1", time: { created: fakeNow - 50_000 } },
        parts: [
            {
                type: "tool",
                tool: "bash",
                state: {
                    input: { command: "ls" },
                    status: "completed",
                    time: { start: fakeNow - 49_000 },
                },
            },
        ],
    };
    const fresh = {
        info: { id: "m2", time: { created: fakeNow } },
        parts: [
            {
                type: "tool",
                tool: "bash",
                state: {
                    input: { command: "cargo test" },
                    status: "error",
                    time: { start: fakeNow + 2_000 },
                },
            },
        ],
    };
    let calls = 0;
    const client = {
        session: {
            messages: async () => ({ data: calls++ === 0 ? [old] : [old, fresh] }),
            prompt: async () => ({ data: { info: {} } }),
            abort: async () => ({}),
        },
    };
    const reported: unknown[] = [];
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
        onTool: (run) => void reported.push(run),
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    expect(await host.prompt("go", 5_000)).toEqual({});
    expect(reported).toEqual([{ command: "cargo test", exit: 1, scenario_ms: 2_100 }]);
    expect(host.drainTools()).toEqual([{ command: "cargo test", exit: 1, scenario_ms: 2_100 }]);
});

function failingTurn(mode: "result-error" | "rejected" | "deadline", listing = true) {
    const fakeNow = 9_000_000_000;
    const tool = (command: string, status: string, start: number) => ({
        type: "tool",
        tool: "bash",
        state: { input: { command }, status, time: { start } },
    });
    const fresh = {
        info: { id: "m2", time: { created: fakeNow } },
        parts: [
            tool("cargo build", "error", fakeNow + 1_000),
            tool("cargo test", "running", fakeNow + 3_000),
        ],
    };
    let listed = 0;
    let release: (value: unknown) => void = () => undefined;
    const client = {
        session: {
            messages: async () => {
                if (listed++ > 0 && !listing) throw new Error("serve gone");
                return { data: listed === 1 ? [] : [fresh] };
            },
            prompt: () => {
                if (mode === "result-error") return Promise.resolve({ error: { name: "Bad" } });
                if (mode === "rejected") return Promise.reject(new Error("socket closed"));
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
            abort: async () => {
                release({ data: { info: {} } });
                return {};
            },
        },
    };
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    return host;
}

for (const mode of ["result-error", "rejected", "deadline"] as const) {
    test(`an OpenCode turn that ends ${mode} still logs its tool runs, unfinished ones with a null exit`, async () => {
        const host = failingTurn(mode);
        expect((await host.prompt("go", 50)).error).toBeString();
        expect(host.drainTools()).toEqual([
            { command: "cargo build", exit: 1, scenario_ms: 1_100 },
            { command: "cargo test", exit: null, scenario_ms: 3_100 },
        ]);
    });
}

test("a failed OpenCode turn whose messages cannot be listed keeps its error and names the gap", async () => {
    const result = await failingTurn("rejected", false).prompt("go", 50);
    expect(result.error).toContain("socket closed");
    expect(result.error).toContain("tool capture: Error: serve gone");
});

test("a message listing that returns an error instead of data is a capture failure, not an empty turn", async () => {
    let listed = 0;
    const client = {
        session: {
            messages: async () =>
                listed++ === 0
                    ? { data: [] }
                    : { error: { name: "Unauthorized" }, data: undefined },
            prompt: async () => ({ data: { info: {} } }),
            abort: async () => ({}),
        },
    };
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    const result = await host.prompt("go", 5_000);
    expect(result.error).toContain("tool capture");
    expect(result.error).toContain("Unauthorized");
    expect(host.drainTools()).toEqual([]);
});

test("a message listing that stalls past the turn deadline fails the turn as a capture gap", async () => {
    let listed = 0;
    const client = {
        session: {
            messages: () =>
                listed++ === 0 ? Promise.resolve({ data: [] }) : new Promise(() => undefined),
            prompt: async () => ({ data: { info: {} } }),
            abort: async () => ({}),
        },
    };
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    const started = Date.now();
    const result = await host.prompt("go", 1_200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.error).toContain("session.messages timed out");
});

test("a Pi tool run is timed from its start event, and an unfinished one keeps its start time", () => {
    let now = 10;
    const reported: unknown[] = [];
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => now,
        onTool: (run) => void reported.push(run),
    });
    const event = (e: Record<string, unknown>) =>
        (host as unknown as { toolEvent: (e: unknown) => void }).toolEvent(e);
    event({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "cargo test" },
    });
    event({
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "bash",
        args: { command: "sleep 9" },
    });
    now = 50;
    event({ type: "tool_execution_end", toolCallId: "t1", isError: false });
    now = 70;
    expect(host.drainTools()).toEqual([
        { command: "cargo test", exit: 0, scenario_ms: 10, call: "t1" },
        { command: "sleep 9", exit: null, scenario_ms: 10, call: "t2" },
    ]);
    expect(reported).toEqual([
        { command: "cargo test", exit: null, scenario_ms: 10, call: "t1" },
        { command: "sleep 9", exit: null, scenario_ms: 10, call: "t2" },
        { command: "cargo test", exit: 0, scenario_ms: 10, call: "t1" },
        { command: "sleep 9", exit: null, scenario_ms: 10, call: "t2" },
    ]);
});

test("reattaching to an OpenCode session reports the tool parts its messages already hold", async () => {
    const reported: unknown[] = [];
    const part = {
        type: "tool",
        id: "prt-1",
        tool: "bash",
        state: { input: { command: "cargo build" }, status: "completed", time: { start: 5 } },
    };
    const client = {
        session: {
            messages: async () => ({
                data: [{ info: { id: "m1", time: { created: 1 } }, parts: [part] }],
            }),
            prompt: async () => ({ data: { info: {} } }),
            abort: async () => ({}),
        },
    };
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 700,
        onTool: (run) => void reported.push(run),
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    await host.recoverTools(1_000);
    expect(reported).toEqual([
        { command: "cargo build", exit: 0, scenario_ms: 700, call: "oc:prt-1" },
    ]);
});

test("a Pi turn whose abort never drains kills the Pi process, and later prompts in the session fail fast", async () => {
    const reported: unknown[] = [];
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
        onTool: (run) => void reported.push(run),
    });
    const stopped: number[] = [];
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: async (name: string) => {
            if (name === "prompt") throw new Error("Timed out after 100ms");
            return {};
        },
        waitForEvent: (_match: unknown, o: { timeoutMs: number }) =>
            new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error("agent_end timed out")), o.timeoutMs),
            ),
        shutdown: async () => {},
        onEvent: () => {},
    };
    Object.assign(host as unknown as Record<string, unknown>, {
        rpc,
        stopTree: async (pid: number) => void stopped.push(pid),
        drainWaitMs: 10,
    });
    const first = await host.prompt("go", 100);
    expect(first.error).toContain("Timed out");
    expect(first.error).toContain("Pi process killed");
    expect(stopped).toEqual([4242]);
    const second = await host.prompt("again", 100);
    expect(second.error).toContain("killed after an undrained abort");
    expect(reported).toEqual([]);
});

test("a prompt that fails after its agent_end already arrived drains at once and keeps the Pi process", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
    });
    const stopped: number[] = [];
    let waits = 0;
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: async (name: string) => {
            if (name === "prompt") throw new Error("prompt rejected after the turn ended");
            return {};
        },
        waitForEvent: (_match: unknown, o: { timeoutMs: number }) => {
            waits += 1;
            if (waits === 1) return Promise.resolve({ type: "agent_end", messages: [] });
            return new Promise((_resolve, reject) =>
                setTimeout(() => reject(new Error("agent_end timed out")), o.timeoutMs),
            );
        },
        shutdown: async () => {},
        onEvent: () => {},
    };
    Object.assign(host as unknown as Record<string, unknown>, {
        rpc,
        stopTree: async (pid: number) => void stopped.push(pid),
        drainWaitMs: 10,
    });
    const result = await host.prompt("go", 100);
    expect(result.error).toContain("prompt rejected");
    expect(result.error).not.toContain("killed");
    expect(stopped).toEqual([]);
});

test("a timed-out prompt whose abort drains keeps the Pi process even though the first waiter expired", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
    });
    const stopped: number[] = [];
    let waits = 0;
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: async (name: string) => {
            if (name === "prompt") {
                await Bun.sleep(30);
                throw new Error("Timed out after 20ms");
            }
            return {};
        },
        waitForEvent: (_match: unknown, o: { timeoutMs: number }) => {
            waits += 1;
            if (waits === 1) {
                return new Promise((_resolve, reject) =>
                    setTimeout(() => reject(new Error("agent_end timed out")), o.timeoutMs),
                );
            }
            return new Promise((resolve) => setTimeout(() => resolve({ type: "agent_end" }), 5));
        },
        shutdown: async () => {},
        onEvent: () => {},
    };
    Object.assign(host as unknown as Record<string, unknown>, {
        rpc,
        stopTree: async (pid: number) => void stopped.push(pid),
        drainWaitMs: 200,
    });
    const result = await host.prompt("go", 20);
    expect(result.error).toContain("Timed out");
    expect(result.error).not.toContain("killed");
    expect(stopped).toEqual([]);
});

function opencodeHost(client: Record<string, unknown>): OpencodeSimHost {
    const host = new OpencodeSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    return host;
}

test("an OpenCode interrupt counts only when the abort landed; a turn that ran to its end is reported as it ended", async () => {
    const messages = async () => ({ data: [] });
    const slow = () => Bun.sleep(300).then(() => ({ data: { info: {} } }));
    const refused = opencodeHost({
        session: { messages, prompt: slow, abort: async () => ({ error: { message: "no" } }) },
    });
    expect(await refused.prompt("go", 5_000, 50)).toEqual({});
    const rejected = opencodeHost({
        session: {
            messages,
            prompt: slow,
            abort: async () => {
                throw new Error("connection reset");
            },
        },
    });
    expect(await rejected.prompt("go", 5_000, 50)).toEqual({});
    const aborted = opencodeHost({
        session: { messages, prompt: slow, abort: async () => ({ data: true }) },
    });
    expect(await aborted.prompt("go", 5_000, 50)).toEqual({ interrupted: true });
});

test("an OpenCode turn whose abort was refused runs on under its own deadline", async () => {
    const host = opencodeHost({
        session: {
            messages: async () => ({ data: [] }),
            prompt: () => Bun.sleep(400).then(() => ({ data: { info: {} } })),
            abort: async () => ({ data: false }),
        },
    });
    Object.assign(host as unknown as Record<string, unknown>, { drainWaitMs: 50 });
    expect(await host.prompt("go", 5_000, 50)).toEqual({});
});

test("an OpenCode abort wait counts against the turn's own deadline", async () => {
    const host = opencodeHost({
        session: {
            messages: async () => ({ data: [] }),
            prompt: () => Bun.sleep(600).then(() => ({ data: { info: {} } })),
            abort: () => new Promise(() => {}),
        },
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        abortWaitMs: 300,
        drainWaitMs: 1_000,
    });
    const result = await host.prompt("go", 400, 50);
    expect(result.error).toContain("turn deadline 400 ms");
});

test("an OpenCode abort that answers after its wait but stopped the prompt still counts as the interrupt", async () => {
    const host = opencodeHost({
        session: {
            messages: async () => ({ data: [] }),
            prompt: () => Bun.sleep(5_300).then(() => ({ data: { info: {} } })),
            abort: () => Bun.sleep(5_200).then(() => ({ data: true })),
        },
    });
    Object.assign(host as unknown as Record<string, unknown>, { abortWaitMs: 50 });
    expect(await host.prompt("go", 20_000, 50)).toEqual({ interrupted: true });
}, 15_000);

test("an abort request still open when the turn settles is cancelled before the next prompt", async () => {
    let signal: AbortSignal | undefined;
    const host = opencodeHost({
        session: {
            messages: async () => ({ data: [] }),
            prompt: () => Bun.sleep(300).then(() => ({ data: { info: {} } })),
            abort: (o: { signal?: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    signal = o.signal;
                    o.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
                }),
        },
    });
    Object.assign(host as unknown as Record<string, unknown>, { abortWaitMs: 50 });
    expect(await host.prompt("go", 5_000, 50)).toEqual({});
    expect(signal?.aborted).toBe(true);
});

test("a deadline abort still open when the drained turn settles is cancelled too", async () => {
    let signal: AbortSignal | undefined;
    const host = opencodeHost({
        session: {
            messages: async () => ({ data: [] }),
            prompt: () => Bun.sleep(250).then(() => ({ data: { info: {} } })),
            abort: (o: { signal?: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    signal = o.signal;
                    o.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
                }),
        },
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        abortWaitMs: 50,
        drainWaitMs: 1_000,
    });
    const result = await host.prompt("go", 100);
    expect(result.error).toContain("turn deadline 100 ms");
    expect(signal?.aborted).toBe(true);
});

test("an aborted OpenCode turn whose tool listing then fails keeps the interrupt beside the capture error", async () => {
    let listings = 0;
    const host = opencodeHost({
        session: {
            messages: async () => {
                if (listings++ === 0) return { data: [] };
                throw new Error("listing stalled");
            },
            prompt: () => Bun.sleep(300).then(() => ({ data: { info: {} } })),
            abort: async () => ({ data: true }),
        },
    });
    const result = await host.prompt("go", 5_000, 50);
    expect(result.interrupted).toBe(true);
    expect(result.error).toStartWith("tool capture:");
});

test("a Pi abort that fails after the agent already finished keeps the agent's own ending", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 100,
    });
    const end = Bun.sleep(100).then(() => ({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
    }));
    let waiters = 0;
    const stopped: number[] = [];
    const rpc = {
        child: { pid: 7, stdin: { end: () => {} } },
        sendCommand: async (name: string) => {
            if (name === "abort") throw new Error("Timed out after 60000ms");
            return { success: true };
        },
        waitForEvent: () => (waiters++ === 0 ? end : new Promise(() => {})),
        shutdown: async () => {},
    };
    Object.assign(host as unknown as Record<string, unknown>, {
        rpc,
        stopTree: async (pid: number) => void stopped.push(pid),
        drainWaitMs: 50,
    });
    expect(await host.prompt("go", 5_000, 50)).toEqual({});
    expect(stopped).toEqual([]);
});

test("a Pi interrupt counts only when the agent's last message was aborted", async () => {
    const run = (stopReason: string) => {
        const host = new PiSimHost({
            ...({} as HostContext),
            config: loadConfig(),
            root: "/x",
            launcher: "/x/sandbox.sh",
            now: () => 100,
        });
        const end = Bun.sleep(300).then(() => ({
            type: "agent_end",
            messages: [{ role: "assistant", stopReason }],
        }));
        const rpc = {
            sendCommand: async () => ({ success: true }),
            waitForEvent: () => end,
        };
        Object.assign(host as unknown as Record<string, unknown>, { rpc });
        return host.prompt("go", 5_000, 50);
    };
    expect(await run("stop")).toEqual({});
    expect(await run("aborted")).toEqual({ interrupted: true });
});
