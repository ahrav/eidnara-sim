import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:http2";
import { decodeMessages } from "../../tests/eventstream-decode";
import { Rng } from "../rng";
import type { FaultType } from "../scenario/faults";
import { classify } from "./classify";
import { encodeEvent } from "./eventstream";
import { backoffMs, type CallStarted, Gateway, sendWithRetry, type Upstream } from "./gateway";
import { excludedFromFaultMetrics, FaultInjector, type ProxyFault } from "./inject";
import { type CallRecord, RecordWriter, recordProblems } from "./records";

/** A slow_stream fault delays each event by SLOW_DELAY_MS; the host classifies a status-200 answer as slow when any gap is at least SLOW_SEEN_MS. */
const SLOW_DELAY_MS = 100;
const SLOW_SEEN_MS = 70;
/** The host's 300 ms timeout expires before the provider_timeout fault's 2,000 ms timeout; other fault types get 2,000 ms. */
const HOST_TIMEOUT_MS = (type: FaultType) => (type === "provider_timeout" ? 300 : 2_000);

const AGENT_BODY = {
    system: [{ text: "You are a coding agent." }],
    messages: [{ role: "user", content: [{ text: "Fix the bug." }] }],
    toolConfig: { tools: [{ toolSpec: { name: "bash" } }] },
};
const SUMMARIZER_BODY = {
    system: [{ text: "Summarize." }],
    messages: [{ role: "user", content: [{ text: "<new_messages>\n[1] U: hi\n</new_messages>" }] }],
};

function scriptedUpstream(failures = 0): Upstream & { calls: number } {
    const up = {
        calls: 0,
        async converse(_m: string, _b: unknown, streaming: boolean) {
            up.calls++;
            if (up.calls <= failures) {
                throw Object.assign(new Error("slow down"), {
                    name: "ThrottlingException",
                    $metadata: { httpStatusCode: 429 },
                });
            }
            const usage = {
                inputTokens: 11,
                outputTokens: 7,
                cacheReadInputTokens: 5,
                cacheWriteInputTokens: 3,
            };
            if (!streaming) {
                const message = { role: "assistant", content: [{ text: "done" }] };
                return { json: { output: { message }, stopReason: "end_turn", usage } };
            }
            async function* events() {
                yield { messageStart: { role: "assistant" } };
                yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "done" } } };
                yield { contentBlockStop: { contentBlockIndex: 0 } };
                yield { messageStop: { stopReason: "end_turn" } };
                yield { metadata: { usage, metrics: { latencyMs: 3 } } };
            }
            return { events: events() };
        },
    };
    return up;
}

interface HostResult {
    status: number;
    events: { type: string; member: Record<string, unknown> }[];
    gaps: number[];
    timedOut: boolean;
}

async function hostCall(
    url: string,
    body: unknown,
    timeoutMs: number,
    header?: string,
): Promise<HostResult> {
    const result: HostResult = { status: 0, events: [], gaps: [], timedOut: false };
    try {
        const response = await fetch(`${url}/model/m/converse-stream`, {
            method: "POST",
            body: JSON.stringify(body),
            headers: header ? { "x-sim-component": header } : {},
            signal: AbortSignal.timeout(timeoutMs),
            keepalive: false,
        });
        result.status = response.status;
        const reader = response.body?.getReader();
        let buffer = Buffer.alloc(0);
        let last = performance.now();
        while (reader) {
            const { value, done } = await reader.read();
            if (done) break;
            const now = performance.now();
            result.gaps.push(now - last);
            last = now;
            buffer = Buffer.concat([buffer, Buffer.from(value)]);
        }
        if (response.status === 200) {
            for (const m of decodeMessages(buffer)) {
                const type = m.headers[":event-type"] ?? "";
                result.events.push({ type, member: JSON.parse(m.payload.toString("utf8")) });
            }
        }
    } catch {
        result.timedOut = true;
    }
    return result;
}

