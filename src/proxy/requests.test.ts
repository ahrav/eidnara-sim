import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rng } from "../rng";
import type { ConverseBody } from "./classify";
import { Gateway, type Scope, type Upstream } from "./gateway";
import { FaultInjector } from "./inject";
import { CacheGaps, RecordWriter, recordProblems } from "./records";
import {
    bodyCachePoints,
    partId,
    placePiCachePoints,
    RequestPartLog,
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
    expect(rebuildRequest({ ...b, parts: [...b.parts].reverse() }, parts)).toBeNull();
    expect(rebuildRequest({ ...b, bytes: b.bytes + 1 }, parts)).toBeNull();
});

test("the on-demand part log rebuilds every body the whole-file read rebuilds, past its cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const store = new RequestStore(path);
    const system = [{ text: "You are a coding agent." }];
    // Each message is over 1 KiB, so a 16 KiB part cache evicts while the bodies are rebuilt.
    const big = (i: number) => turn(`${i}:${"x".repeat(1 << 10)}é`);
    const bodies: Array<{ system: typeof system; messages: ReturnType<typeof turn>[] }> = [];
    const refs = [];
    for (let i = 1; i <= 80; i++) {
        const body = { system, messages: Array.from({ length: i }, (_, j) => big(j)) };
        if (i % 20 === 0 || i === 1) {
            bodies.push(body);
            refs.push(store.store(body));
        } else {
            store.store({ system, messages: [big(i)] });
        }
    }
    store.close();
    appendFileSync(path, '{"id": "cut');
    const whole = readRequestParts(path);
    const log = new RequestPartLog(path, 16 << 10);
    try {
        expect(log.size).toBe(whole.size);
        refs.forEach((ref, i) => {
            expect(rebuildRequest(ref, log) as unknown).toEqual(bodies[i]);
            expect(rebuildRequest(ref, log)).toEqual(rebuildRequest(ref, whole));
        });
        expect(log.get("0".repeat(32))).toBeUndefined();
        expect(log.has(partId({ field: "system", value: system }))).toBe(true);
    } finally {
        log.close();
    }
    expect(() => log.get(partId({ field: "system", value: system }))).toThrow(/after close/);
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

test("equal parts in another key order keep their own bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const store = new RequestStore(path);
    const a = store.store({ messages: [{ role: "user", content: [{ text: "x" }] }] });
    const b = store.store({ messages: [{ content: [{ text: "x" }], role: "user" }] });
    store.close();
    const parts = readRequestParts(path);
    expect(rebuildRequest(a, parts)).not.toBeNull();
    expect(rebuildRequest(b, parts)).not.toBeNull();
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});

test("a corrupt line in the log is refused rather than read as a part", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    writeFileSync(path, '{"id":"short","part":{}}\n');
    expect(() => new RequestStore(path)).toThrow(/not a request part/);
    const part = { field: "system", value: [{ text: "a" }] };
    const other = partId({ field: "system", value: [{ text: "b" }] });
    writeFileSync(path, `${JSON.stringify({ id: other, part })}\n`);
    expect(() => readRequestParts(path)).toThrow(/does not match its part id/);
});

