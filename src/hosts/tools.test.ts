import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { type HostContext, OpencodeSimHost, toolCommand } from "./arms";

test("a tool run reads as its bash command, or as the tool and its target path", () => {
    expect(toolCommand("bash", { command: "cargo test" })).toBe("cargo test");
    expect(toolCommand("read", { path: "src/db.rs" })).toBe("read src/db.rs");
    expect(toolCommand("edit", { filePath: "src/x.ts" })).toBe("edit src/x.ts");
    expect(toolCommand("eidnara_search", { query: "cap" })).toBe('eidnara_search {"query":"cap"}');
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
        info: { id: "m2", role: "assistant", finish: "stop", time: { created: fakeNow } },
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
    expect(await host.prompt("go", 5_000)).toEqual({});
    expect(host.drainTools()).toEqual([{ command: "cargo test", exit: 1, scenario_ms: 2_100 }]);
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
        let calls = 0;
        const client = {
            session: {
                messages: async () => ({ data: calls++ === 0 ? [] : [step(finish)] }),
                prompt: async () => ({ data: { info: {} } }),
                abort: async () => ({}),
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

test("an OpenCode turn that leaves no assistant message of its own is a failed turn", async () => {
    const prior = { info: { id: "m0", role: "assistant", finish: "stop" }, parts: [] };
    const client = {
        session: {
            messages: async () => ({ data: [prior] }),
            prompt: async () => ({ data: { info: {} } }),
            abort: async () => ({}),
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
    expect(await host.prompt("go", 5_000)).toEqual({
        error: "the turn returned without an assistant message of its own",
    });
});