function hostSees(type: FaultType, r: HostResult): boolean {
    const stopReason = r.events.find((e) => e.type === "messageStop")?.member.stopReason;
    const has = (t: string) => r.events.some((e) => e.type === t);
    switch (type) {
        case "provider_429":
            return r.status === 429;
        case "provider_5xx":
            return r.status >= 500;
        case "provider_timeout":
            return r.timedOut;
        case "truncated_length":
            return stopReason === "max_tokens";
        case "truncated_no_length":
            return r.status === 200 && has("contentBlockDelta") && !has("messageStop");
        case "empty_content":
            return stopReason === "end_turn" && !has("contentBlockDelta");
        case "schema_wrong_tool_call": {
            const input = r.events.find((e) => e.type === "contentBlockDelta")?.member.delta as
                | { toolUse?: { input?: string } }
                | undefined;
            const raw = input?.toolUse?.input ?? "";
            try {
                JSON.parse(raw);
                return false;
            } catch {
                return raw.length > 0;
            }
        }
        case "slow_stream":
            return r.status === 200 && Math.max(...r.gaps) >= SLOW_SEEN_MS;
        default:
            return false;
    }
}

const PROVIDER_TYPES: FaultType[] = [
    "provider_429",
    "provider_5xx",
    "provider_timeout",
    "truncated_length",
    "truncated_no_length",
    "empty_content",
    "schema_wrong_tool_call",
    "slow_stream",
];
const STRATEGIES = {
    single: { count: 1 },
    burst: { count: 3 },
    intermittent: { probability: 0.3, calls: 10 },
    persistent: {},
} as const;

let gateways: Gateway[] = [];
afterEach(async () => {
    await Promise.all(gateways.map((g) => g.stop()));
    gateways = [];
});

async function start(
    fault: ProxyFault | null,
    upstream: Upstream = scriptedUpstream(),
    windowMs = 5_000,
) {
    const records = new RecordWriter(null);
    const injector = new FaultInjector(fault ? [fault] : [], new Rng(7), windowMs);
    const started: CallStarted[] = [];
    let scenario = 1_000;
    const gateway = new Gateway({
        upstream,
        records,
        injector,
        rng: new Rng(42),
        clock: { scenarioMs: () => (scenario += 10) },
        scope: () => ({ arm: "eidnara", session: "s-0001", turn: "e-000001" }),
        observe: (e) => started.push(e),
    });
    await gateway.start();
    gateways.push(gateway);
    return { gateway, records, injector, started, url: gateway.urls[0] as string };
}

