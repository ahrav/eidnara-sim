import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { type HostContext, OpencodeSimHost, PiSimHost, toolCommand } from "./arms";

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