test("a body with no messages rebuilds to the same bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const store = new RequestStore(path);
    const body = { system: [{ text: "s" }], messages: [] };
    const ref = store.store(body);
    store.close();
    expect(rebuildRequest(ref, readRequestParts(path))).toEqual(body);
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

test("a background call between turns names the preceding turn", async () => {
    const records = new RecordWriter(null);
    const gateway = new Gateway({
        upstream: echo,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: null, origin: "e-1" }),
    });
    await gateway.start();
    gateways.push(gateway);
    const capture = {
        system: [{ text: "Extract durable project memory." }],
        messages: [turn('{"existing_memories": []}')],
    };
    const r = await fetch(`${gateway.urls[0]}/model/m/converse`, {
        method: "POST",
        body: JSON.stringify(capture),
    });
    await r.text();
    expect(records.records[0]).toMatchObject({ turn: null, origin_turn: "e-1" });
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

test("a reviewer request is recorded under its stage, its model, and the turn it follows", async () => {
    const bodies = JSON.parse(
        readFileSync(join(import.meta.dir, "../../tests/fixtures/reviewer/requests.json"), "utf8"),
    ) as Record<"stage1" | "stage2", ConverseBody>;
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const requests = new RequestStore(path);
    const records = new RecordWriter(null);
    const started: [string, number][] = [];
    const gateway = new Gateway({
        upstream: echo,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        // A reviewer pass that runs as the next turn begins follows the turn before it.
        scope: () => ({ arm: "a", session: "s", turn: "e-2", origin: "e-1" }),
        requests,
        // The system prompt's point alone, as a caching-on run places it on a `system` build.
        cachePoints: (body, component) =>
            component.startsWith("memory_reviewer_") ? placePiCachePoints(body, false) : 0,
        observe: (e) => {
            started.push([e.component, e.cache_points]);
        },
    });
    await gateway.start();
    gateways.push(gateway);
    const haiku = "global.anthropic.claude-haiku-5-5";
    const opus = "global.anthropic.claude-opus-5-5";
    for (const [model, body] of [
        [haiku, bodies.stage1],
        [opus, bodies.stage2],
    ] as const) {
        const response = await fetch(`${gateway.urls[0]}/model/${model}/converse`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        await response.text();
    }
    await gateway.stop();
    requests.close();
    expect(started).toEqual([
        ["memory_reviewer_stage1", 1],
        ["memory_reviewer_stage2", 1],
    ]);
    const [first, second] = records.records;
    expect(first).toMatchObject({
        component: "memory_reviewer_stage1",
        componentSource: "inferred",
        model: haiku,
        turn: "e-2",
        origin_turn: "e-1",
        cache_points_placed: 1,
    });
    expect(second).toMatchObject({
        component: "memory_reviewer_stage2",
        model: opus,
        origin_turn: "e-1",
        cache_points_placed: 1,
    });
    // The stored body is the host's with the one point after its system text.
    const point = { cachePoint: { type: "default" } };
    const parts = readRequestParts(path);
    for (const [record, sent] of [
        [first, bodies.stage1],
        [second, bodies.stage2],
    ] as const) {
        expect(rebuildRequest(record?.request as never, parts)).toEqual({
            ...sent,
            system: [...(sent.system ?? []), point],
        });
        expect(recordProblems(record as object)).toEqual([]);
    }
});

test("a reviewer request of a settle step names the ending session, no turn, and the session's last user turn", async () => {
    const bodies = JSON.parse(
        readFileSync(join(import.meta.dir, "../../tests/fixtures/reviewer/requests.json"), "utf8"),
    ) as Record<"stage1" | "stage2", ConverseBody>;
    const records = new RecordWriter(null);
    // The scope a run holds inside a `session_end` event: the ending session, no turn, and the
    // session's last user turn as the origin; a session without a user turn has no origin.
    let scope: Scope = { arm: "eidnara-reviewer", session: "s-0003", turn: null, origin: "e-41" };
    const gateway = new Gateway({
        upstream: echo,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => scope,
    });
    await gateway.start();
    gateways.push(gateway);
    const send = async (body: ConverseBody) => {
        const response = await fetch(`${gateway.urls[0]}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        await response.text();
    };
    await send(bodies.stage1);
    await send(bodies.stage2);
    scope = { ...scope, session: "s-0004", origin: null };
    await send(bodies.stage1);
    const drained = { arm: "eidnara-reviewer", session: "s-0003", turn: null, origin_turn: "e-41" };
    expect(records.records[0]).toMatchObject({ ...drained, component: "memory_reviewer_stage1" });
    expect(records.records[1]).toMatchObject({ ...drained, component: "memory_reviewer_stage2" });
    expect(records.records[2]).toMatchObject({ session: "s-0004", turn: null });
    expect(records.records[2]?.origin_turn).toBeUndefined();
});

test("a body with cache points is forwarded and stored whole, and a 1-hour write is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const requests = new RequestStore(path);
    const records = new RecordWriter(null);
    const point = { cachePoint: { type: "default" } };
    const usages = [
        { inputTokens: 4, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 900 },
        {
            inputTokens: 4,
            outputTokens: 1,
            cacheReadInputTokens: 900,
            cacheWriteInputTokens: 300,
            cacheDetails: [
                { ttl: "5m", inputTokens: 100 },
                { ttl: "1h", inputTokens: 200 },
            ],
        },
    ];
    const seen: unknown[] = [];
    const upstream: Upstream = {
        async converse(_model, body) {
            seen.push(JSON.parse(JSON.stringify(body)));
            const message = { role: "assistant", content: [{ text: "ok" }] };
            return { json: { output: { message }, stopReason: "end_turn", usage: usages.shift() } };
        },
    };
    const started: number[] = [];
    const gateway = new Gateway({
        upstream,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: "t" }),
        requests,
        observe: (e) => {
            started.push(e.cache_points);
        },
    });
    await gateway.start();
    gateways.push(gateway);
    const body = {
        system: [{ text: "You are a coding agent." }, point],
        messages: [{ role: "user", content: [{ text: "Fix the bug." }, point] }],
        toolConfig: { tools: [{ toolSpec: { name: "bash" } }] },
    };
    for (let i = 0; i < 2; i++) {
        const response = await fetch(`${gateway.urls[0]}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        await response.text();
    }
    await gateway.stop();
    requests.close();
    expect(seen).toEqual([body, body]);
    // Each call's start names the cache points of its body: one after the system prompt, one in the message.
    expect(started).toEqual([2, 2]);
    expect(bodyCachePoints({ ...body, system: [{ text: "s" }], messages: [turn("a")] })).toBe(0);
    const [first, second] = records.records;
    const parts = readRequestParts(path);
    expect(rebuildRequest(first?.request as never, parts)).toEqual(body);
    expect(first?.request?.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(first).toMatchObject({ input_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 900 });
    expect(first && "cache_write_1h_tokens" in first).toBe(false);
    expect(second).toMatchObject({
        cache_read_tokens: 900,
        cache_write_tokens: 300,
        cache_write_1h_tokens: 200,
    });
    expect(recordProblems(second as object)).toEqual([]);
    for (const cache_write_1h_tokens of [301, 0.5, 0]) {
        expect(recordProblems({ ...second, cache_write_1h_tokens })).toEqual([
            "cache_write_1h_tokens invalid",
        ]);
    }
});

test("a streamed answer's metadata gives the 1-hour writes, and the writes when it names no total", async () => {
    const usages = [
        {
            inputTokens: 4,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 300,
            cacheDetails: [
                { ttl: "5m", inputTokens: 100 },
                { ttl: "1h", inputTokens: 200 },
            ],
        },
        {
            inputTokens: 4,
            outputTokens: 1,
            cacheDetails: [
                { ttl: "5m", inputTokens: 50 },
                { ttl: "1h", inputTokens: 70 },
            ],
        },
    ];
    const upstream: Upstream = {
        async converse() {
            const usage = usages.shift();
            async function* events() {
                yield { messageStart: { role: "assistant" } };
                yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } };
                yield { messageStop: { stopReason: "end_turn" } };
                yield { metadata: { usage } };
            }
            return { events: events() };
        },
    };
    const records = new RecordWriter(null);
    const gateway = new Gateway({
        upstream,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: "t" }),
    });
    await gateway.start();
    gateways.push(gateway);
    for (let i = 0; i < 2; i++) {
        const response = await fetch(`${gateway.urls[0]}/model/m/converse-stream`, {
            method: "POST",
            body: JSON.stringify({ messages: [turn("hi")] }),
        });
        await response.arrayBuffer();
    }
    await gateway.stop();
    expect(records.records[0]).toMatchObject({
        cache_write_tokens: 300,
        cache_write_1h_tokens: 200,
    });
    expect(records.records[1]).toMatchObject({
        cache_write_tokens: 120,
        cache_write_1h_tokens: 70,
    });
});

