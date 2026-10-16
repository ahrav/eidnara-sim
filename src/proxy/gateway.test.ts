import { afterEach, describe, expect, test } from "bun:test";
import { Rng } from "../rng";
import type { FaultType } from "../scenario/faults";
import { classify } from "./classify";
import { decodeMessages, encodeEvent } from "./eventstream";
import { backoffMs, type CallStarted, Gateway, sendWithRetry, type Upstream } from "./gateway";
import { excludedFromFaultMetrics, FaultInjector, type ProxyFault } from "./inject";
import { type CallRecord, RecordWriter, recordProblems } from "./records";

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
            return r.status === 200 && Math.max(...r.gaps) >= 40;
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

describe("fault composition at the proxy sink", () => {
    for (const type of PROVIDER_TYPES) {
        for (const [strategy, base] of Object.entries(STRATEGIES)) {
            test(`${type} / ${strategy}: the host sees the fault, the proxy did not retry, and the host's next call lands in the window`, async () => {
                const params = { ...base, timeout_ms: 2_000, delay_ms: 50 } as Record<
                    string,
                    number
                >;
                const fault = { id: "fault-000", type, strategy, params } as ProxyFault;
                const { gateway, records, injector, url } = await start(fault);
                injector.arm("fault-000");
                const seen: boolean[] = [];
                for (let call = 0; call < 12; call++) {
                    const r = await hostCall(url, AGENT_BODY, 300);
                    seen.push(hostSees(type, r));
                }
                if (strategy === "persistent") injector.disarm("fault-000");
                await hostCall(url, AGENT_BODY, 300);
                while (gateway.inFlight > 0) await Bun.sleep(10);
                const injected = records.records.filter((r) => r.fault_ref === "fault-000");
                expect(injected.length).toBeGreaterThan(0);
                expect(seen.filter(Boolean).length).toBe(injected.length);
                for (const r of injected) expect(r.proxy_retries).toBe(0);
                const expectedCount =
                    strategy === "single" ? 1 : strategy === "burst" ? 3 : undefined;
                if (expectedCount !== undefined) expect(injected.length).toBe(expectedCount);
                if (strategy === "persistent") expect(injected.length).toBe(12);
                const [w] = injector.report();
                expect(w?.status).toBe("fired");
                expect(w?.proxy_retried).toBe(false);
                const firstInjected = injected[0] as CallRecord;
                const next = records.records.find((r) => r.seq === w?.host_observed_seq[0]);
                expect(
                    (next?.started_wall_ms ?? Infinity) - firstInjected.wall_ms,
                ).toBeLessThanOrEqual(5_000);
                expect(next?.fault_ref).not.toBe("fault-000");
            }, 60_000);
        }
    }

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
        expect(records.records.map((r) => [r.component, r.status])).toEqual([
            ["rejected", 404],
            ["rejected", 400],
        ]);
    });

    test("a record's scenario_ms is the clock at receipt and wall_ms never decreases", async () => {
        const { records, url } = await start(null);
        await Promise.all([1, 2, 3].map(() => hostCall(url, AGENT_BODY, 2_000)));
        const walls = records.records.map((r) => r.wall_ms);
        expect([...walls].sort((a, b) => a - b)).toEqual(walls);
        expect(new Set(records.records.map((r) => r.scenario_ms)).size).toBe(3);
    });
});
