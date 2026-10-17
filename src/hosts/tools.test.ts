import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import {
    type HostContext,
    OpencodeSimHost,
    PiSimHost,
    type PromptResult,
    toolCommand,
} from "./arms";

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

test("a slow pre-turn listing leaves the turn only the remaining deadline", async () => {
    let listed = 0;
    let turnDeadline = -1;
    const client = {
        session: {
            messages: async () => {
                if (listed++ === 0) await Bun.sleep(600);
                return { data: [] };
            },
            prompt: () => new Promise(() => undefined),
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
    const original = (host as unknown as { turn: (t: string, ms: number) => Promise<PromptResult> })
        .turn;
    (host as unknown as { turn: (t: string, ms: number) => Promise<PromptResult> }).turn = async (
        _text,
        ms,
    ) => {
        turnDeadline = ms;
        return { error: "turn deadline" };
    };
    void original;
    await host.prompt("go", 1_600);
    expect(turnDeadline).toBeGreaterThanOrEqual(1_000);
    expect(turnDeadline).toBeLessThan(1_100);
});

test("a timed-out message listing aborts its request", async () => {
    let signal: AbortSignal | undefined;
    const client = {
        session: {
            messages: (o: { signal?: AbortSignal }) => {
                signal = o.signal;
                return new Promise(() => undefined);
            },
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
    const result = await host.prompt("go", 1_000);
    expect(result.error).toContain("timed out");
    expect(signal?.aborted).toBe(true);
});

test("tool parts a failed post-turn listing missed are reported before the next turn", async () => {
    const reported: unknown[] = [];
    const part = (id: string, command: string) => ({
        type: "tool",
        id,
        tool: "bash",
        state: { input: { command }, status: "completed", time: { start: 5 } },
    });
    const m1 = { info: { id: "m1", time: { created: 1 } }, parts: [part("p1", "cargo build")] };
    let listings = 0;
    const client = {
        session: {
            messages: async () => {
                listings++;
                if (listings === 1) return { data: [] };
                if (listings === 2) throw new Error("serve gone");
                return { data: [m1] };
            },
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
        onTool: (run) => void reported.push(run),
    });
    Object.assign(host as unknown as Record<string, unknown>, {
        client,
        sid: "s",
        oc: { stderr: () => "" },
    });
    expect((await host.prompt("first", 1_000)).error).toContain("tool capture");
    expect(reported).toEqual([]);
    await host.prompt("second", 1_000);
    expect(reported).toEqual([
        { command: "cargo build", exit: 0, scenario_ms: 100, call: "oc:p1" },
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

test("an agent_end emitted in the same tick as the prompt failure still settles the drain", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
    });
    const stopped: number[] = [];
    let endResolve: ((v: unknown) => void) | null = null;
    let waits = 0;
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: (name: string) => {
            if (name !== "prompt") return Promise.resolve({});
            return new Promise((_resolve, reject) => {
                setTimeout(() => {
                    reject(new Error("prompt failed"));
                    endResolve?.({ type: "agent_end" });
                }, 5);
            });
        },
        waitForEvent: (_match: unknown, o: { timeoutMs: number }) => {
            waits += 1;
            if (waits === 1) return new Promise((resolve) => void (endResolve = resolve));
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
        drainWaitMs: 50,
    });
    const result = await host.prompt("go", 1_000);
    expect(result.error).toContain("prompt failed");
    expect(result.error).not.toContain("killed");
    expect(stopped).toEqual([]);
});

test("a stalled abort RPC does not delay the drain verdict past the drain wait", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
    });
    const stopped: number[] = [];
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: (name: string) => {
            if (name === "prompt") return Promise.reject(new Error("Timed out after 100ms"));
            return new Promise(() => {});
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
        drainWaitMs: 50,
    });
    const started = Date.now();
    const result = await host.prompt("go", 100);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.error).toContain("killed");
    expect(stopped).toEqual([4242]);
});

test("an agent_end arriving in the tick after the first waiter expired still settles the drain", async () => {
    const host = new PiSimHost({
        ...({} as HostContext),
        config: loadConfig(),
        root: "/x",
        launcher: "/x/sandbox.sh",
        now: () => 1,
    });
    const stopped: number[] = [];
    const waiters: Array<(v: unknown) => void> = [];
    const rpc = {
        child: { pid: 4242, stdin: { end: () => {} } },
        sendCommand: (name: string) => {
            if (name !== "prompt") return Promise.resolve({});
            return new Promise((_resolve, reject) => {
                setTimeout(() => {
                    reject(new Error("Timed out after 20ms"));
                    setTimeout(() => {
                        for (const w of waiters.splice(0)) w({ type: "agent_end" });
                    }, 0);
                }, 20);
            });
        },
        waitForEvent: (_match: unknown, o: { timeoutMs: number }) =>
            new Promise((resolve, reject) => {
                waiters.push(resolve);
                setTimeout(() => reject(new Error("agent_end timed out")), o.timeoutMs);
            }),
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