const served = (
    arm: string,
    session: string,
    component: string,
    scenario_ms: number,
    started_wall_ms: number,
    first_byte_ms: number | null = 0,
) => ({
    arm,
    session,
    component: component as "agent",
    model: "m",
    scenario_ms,
    started_wall_ms,
    first_byte_ms,
    status: 200,
    cache_read_tokens: 0,
    cache_write_tokens: 100,
});

test("a call's cache gap runs from the last served call of its arm, component, model, and session", () => {
    const gaps = new CacheGaps();
    const first = served("host", "s-1", "agent", 1_000, 50_000);
    expect(gaps.of(first)).toEqual({ ttl_ms: 300_000, session: null });
    gaps.note(first);
    // Six scenario minutes later and two wall seconds later: the idle gap the wall clock skips.
    const next = served("host", "s-1", "agent", 361_000, 52_000);
    expect(gaps.of(next)).toEqual({
        ttl_ms: 300_000,
        session: { scenario_ms: 360_000, wall_ms: 2_000 },
    });
    gaps.note(next);
    // Another session, component, or arm extends another conversation, and the provider keeps
    // a cache per model, so each of these has no earlier call.
    for (const other of [
        served("host", "s-2", "agent", 400_000, 53_000),
        served("host", "s-1", "memory_capture", 400_000, 53_000),
        served("eidnara", "s-1", "agent", 400_000, 53_000),
        { ...served("host", "s-1", "agent", 400_000, 53_000), model: "n" },
    ]) {
        expect(gaps.of(other).session).toBeNull();
    }
    expect(gaps.of(served("host", "s-1", "agent", 400_000, 53_000)).session).toEqual({
        scenario_ms: 39_000,
        wall_ms: 1_000,
    });
});