async function hostCallJson(url: string, body: unknown, timeoutMs: number): Promise<JsonResult> {
    const result: JsonResult = { status: 0, json: null, text: "", ms: 0, timedOut: false };
    const t0 = performance.now();
    try {
        const response = await fetch(`${url}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
            keepalive: false,
        });
        result.status = response.status;
        result.text = await response.text();
        try {
            result.json = JSON.parse(result.text);
        } catch {
            result.json = null;
        }
    } catch {
        result.timedOut = true;
    }
    result.ms = performance.now() - t0;
    return result;
}

interface JsonResult {
    status: number;
    json: {
        stopReason?: string;
        output?: { message?: { content?: Record<string, unknown>[] } };
    } | null;
    text: string;
    ms: number;
    timedOut: boolean;
}

function hostSeesJson(type: FaultType, r: JsonResult): boolean {
    const content = r.json?.output?.message?.content ?? [];
    switch (type) {
        case "provider_429":
            return r.status === 429;
        case "provider_5xx":
            return r.status >= 500;
        case "provider_timeout":
            return r.timedOut;
        case "truncated_length":
            return r.json?.stopReason === "max_tokens";
        case "truncated_no_length":
            return r.status === 200 && r.json === null && r.text.length > 0;
        case "empty_content":
            return r.json?.stopReason === "end_turn" && content.length === 0;
        case "schema_wrong_tool_call": {
            const use = content.find((c) => c.toolUse)?.toolUse as
                | { input?: Record<string, unknown> }
                | undefined;
            return use?.input !== undefined && "unexpected_argument" in use.input;
        }
        case "slow_stream":
            return r.status === 200 && r.ms >= SLOW_SEEN_MS;
        default:
            return false;
    }
}

const INTERMITTENT_SEQUENCE = (() => {
    const rng = new Rng(7);
    return Array.from({ length: 10 }, () => rng.next() < 0.3);
})();

describe("fault composition at the proxy sink", () => {
    for (const route of ["converse-stream", "converse"] as const) {
        for (const type of PROVIDER_TYPES) {
            for (const [strategy, base] of Object.entries(STRATEGIES)) {
                test(`${route} ${type} / ${strategy}: the host sees the fault, the proxy did not retry, and the host's next call lands in the window`, async () => {
                    const params = {
                        ...base,
                        timeout_ms: 2_000,
                        delay_ms: SLOW_DELAY_MS,
                    } as Record<string, number>;
                    const fault = { id: "fault-000", type, strategy, params } as ProxyFault;
                    const { gateway, records, injector, url } = await start(fault);
                    injector.arm("fault-000");
                    const seen: boolean[] = [];
                    const timeoutMs = HOST_TIMEOUT_MS(type);
                    for (let call = 0; call < 12; call++) {
                        if (route === "converse")
                            seen.push(
                                hostSeesJson(type, await hostCallJson(url, AGENT_BODY, timeoutMs)),
                            );
                        else seen.push(hostSees(type, await hostCall(url, AGENT_BODY, timeoutMs)));
                    }
                    if (strategy === "persistent") injector.disarm("fault-000");
                    await hostCall(url, AGENT_BODY, timeoutMs);
                    while (gateway.inFlight > 0) await Bun.sleep(10);
                    expect(records.records).toHaveLength(13);
                    const injected = records.records.filter((r) => r.fault_ref === "fault-000");
                    const expected =
                        strategy === "single"
                            ? [true, ...Array(11).fill(false)]
                            : strategy === "burst"
                              ? [true, true, true, ...Array(9).fill(false)]
                              : strategy === "persistent"
                                ? Array(12).fill(true)
                                : [...INTERMITTENT_SEQUENCE, false, false];
                    expect(seen).toEqual(expected);
                    const byStart = [...records.records].sort(
                        (x, y) => x.started_wall_ms - y.started_wall_ms || x.seq - y.seq,
                    );
                    const hits = byStart.slice(0, 12).map((r) => r.fault_ref === "fault-000");
                    expect(hits).toEqual(expected);
                    for (const r of injected) expect(r.proxy_retries).toBe(0);
                    const report = injector.report();
                    expect(report[0]?.status).toBe("fired");
                    expect(report[0]?.proxy_retried).toBe(false);
                    expect(excludedFromFaultMetrics(report)).toBe(false);
                    const firstAt = hits.indexOf(true);
                    const first = byStart[firstAt] as CallRecord;
                    const next = records.records.find(
                        (r) => r.seq === report[0]?.host_observed_seq[0],
                    );
                    expect(next?.seq).not.toBe(first.seq);
                    expect(next?.component).toBe("agent");
                    expect((next?.started_wall_ms ?? -1) >= first.started_wall_ms).toBe(true);
                    expect(
                        (next?.started_wall_ms ?? Infinity) - first.started_wall_ms,
                    ).toBeLessThanOrEqual(5_000);
                }, 60_000);
            }
        }
    }

    test("a persistent fault armed past the window is fired by its own faulted retries", async () => {
        const fault = {
            id: "p",
            type: "provider_429",
            strategy: "persistent",
            params: {},
        } as ProxyFault;
        const { injector, url } = await start(fault, scriptedUpstream(), 100);
        injector.arm("p");
        await hostCall(url, AGENT_BODY, 1_000);
        await Bun.sleep(150);
        await hostCall(url, AGENT_BODY, 1_000);
        expect(injector.report()[0]?.status).toBe("untriggered");
        await hostCall(url, AGENT_BODY, 1_000);
        expect(injector.report()[0]).toMatchObject({
            status: "fired",
            injected_seq: [0, 1, 2],
            host_observed_seq: [2],
        });
    });

    test("a fast call from another component past the window leaves an in-flight agent call to witness", async () => {
        const slowAgent: Upstream = {
            async converse(m, b, s, signal) {
                if (b.toolConfig) await Bun.sleep(300);
                return scriptedUpstream().converse(m, b, s, signal);
            },
        };
        const fault = { id: "f", type: "provider_429", strategy: "single", params: { count: 1 } };
        const { injector, url } = await start(fault as ProxyFault, slowAgent, 100);
        injector.arm("f");
        expect((await hostCall(url, AGENT_BODY, 1_000)).status).toBe(429);
        const agent = hostCall(url, AGENT_BODY, 2_000);
        await Bun.sleep(150);
        expect((await hostCall(url, SUMMARIZER_BODY, 1_000)).status).toBe(200);
        expect((await agent).status).toBe(200);
        expect(injector.report()[0]).toMatchObject({ status: "fired", host_observed_seq: [2] });
    });

    test("slow_stream over an upstream that throttles first records the proxy's retry", async () => {
        const fault = {
            id: "s",
            type: "slow_stream",
            strategy: "single",
            params: { count: 1, delay_ms: 10 },
        } as ProxyFault;
        const { injector, records, url } = await start(fault, scriptedUpstream(1));
        injector.arm("s");
        await hostCall(url, AGENT_BODY, 20_000);
        await hostCall(url, AGENT_BODY, 20_000);
        expect(records.records[0]?.proxy_retries).toBe(1);
        expect(injector.report()[0]?.proxy_retried).toBe(true);
    }, 30_000);

    test("a fault applies only to the agent component", async () => {
        const { records, injector, url } = await start({
            id: "f",
            type: "provider_429",
            strategy: "single",
            params: { count: 1 },
        });
        injector.arm("f");
        expect((await hostCall(url, SUMMARIZER_BODY, 1_000)).status).toBe(200);
        expect((await hostCall(url, AGENT_BODY, 1_000)).status).toBe(429);
        expect(records.records.map((r) => [r.component, r.fault_ref])).toEqual([
            ["history_summarizer", null],
            ["agent", "f"],
        ]);
    });
});

