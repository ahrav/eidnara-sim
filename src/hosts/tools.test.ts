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
            abort: async () => ({ data: true }),
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
                return { data: true };
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
            abort: async () => ({ data: true }),
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
            abort: async () => ({ data: true }),
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
            abort: async () => ({ data: true }),
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

test("a slow pre-turn listing leaves the turn the remaining deadline minus the listing reserve", async () => {
    let listed = 0;
    let turnDeadline = -1;
    const client = {
        session: {
            messages: async () => {
                if (listed++ === 0) await Bun.sleep(600);
                return { data: [] };
            },
            prompt: () => new Promise(() => undefined),
            abort: async () => ({ data: true }),
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
    expect(turnDeadline).toBeGreaterThanOrEqual(500);
    expect(turnDeadline).toBeLessThan(700);
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
            abort: async () => ({ data: true }),
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
            abort: async () => ({ data: true }),
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

test("a turn whose listing used its deadline fails without prompting", async () => {
    let prompted = 0;
    const client = {
        session: {
            messages: async () => {
                await Bun.sleep(90);
                return { data: [] };
            },
            prompt: async () => {
                prompted++;
                return { data: { info: {} } };
            },
            abort: async () => ({ data: true }),
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
    const result = await host.prompt("go", 100);
    expect(result.error).toBe("turn deadline of 100 ms passed during the message listing");
    expect(prompted).toBe(0);
});

test("an OpenCode turn whose last assistant step has not finished is a failed turn", async () => {
    const step = (finish?: string) => ({
        info: { id: "m", role: "assistant", finish },
        parts: [],
    });
    const early = (finish?: string) => ({
        error: `the turn returned before its last assistant step finished (${finish})`,
    });
    for (const [finish, want] of [
        ["stop", {}],
        ["tool-calls", early("tool-calls")],
        [undefined, early(undefined)],
    ] as const) {
        const client = {
            session: {
                messages: async () => ({ data: [step(finish)] }),
                prompt: async () => ({ data: { info: {} } }),
                abort: async () => ({ data: true }),
            },
        };
        const host = new OpencodeSimHost({
            ...({} as HostContext),
            config: loadConfig(),
            root: "/x",
            launcher: "/x/sandbox.sh",
            now: () => 0,
        });
        Object.assign(host as unknown as Record<string, unknown>, { client, sid: "s", oc: {} });
        expect(await host.prompt("go", 5_000)).toEqual(want);
    }
});
