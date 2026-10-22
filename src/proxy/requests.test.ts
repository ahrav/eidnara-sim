import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rng } from "../rng";
import { Gateway, type Upstream } from "./gateway";
import { FaultInjector } from "./inject";
import { RecordWriter, recordProblems } from "./records";
import {
    partId,
    RequestStore,
    readRequestLines,
    readRequestParts,
    rebuildRequest,
    requestParts,
} from "./requests";

const echo: Upstream = {
    async converse() {
        return {
            json: {
                output: { message: { role: "assistant", content: [{ text: "ok" }] } },
                stopReason: "end_turn",
                usage: { inputTokens: 1, outputTokens: 1 },
            },
        };
    },
};

let gateways: Gateway[] = [];
afterEach(async () => {
    await Promise.all(gateways.map((g) => g.stop()));
    gateways = [];
});

const turn = (text: string) => ({ role: "user", content: [{ text }] });

test("a growing conversation stores each message once and rebuilds every body", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const store = new RequestStore(path);
    const system = [{ text: "You are a coding agent." }];
    const first = { system, messages: [turn("one")], inferenceConfig: { maxTokens: 9 } };
    const second = { ...first, messages: [turn("one"), turn("two")] };
    const a = store.store(first);
    const b = store.store(second);
    store.close();
    expect(readRequestLines(path)).toHaveLength(4);
    expect(b.parts.slice(0, 2)).toEqual(a.parts.slice(0, 2));
    const parts = readRequestParts(path);
    expect(rebuildRequest(a, parts)).toEqual(first);
    expect(rebuildRequest(b, parts)).toEqual(second);
    expect(b.bytes).toBe(Buffer.byteLength(JSON.stringify(second)));
    expect(rebuildRequest({ ...b, parts: [...b.parts, "0".repeat(32)] }, parts)).toBeNull();
});

test("a reopened store drops a cut line and writes no part twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const body = { system: [{ text: "s" }], messages: [turn("a")] };
    const first = new RequestStore(path);
    first.store(body);
    first.close();
    appendFileSync(path, '{"id":"');
    const again = new RequestStore(path);
    const ref = again.store({ ...body, messages: [turn("a"), turn("b")] });
    again.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(rebuildRequest(ref, readRequestParts(path))?.messages).toHaveLength(2);
    expect(requestParts(body).map(partId)).toEqual(ref.parts.slice(0, 2));
});

test("an append that fails part-way is cut back, so the log reopens whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const store = new RequestStore(path);
    store.store({ messages: [turn("a")] });
    const original = fs.writeSync;
    const spy = spyOn(fs, "writeSync").mockImplementationOnce(((
        fd: number,
        buf: Buffer,
        offset: number,
    ) => {
        (original as (...a: unknown[]) => number)(fd, buf, offset, 7);
        throw new Error("ENOSPC: no space left on device");
    }) as unknown as typeof fs.writeSync);
    try {
        expect(() => store.store({ messages: [turn("a"), turn("b")] })).toThrow(/ENOSPC/);
    } finally {
        spy.mockRestore();
    }
    const ref = store.store({ messages: [turn("a"), turn("b")] });
    store.close();
    expect(rebuildRequest(ref, readRequestParts(path))?.messages).toHaveLength(2);
    expect(() => new RequestStore(path).close()).not.toThrow();
});

test("a corrupt line in the log is refused rather than read as a part", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    writeFileSync(path, '{"id":"short","part":{}}\n');
    expect(() => new RequestStore(path)).toThrow(/not a request part/);
});

test("the record names the body the proxy forwarded, after the fields it removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const requests = new RequestStore(path);
    const records = new RecordWriter(null);
    const gateway = new Gateway({
        upstream: echo,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: "t" }),
        requests,
    });
    await gateway.start();
    gateways.push(gateway);
    const body = {
        system: [{ text: "You are a coding agent." }],
        messages: [turn("Fix the bug.")],
        toolConfig: { tools: [{ toolSpec: { name: "bash" } }] },
        inferenceConfig: { temperature: 0, maxTokens: 5 },
    };
    const model = "global.anthropic.claude-opus-5-5";
    const response = await fetch(`${gateway.urls[0]}/model/${model}/converse`, {
        method: "POST",
        body: JSON.stringify(body),
    });
    await response.text();
    await gateway.stop();
    requests.close();
    const [record] = records.records;
    expect(record?.request).toBeDefined();
    expect(recordProblems(record as object)).toEqual([]);
    const forwarded = rebuildRequest(
        record?.request as NonNullable<typeof record>["request"] & object,
        readRequestParts(path),
    );
    expect(forwarded?.inferenceConfig).toEqual({ maxTokens: 5 });
    expect(forwarded?.messages).toEqual(body.messages);
    expect(recordProblems({ ...record, request: { sha256: "x", bytes: 1, parts: [] } })).toEqual([
        "request invalid",
    ]);
});

test("a background call names its origin turn; an agent call keeps the turn in scope", async () => {
    const records = new RecordWriter(null);
    const gateway = new Gateway({
        upstream: echo,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: "e-2", origin: "e-1" }),
    });
    await gateway.start();
    gateways.push(gateway);
    const capture = {
        system: [{ text: "Extract durable project memory." }],
        messages: [turn('{"existing_memories": []}')],
    };
    const agent = { ...capture, toolConfig: { tools: [{ toolSpec: { name: "bash" } }] } };
    for (const body of [capture, agent]) {
        const r = await fetch(`${gateway.urls[0]}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        await r.text();
    }
    const [bg, fg] = records.records;
    expect(bg?.component).toBe("memory_capture");
    expect(bg?.turn).toBe("e-2");
    expect(bg?.origin_turn).toBe("e-1");
    expect(fg?.component).toBe("agent");
    expect(fg?.origin_turn).toBeUndefined();
});