test("a call's cache gaps run between answers, so a proxy retry's backoff falls on the call that waited", () => {
    const gaps = new CacheGaps();
    // Received at 0 and answered 90 s later, after the proxy's upstream retries.
    gaps.note(served("host", "s-1", "agent", 0, 10_000, 90_000));
    // Received 250 s after that receipt and answered 2 s later: 162 s after the earlier answer.
    const next = served("host", "s-1", "agent", 250_000, 260_000, 2_000);
    expect(gaps.of(next).session).toEqual({ scenario_ms: 162_000, wall_ms: 162_000 });
    gaps.note(next);
    // A call with no answer byte is measured from its receipt.
    expect(gaps.of(served("host", "s-1", "agent", 300_000, 310_000, null)).session).toEqual({
        scenario_ms: 48_000,
        wall_ms: 48_000,
    });
});

test("the gap's reference is one answer, the latest on the wall clock, whatever order the records come in", () => {
    const gaps = new CacheGaps();
    // A resumed run's scenario clock can restart behind an answer the log already holds: the
    // later call on the wall clock carries the earlier scenario time.
    gaps.note(served("host", "s-1", "agent", 500_000, 10_000));
    gaps.note(served("host", "s-1", "agent", 480_000, 20_000));
    gaps.note(served("host", "s-1", "agent", 490_000, 15_000));
    expect(gaps.of(served("host", "s-1", "agent", 485_000, 21_000)).session).toEqual({
        scenario_ms: 5_000,
        wall_ms: 1_000,
    });
});

test("a call the provider never served leaves the cache gaps as they were", () => {
    const gaps = new CacheGaps();
    gaps.note(served("host", "s-1", "agent", 1_000, 50_000));
    gaps.note({ ...served("host", "s-1", "agent", 2_000, 51_000), status: 429 });
    // An answer with no cache read or write left the provider's cache as it was.
    gaps.note({ ...served("host", "s-1", "agent", 3_000, 52_000), cache_write_tokens: 0 });
    const later = served("host", "s-1", "agent", 4_000, 53_000);
    expect(gaps.of(later).session).toEqual({ scenario_ms: 3_000, wall_ms: 3_000 });
    // A call received before the last served one overlapped it.
    expect(gaps.of(served("host", "s-1", "agent", 500, 49_000)).session).toEqual({
        scenario_ms: 0,
        wall_ms: 0,
    });
});

test("a writer with a gap tracker stamps each host call, and a resumed tracker continues from the log", () => {
    const record = (
        component: "agent" | "user-sim",
        scenario_ms: number,
        started_wall_ms: number,
    ) => ({
        arm: "host",
        session: "s-1",
        turn: null,
        component,
        componentSource: "inferred" as const,
        model: "m",
        status: 200,
        finish_reason: "end_turn",
        input_tokens: 4,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 100,
        started_wall_ms,
        scenario_ms,
        first_byte_ms: 1,
        proxy_retries: 0,
        fault_ref: null,
        error: null,
    });
    const writer = new RecordWriter(null, { cacheGaps: new CacheGaps() });
    const first = writer.write(record("agent", 1_000, 10_000));
    const harness = writer.write(record("user-sim", 2_000, 11_000));
    const second = writer.write(record("agent", 400_000, 12_000));
    // The first call has no earlier call to measure from; the gap is read before the call is noted.
    expect(first.cache_gap).toEqual({ ttl_ms: 300_000, session: null });
    expect(harness.cache_gap).toBeUndefined();
    expect(second.cache_gap?.session).toEqual({ scenario_ms: 399_000, wall_ms: 2_000 });
    expect(new RecordWriter(null).write(record("agent", 1, 1)).cache_gap).toBeUndefined();
    // A resume feeds the tracker the log's records, in any order, and continues from the latest.
    const resumed = new CacheGaps();
    for (const r of [second, harness, first]) resumed.note(r);
    const next = new RecordWriter(null, { cacheGaps: resumed }).write(
        record("agent", 401_000, 13_000),
    );
    expect(next.cache_gap?.session).toEqual({ scenario_ms: 1_000, wall_ms: 1_000 });
});