describe("witnesses", () => {
    test("an armed fault with no later host call is untriggered and excludes the run", async () => {
        const { injector, url } = await start({
            id: "f",
            type: "provider_5xx",
            strategy: "single",
            params: { count: 1 },
        });
        injector.arm("f");
        await hostCall(url, AGENT_BODY, 1_000);
        const [w] = injector.report();
        expect(w?.injected_seq.length).toBe(1);
        expect(w?.status).toBe("untriggered");
        expect(excludedFromFaultMetrics(injector.report())).toBe(true);
    });

    test("a fault never armed is untriggered", async () => {
        const { injector, url } = await start({
            id: "f",
            type: "provider_429",
            strategy: "single",
            params: { count: 1 },
        });
        await hostCall(url, AGENT_BODY, 1_000);
        expect(injector.report()[0]).toMatchObject({
            armed: false,
            injected_seq: [],
            status: "untriggered",
        });
    });

    test("a call from another component inside the window does not witness the fault", async () => {
        const { injector, url } = await start({
            id: "f",
            type: "provider_429",
            strategy: "single",
            params: { count: 1 },
        });
        injector.arm("f");
        await hostCall(url, AGENT_BODY, 1_000);
        await hostCall(url, SUMMARIZER_BODY, 1_000);
        expect(injector.report()[0]?.status).toBe("untriggered");
    });

    test("a host call outside the window does not witness the fault", async () => {
        const { injector, url } = await start(
            { id: "f", type: "provider_429", strategy: "single", params: { count: 1 } },
            scriptedUpstream(),
            50,
        );
        injector.arm("f");
        await hostCall(url, AGENT_BODY, 1_000);
        await Bun.sleep(120);
        await hostCall(url, AGENT_BODY, 1_000);
        expect(injector.report()[0]?.status).toBe("untriggered");
    });
});

describe("call records", () => {
    test("a forwarded call records tags, finish_reason, tokens, both times, and proxy retries", async () => {
        const upstream = scriptedUpstream();
        const { records, started, url } = await start(null, upstream);
        await hostCall(url, SUMMARIZER_BODY, 2_000);
        await hostCall(url, AGENT_BODY, 2_000, "user-sim");
        const [summary, userSim] = records.records;
        expect(summary).toMatchObject({
            component: "history_summarizer",
            componentSource: "inferred",
            finish_reason: "end_turn",
            input_tokens: 11,
            output_tokens: 7,
            cache_read_tokens: 5,
            cache_write_tokens: 3,
            proxy_retries: 0,
            scenario_ms: 1_010,
            arm: "eidnara",
            session: "s-0001",
        });
        expect(userSim).toMatchObject({ component: "user-sim", componentSource: "asserted" });
        expect((userSim?.wall_ms ?? 0) >= (summary?.wall_ms ?? Infinity)).toBe(true);
        expect(started.map((e) => e.component)).toEqual(["history_summarizer", "user-sim"]);
    });

    test("the writer refuses a record missing any required field", () => {
        const writer = new RecordWriter(null);
        const full = {
            arm: "a",
            session: null,
            turn: null,
            component: "agent",
            componentSource: "inferred",
            model: "m",
            status: 200,
            finish_reason: null,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            started_wall_ms: 1,
            scenario_ms: 0,
            first_byte_ms: null,
            proxy_retries: 0,
            fault_ref: null,
            error: null,
        } as const;
        expect(() => writer.write(full)).not.toThrow();
        for (const key of Object.keys(full)) {
            const { [key as keyof typeof full]: _gone, ...rest } = full;
            expect(() => writer.write(rest as never)).toThrow(/call record refused/);
        }
        expect(recordProblems({ ...full, seq: 0, wall_ms: 1, componentSource: "guessed" })).toEqual(
            ["componentSource missing"],
        );
    });
});

