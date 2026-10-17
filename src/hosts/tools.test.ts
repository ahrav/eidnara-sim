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
        "read src/db.rs",
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
