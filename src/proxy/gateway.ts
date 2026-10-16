import { createServer as createHttp1Server, type Server } from "node:http";
import { createServer as createHttp2Server, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import {
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { Rng } from "../rng";
import { COMPONENT_HEADER, type ConverseBody, classify } from "./classify";
import { encodeEvent } from "./eventstream";
import { type FaultInjector, type Sink, sleep, writeFault } from "./inject";
import type { CallRecord, Component, RecordWriter } from "./records";

export type UpstreamResponse =
    | { events: AsyncIterable<Record<string, unknown>> }
    | { json: Record<string, unknown> };

export interface Upstream {
    converse(
        modelId: string,
        body: ConverseBody,
        streaming: boolean,
        signal: AbortSignal,
    ): Promise<UpstreamResponse>;
}

export function bedrockUpstream(region: string, profile: string): Upstream {
    const credentials = defaultProvider({ profile });
    const client = new BedrockRuntimeClient({ region, maxAttempts: 1, credentials });
    return {
        async converse(modelId, body, streaming, abortSignal) {
            const input = { ...body, modelId } as never;
            if (!streaming) {
                const response = await client.send(new ConverseCommand(input), { abortSignal });
                const { $metadata: _m, ...json } = response;
                return { json };
            }
            const response = await client.send(new ConverseStreamCommand(input), { abortSignal });
            return { events: response.stream as AsyncIterable<Record<string, unknown>> };
        },
    };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Backoff jitter uses `rng` so the same seed and attempt sequence reproduce the same delays. */
export function backoffMs(attempt: number, rng: Rng): number {
    return Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)) * (0.5 + rng.next());
}

export async function sendWithRetry<T>(
    send: () => Promise<T>,
    opts: {
        rng: Rng;
        deadlineAt: number;
        signal: AbortSignal;
        onRetry: (delay: number) => void;
        wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    },
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await send();
        } catch (caught) {
            const meta = (caught as { $metadata?: { httpStatusCode?: number } }).$metadata;
            if (opts.signal.aborted || !RETRYABLE.has(meta?.httpStatusCode ?? 0)) throw caught;
            const delay = backoffMs(attempt, opts.rng);
            if (Date.now() + delay >= opts.deadlineAt) throw caught;
            opts.onRetry(delay);
            await (opts.wait ?? sleep)(delay, opts.signal);
        }
    }
}

export interface Scope {
    arm: string;
    session: string | null;
    turn: string | null;
}

export interface CallStarted {
    kind: "call_started";
    component: Component;
    wall_ms: number;
}

export interface GatewayOptions {
    upstream: Upstream;
    records: RecordWriter;
    injector: FaultInjector;
    rng: Rng;
    clock: { scenarioMs(): number };
    scope: () => Scope;
    observe?: (event: CallStarted) => void;
    requestDeadlineMs?: number;
}

const ROUTE = /^\/model\/([^/]+)\/(converse-stream|converse)$/;
const MAX_BODY = 32 * 1024 * 1024;
type Usage = Record<string, number>;
type Done = Partial<CallRecord> &
    Pick<CallRecord, "component" | "componentSource" | "model" | "status">;

const RESPONSE_TEXT_LIMIT = 262_144;
const RELAYED_TEXT = new Set<string>(["agent", "user-sim", "judge"]);

const CLAUDE_5_5 = /anthropic\.claude-(opus|sonnet|haiku)-5-5/;

/**
 * Removes the sampling fields Claude 5.5 models on Bedrock refuse: any `temperature`, and
 * `thinking` of type `enabled`. Returns the removed values keyed by field path.
 */
export function stripUnsupported(
    model: string,
    body: ConverseBody,
): Record<string, unknown> | undefined {
    if (!CLAUDE_5_5.test(model)) return undefined;
    const removed: Record<string, unknown> = {};
    const inference = body.inferenceConfig as { temperature?: number } | undefined;
    if (inference?.temperature !== undefined) {
        removed["inferenceConfig.temperature"] = inference.temperature;
        delete inference.temperature;
    }
    const extra = body.additionalModelRequestFields as { thinking?: { type?: string } } | undefined;
    if (extra?.thinking?.type === "enabled") {
        removed["additionalModelRequestFields.thinking"] = extra.thinking;
        delete extra.thinking;
    }
    return Object.keys(removed).length > 0 ? removed : undefined;
}

export class Gateway {
    private servers: (Server | Http2Server)[] = [];
    inFlight = 0;
    readonly failures: Error[] = [];
    private calls = 0;
    readonly urls: string[] = [];