describe("upstream retry", () => {
    test("two runs with one seed produce the same backoff sequence against a scripted upstream", async () => {
        const run = async () => {
            const delays: number[] = [];
            const up = scriptedUpstream(4);
            await sendWithRetry(() => up.converse("m", {}, false, new AbortController().signal), {
                rng: new Rng(99),
                deadlineAt: Date.now() + 3_600_000,
                signal: new AbortController().signal,
                onRetry: (d) => delays.push(d),
                wait: async () => undefined,
            });
            return delays;
        };
        const [a, b] = [await run(), await run()];
        expect(a).toHaveLength(4);
        expect(a).toEqual(b);
        const other = new Rng(100);
        expect(a).not.toEqual([0, 1, 2, 3].map((i) => backoffMs(i, other)));
    });

    test("the proxy's own retry is counted on the record", async () => {
        const g = await start(null, scriptedUpstream(1));
        const r = await fetch(`${g.url}/model/m/converse`, {
            method: "POST",
            body: JSON.stringify(AGENT_BODY),
        });
        expect(r.status).toBe(200);
        expect(g.records.records[0]?.proxy_retries).toBe(1);
    }, 20_000);
});

describe("classification", () => {
    test("harness components assert their tag; host calls are inferred", () => {
        expect(classify(AGENT_BODY, "judge")).toEqual({
            component: "judge",
            componentSource: "asserted",
        });
        expect(classify(AGENT_BODY, "agent")).toEqual({
            component: "agent",
            componentSource: "inferred",
        });
        expect(classify(SUMMARIZER_BODY, undefined).component).toBe("history_summarizer");
        const title = { system: [{ text: "You are a title generator." }], messages: [] };
        expect(classify(title, undefined).component).toBe("title");
        const user = (system: string, text: string) => ({
            system: [{ text: system }],
            messages: [{ role: "user", content: [{ text }] }],
        });
        const cases: [ReturnType<typeof user>, string][] = [
            [user("Extract durable project memory.", '{"existing_memories":[]}'), "memory_capture"],
            [user("You are a memory classifier.", "<pool>x</pool>"), "memory_classifier"],
            [user("You are ContextResearcher.", "find it"), "context_researcher"],
            [user("You are a context summarization assistant.", "go"), "native_compaction"],
        ];
        for (const [body, component] of cases)
            expect(classify(body, undefined).component).toBe(component as never);
        expect(classify({ messages: [] }, undefined).component).toBe("other");
    });

    test("encodeEvent output decodes back", () => {
        const [m] = decodeMessages(encodeEvent("messageStop", { stopReason: "end_turn" }));
        expect(m?.headers[":event-type"]).toBe("messageStop");
    });
});