test("a record's cache gap is two gaps or nulls of non-negative times", () => {
    const base = new RecordWriter(null).write({
        arm: "a",
        session: "s",
        turn: null,
        component: "agent",
        componentSource: "inferred",
        model: "m",
        status: 200,
        finish_reason: "end_turn",
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        started_wall_ms: 1,
        scenario_ms: 1,
        first_byte_ms: 1,
        proxy_retries: 0,
        fault_ref: null,
        error: null,
        cache_gap: { ttl_ms: 300_000, session: { scenario_ms: 5, wall_ms: 1 } },
    });
    expect(recordProblems(base)).toEqual([]);
    expect(recordProblems({ ...base, cache_gap: { ttl_ms: 300_000, session: null } })).toEqual([]);
    const ttl_ms = 300_000;
    for (const cache_gap of [
        { ttl_ms },
        { session: null },
        { ttl_ms: 0, session: null },
        { ttl_ms, session: { scenario_ms: -1, wall_ms: 0 } },
        { ttl_ms, session: { scenario_ms: 1 } },
        "none",
    ]) {
        expect(recordProblems({ ...base, cache_gap })).toEqual(["cache_gap invalid"]);
    }
});

test("cache points the gateway is told to place reach the provider, the stored body, and the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-requests-"));
    const path = join(dir, "requests.jsonl");
    const requests = new RequestStore(path);
    const records = new RecordWriter(null);
    const seen: unknown[] = [];
    const started: number[] = [];
    const upstream: Upstream = {
        async converse(_model, body) {
            seen.push(JSON.parse(JSON.stringify(body)));
            return echo.converse("", body, false, new AbortController().signal);
        },
    };
    const gateway = new Gateway({
        upstream,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(1),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "a", session: "s", turn: "t" }),
        requests,
        // Places Pi's two points on the summarizer's body alone.
        cachePoints: (body, component) =>
            component === "history_summarizer" ? placePiCachePoints(body) : 0,
        observe: (e) => {
            started.push(e.cache_points);
        },
    });
    await gateway.start();
    gateways.push(gateway);
    const summarizer = {
        system: [{ text: "Summarize." }],
        messages: [turn("<new_messages>\n[1] U: hi\n</new_messages>")],
    };
    const agent = {
        system: [{ text: "You are a coding agent." }],
        messages: [turn("Fix the bug.")],
        toolConfig: { tools: [{ toolSpec: { name: "bash" } }] },
    };
    for (const body of [summarizer, agent]) {
        const response = await fetch(`${gateway.urls[0]}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        await response.text();
    }
    await gateway.stop();
    requests.close();
    const point = { cachePoint: { type: "default" } };
    const placed = {
        system: [{ text: "Summarize." }, point],
        messages: [
            {
                role: "user",
                content: [{ text: "<new_messages>\n[1] U: hi\n</new_messages>" }, point],
            },
        ],
    };
    expect(seen).toEqual([placed, agent]);
    expect(started).toEqual([2, 0]);
    const [first, second] = records.records;
    expect(first).toMatchObject({ component: "history_summarizer", cache_points_placed: 2 });
    expect(rebuildRequest(first?.request as never, readRequestParts(path))).toEqual(placed);
    expect(second?.component).toBe("agent");
    expect(second && "cache_points_placed" in second).toBe(false);
    expect(recordProblems(first as object)).toEqual([]);
    for (const cache_points_placed of [0, 1.5, -1]) {
        expect(recordProblems({ ...first, cache_points_placed })).toEqual([
            "cache_points_placed invalid",
        ]);
    }
});