    constructor(private readonly options: GatewayOptions) {}

    async start(): Promise<void> {
        const h1 = createHttp1Server((req, res) => {
            const chunks: Buffer[] = [];
            const gone = new AbortController();
            res.on("close", () => !res.writableFinished && gone.abort());
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const header = req.headers[COMPONENT_HEADER] as string | undefined;
                this.handle(req.url ?? "", header, Buffer.concat(chunks), {
                    status: (code, headers) => res.writeHead(code, headers),
                    write: (chunk) => res.write(chunk),
                    end: () => res.end(),
                    destroy: () => res.destroy(),
                    signal: gone.signal,
                }).catch((caught) => this.failures.push(caught as Error));
            });
        });
        const h2 = createHttp2Server();
        h2.on("stream", (stream, headers) => {
            const chunks: Buffer[] = [];
            const gone = new AbortController();
            stream.on("close", () => !stream.writableFinished && gone.abort());
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("error", () => undefined);
            stream.on("end", () => {
                const live = () => !stream.destroyed;
                const header = headers[COMPONENT_HEADER] as string | undefined;
                this.handle(String(headers[":path"] ?? ""), header, Buffer.concat(chunks), {
                    status: (code, h) => {
                        if (live() && !stream.headersSent)
                            stream.respond({ ":status": code, ...h });
                    },
                    write: (chunk) => live() && stream.write(chunk),
                    end: () => live() && stream.end(),
                    destroy: () => stream.destroy(),
                    signal: gone.signal,
                }).catch((caught) => this.failures.push(caught as Error));
            });
        });
        this.servers = [h1, h2];
        for (const server of this.servers) {
            await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
            this.urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }
    }

    async stop(): Promise<void> {
        (this.servers[0] as Server | undefined)?.closeAllConnections();
        await Promise.all(
            this.servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
        );
    }

    private async handle(path: string, header: string | undefined, raw: Buffer, outer: Sink) {
        let sent = 0;
        const sink: Sink & { sent: () => number } = {
            ...outer,
            status: (code, headers) => {
                if (sent === 0) outer.status(code, headers);
                sent ||= code;
            },
            sent: () => sent,
        };
        const base = {
            ...this.options.scope(),
            started_wall_ms: Date.now(),
            scenario_ms: this.options.clock.scenarioMs(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            first_byte_ms: null,
            proxy_retries: 0,
            fault_ref: null,
            finish_reason: null,
            error: null,
        };
        this.inFlight++;
        const call = this.calls++;
        let done: Done = {
            component: "rejected",
            componentSource: "inferred",
            model: "",
            status: 500,
        };
        try {
            done = await this.serve(path, header, raw, sink, call, (d) => {
                done = d;
            });
        } catch (caught) {
            done = { ...done, error: `${(caught as Error).name}: ${(caught as Error).message}` };
            sink.status(500, { "content-type": "application/json" });
        }
        sink.end();
        try {
            const record = this.options.records.write({ ...base, ...done, status: sent });
            this.options.injector.observe(record, call);
        } finally {
            this.inFlight--;
        }
    }

    private async serve(
        path: string,
        header: string | undefined,
        raw: Buffer,
        sink: Sink & { sent: () => number },
        call: number,
        progress: (d: Done) => void,
    ): Promise<Done> {
        const started = performance.now();
        const route = ROUTE.exec(path.split("?", 1)[0] ?? "");
        const parse = <T>(f: () => T): T | undefined => {
            try {
                return f();
            } catch {
                return undefined;
            }
        };
        const body = parse(() => JSON.parse(raw.toString("utf8")) as ConverseBody);
        const model = parse(() => decodeURIComponent(route?.[1] ?? ""));
        const problem = !route
            ? [404, `unknown operation ${path}`]
            : raw.length > MAX_BODY
              ? [413, `body of ${raw.length} bytes over the limit`]
              : model === undefined
                ? [400, "malformed model id"]
                : !body || typeof body !== "object"
                  ? [400, `malformed body (${raw.length} bytes)`]
                  : null;
        if (!route || !body || model === undefined || problem) {
            const [status, error] = problem as [number, string];
            sink.status(status, { "content-type": "application/json" });
            return {
                component: "rejected",
                componentSource: "inferred",
                model: model ?? "",
                status,
                error,
            };
        }
        const streaming = route[2] === "converse-stream";
        const tag = classify(body, header);
        const done: Done = { ...tag, model, status: 200 };
        const stripped = stripUnsupported(model, body);
        if (stripped) done.stripped = stripped;
        progress(done);
        const event = { kind: "call_started", component: tag.component, wall_ms: Date.now() };
        this.options.observe?.(event as CallStarted);
        const fault = this.options.injector.take(tag.component, call);
        if (fault) done.fault_ref = fault.id;
        if (fault && fault.type !== "slow_stream") {
            const tool = body.toolConfig?.tools?.[0]?.toolSpec?.name;
            const { text, ...outcome } = await writeFault(
                fault.type,
                fault.params,
                streaming,
                sink,
                tool,
            );
            const relayed = text && RELAYED_TEXT.has(done.component) ? { response_text: text } : {};
            return { ...done, ...outcome, ...relayed };
        }
        const usage: Usage = {};
        const firstByte = () => {
            if (done.first_byte_ms != null) return;
            done.first_byte_ms = performance.now() - started;
        };
        const delay = () =>
            fault ? sleep(fault.params.delay_ms ?? 2_000, sink.signal) : undefined;
        let retries = 0;
        const text: string[] = [];
        try {
            const deadlineAt = Date.now() + (this.options.requestDeadlineMs ?? 900_000);
            const response = await sendWithRetry(
                () => this.options.upstream.converse(model, body, streaming, sink.signal),
                {
                    rng: this.options.rng,
                    deadlineAt,
                    signal: sink.signal,
                    onRetry: () => retries++,
                },
            );
            if ("json" in response) {
                firstByte();
                await delay();
                Object.assign(usage, response.json.usage ?? {});
                const output = response.json.output as
                    | { message?: { content?: Array<{ text?: string }> } }
                    | undefined;
                const blocks = (output?.message?.content ?? []).map((b) => b.text ?? "");
                text.push(blocks.filter(Boolean).join("\n"));
                done.finish_reason = (response.json.stopReason as string | undefined) ?? null;
                sink.status(200, { "content-type": "application/json" });
                sink.write(Buffer.from(JSON.stringify(response.json)));
            } else {
                sink.status(200, { "content-type": "application/vnd.amazon.eventstream" });
                let complete = 0;
                let block: number | null = null;
                for await (const event of response.events) {
                    for (const [type, member] of Object.entries(event)) {
                        if (member === undefined) continue;
                        firstByte();
                        await delay();
                        const m = member as {
                            usage?: Usage;
                            stopReason?: string;
                            contentBlockIndex?: number;
                            delta?: { text?: string };
                        };
                        if (type === "contentBlockDelta" && m.delta?.text) {
                            const index = m.contentBlockIndex ?? 0;
                            if (block !== null && index !== block) text.push("\n");
                            block = index;
                            text.push(m.delta.text);
                        }
                        if (type === "metadata") Object.assign(usage, m.usage ?? {});
                        if (type === "messageStop") done.finish_reason = m.stopReason ?? null;
                        if (type === "messageStop" || type === "metadata") complete++;
                        if (type.endsWith("Exception")) done.error = type;
                        sink.write(encodeEvent(type, member));
                    }
                }
                if (complete < 2 && !done.error) {
                    done.finish_reason = "stream_cut";
                    done.error = sink.signal.aborted
                        ? "client disconnected before the stream ended"
                        : "the stream ended before messageStop and metadata";
                }
            }
        } catch (caught) {
            const failure = caught as {
                name?: string;
                message?: string;
                $metadata?: { httpStatusCode?: number };
            };
            done.status = failure.$metadata?.httpStatusCode ?? 500;
            done.error = `${failure.name}: ${failure.message}`;
            if (sink.sent() === 0) {
                const errorType = failure.name ?? "InternalServerException";
                sink.status(done.status, {
                    "content-type": "application/json",
                    "x-amzn-errortype": errorType,
                });
                sink.write(Buffer.from(JSON.stringify({ message: failure.message ?? "error" })));
            } else if (!done.finish_reason) done.finish_reason = "stream_cut";
        }
        const whole = text.join("");
        const relayed = whole.slice(0, RESPONSE_TEXT_LIMIT);
        const cut = whole.length > relayed.length ? { response_text_truncated: true as const } : {};
        return {
            ...done,
            ...(relayed && RELAYED_TEXT.has(done.component)
                ? { response_text: relayed, ...cut }
                : {}),
            proxy_retries: retries,
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_tokens: usage.cacheReadInputTokens ?? 0,
            cache_write_tokens: usage.cacheWriteInputTokens ?? 0,
        };
    }
}