describe("every request yields one record", () => {
    test("an unknown route and a malformed body are recorded as rejected", async () => {
        const { records, url } = await start(null);
        expect((await fetch(`${url}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
        expect((await fetch(`${url}/model/m/converse`, { method: "POST", body: "{" })).status).toBe(
            400,
        );
        expect(
            (await fetch(`${url}/model/m/converse`, { method: "POST", body: "[]" })).status,
        ).toBe(400);
        expect(records.records.map((r) => [r.component, r.status])).toEqual([
            ["rejected", 404],
            ["rejected", 400],
            ["rejected", 400],
        ]);
    });

    test("scenario_ms is the clock at receipt, before the upstream answers", async () => {
        let clock = 100;
        const slow: Upstream = {
            async converse(m, b, streaming, signal) {
                clock = 900;
                return scriptedUpstream().converse(m, b, streaming, signal);
            },
        };
        const records = new RecordWriter(null);
        const gateway = new Gateway({
            upstream: slow,
            records,
            injector: new FaultInjector([], new Rng(1), 1_000),
            rng: new Rng(1),
            clock: { scenarioMs: () => clock },
            scope: () => ({ arm: "a", session: null, turn: null }),
        });
        await gateway.start();
        gateways.push(gateway);
        await hostCall(gateway.urls[0] as string, AGENT_BODY, 2_000);
        expect(records.records[0]?.scenario_ms).toBe(100);
    });

    test("a forwarded stream without messageStop is recorded as stream_cut", async () => {
        const cut: Upstream = {
            async converse() {
                async function* events() {
                    yield { messageStart: { role: "assistant" } };
                    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "par" } } };
                }
                return { events: events() };
            },
        };
        const { records, url } = await start(null, cut);
        expect((await hostCall(url, AGENT_BODY, 2_000)).status).toBe(200);
        expect(records.records[0]).toMatchObject({ status: 200, finish_reason: "stream_cut" });
    });

    test("an in-stream exception before messageStop is recorded as stream_cut with the exception as its error", async () => {
        const failing: Upstream = {
            async converse() {
                async function* events() {
                    yield { messageStart: { role: "assistant" } };
                    yield { internalServerException: { message: "boom" } };
                }
                return { events: events() };
            },
        };
        const { records, url } = await start(null, failing);
        expect((await hostCall(url, AGENT_BODY, 2_000)).status).toBe(200);
        expect(records.records[0]).toMatchObject({
            status: 200,
            finish_reason: "stream_cut",
            error: "internalServerException",
        });
    });

    test("an HTTP/2 call is served and stop() returns while the client session stays open", async () => {
        const { gateway, records } = await start(null);
        gateways = gateways.filter((g) => g !== gateway);
        const session = connect(gateway.urls[1] as string);
        const status = await new Promise<number>((resolve, reject) => {
            const req = session.request({ ":method": "POST", ":path": "/model/m/converse" });
            req.on("response", (h) => resolve(Number(h[":status"])));
            req.on("error", reject);
            req.end(JSON.stringify(AGENT_BODY));
            req.resume();
        });
        expect(status).toBe(200);
        expect(records.records.map((r) => [r.component, r.status])).toEqual([["agent", 200]]);
        const outcome = await Promise.race([
            gateway.stop().then(() => "stopped"),
            Bun.sleep(2_000).then(() => "hung"),
        ]);
        session.destroy();
        expect(outcome).toBe("stopped");
    }, 10_000);

    test("an upstream stream that throws before its first event still yields one record", async () => {
        const broken: Upstream = {
            async converse() {
                const boom = Object.assign(new Error("boom"), {
                    name: "ModelStreamErrorException",
                });
                const events: AsyncIterable<Record<string, unknown>> = {
                    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
                };
                return { events };
            },
        };
        const { gateway, records, url } = await start(null, broken);
        const seen = await hostCall(url, AGENT_BODY, 2_000);
        await hostCall(url, AGENT_BODY, 2_000);
        expect([seen.status, seen.timedOut, seen.events]).toEqual([200, false, []]);
        expect(records.records.map((r) => [r.status, r.finish_reason, r.error])).toEqual([
            [200, "stream_cut", "ModelStreamErrorException: boom"],
            [200, "stream_cut", "ModelStreamErrorException: boom"],
        ]);
        expect(gateway.inFlight).toBe(0);
    });

    test("malformed paths and bodies are rejected; odd but parseable bodies are forwarded", async () => {
        const { gateway, records, url } = await start(null);
        const cases: [string, string, number, string][] = [
            ["/model/%E0/converse", "{}", 400, "rejected"],
            ["/model/m/converse", "7", 400, "rejected"],
            ["/model/m/converse", '{"messages":5}', 200, "other"],
            ["/model/m/converse", '{"system":[null]}', 200, "other"],
            ["/model/m/converse", '{"messages":[null]}', 200, "other"],
        ];
        for (const [path, body, status] of cases) {
            const r = await fetch(`${url}${path}`, {
                method: "POST",
                body,
                signal: AbortSignal.timeout(2_000),
            });
            expect(r.status).toBe(status);
        }
        expect(records.records.map((r): [number, string] => [r.status, r.component])).toEqual(
            cases.map(([, , st, c]): [number, string] => [st, c]),
        );
        expect(records.records[0]?.error).toBe("malformed model id");
        expect(gateway.inFlight).toBe(0);
        expect(gateway.failures).toEqual([]);
    });

    test("a record's scenario_ms is the clock at receipt and wall_ms never decreases", async () => {
        const { records, url } = await start(null);
        await Promise.all([1, 2, 3].map(() => hostCall(url, AGENT_BODY, 2_000)));
        const walls = records.records.map((r) => r.wall_ms);
        expect([...walls].sort((a, b) => a - b)).toEqual(walls);
        expect(new Set(records.records.map((r) => r.scenario_ms)).size).toBe(3);
    });
});
