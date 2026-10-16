import { createServer as createHttp1Server, type Server } from "node:http";
import {
    createServer as createHttp2Server,
    type Http2Server,
    type ServerHttp2Session,
} from "node:http2";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import {
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Rng } from "../rng";
import { COMPONENT_HEADER, type ConverseBody, classify } from "./classify";
import { encodeError, encodeEvent, encodeException, wireJson } from "./eventstream";
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

/** The wire body carries blobs as base64 strings; the SDK's default encoder would base64 them a second time. */
export const wireBase64 = (value: string | Uint8Array): string =>
    typeof value === "string" ? value : Buffer.from(value).toString("base64");

export function bedrockUpstream(
    region: string,
    profile: string,
    client = new BedrockRuntimeClient({
        region,
        maxAttempts: 1,
        credentials: defaultProvider({ profile }),
        base64Encoder: wireBase64,
    }),
): Upstream {
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
            await (opts.wait ?? sleep)(delay, opts.signal);
            if (opts.signal.aborted || Date.now() >= opts.deadlineAt) throw caught;
            opts.onRetry(delay);
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

interface Body {
    chunks: Buffer[];
    received: number;
    ended: boolean;
}

function collectBody(source: Readable, onDone: (body: Body) => void): void {
    const body: Body = { chunks: [], received: 0, ended: false };
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        onDone(body);
    };
    source.on("data", (c: Buffer) => {
        body.received += c.length;
        if (body.received <= MAX_BODY) body.chunks.push(c);
    });
    source.on("end", () => {
        body.ended = true;
        finish();
    });
    source.on("close", finish);
    source.on("error", () => undefined);
}

interface Request {
    path: string;
    method: string;
    header: string | undefined;
    body: Body;
}

export class Gateway {
    private servers: (Server | Http2Server)[] = [];
    private readonly sessions = new Set<ServerHttp2Session>();
    inFlight = 0;
    readonly failures: Error[] = [];
    private calls = 0;
    readonly urls: string[] = [];

    constructor(private readonly options: GatewayOptions) {}

    async start(): Promise<void> {
        const h1 = createHttp1Server((req, res) => {
            const gone = new AbortController();
            res.on("close", () => !res.writableFinished && gone.abort());
            collectBody(req, (body) => {
                const request: Request = {
                    path: req.url ?? "",
                    method: req.method ?? "",
                    header: req.headers[COMPONENT_HEADER] as string | undefined,
                    body,
                };
                this.handle(request, {
                    status: (code, headers) => {
                        if (res.destroyed) return false;
                        res.writeHead(code, headers);
                        return true;
                    },
                    write: (chunk) => {
                        if (res.destroyed) return false;
                        res.write(chunk);
                        return true;
                    },
                    end: () => res.end(),
                    destroy: () => res.destroy(),
                    signal: gone.signal,
                }).catch((caught) => this.failures.push(caught as Error));
            });
        });
        const h2 = createHttp2Server();
        h2.on("session", (session) => {
            this.sessions.add(session);
            session.on("close", () => this.sessions.delete(session));
        });
        h2.on("stream", (stream, headers) => {
            const gone = new AbortController();
            stream.on("close", () => !stream.writableFinished && gone.abort());
            collectBody(stream, (body) => {
                const live = () => !stream.destroyed;
                const request: Request = {
                    path: String(headers[":path"] ?? ""),
                    method: String(headers[":method"] ?? ""),
                    header: headers[COMPONENT_HEADER] as string | undefined,
                    body,
                };
                this.handle(request, {
                    status: (code, h) => {
                        if (!live() || stream.headersSent) return false;
                        stream.respond({ ":status": code, ...h });
                        return true;
                    },
                    write: (chunk) => {
                        if (!live()) return false;
                        stream.write(chunk);
                        return true;
                    },
                    end: () => live() && stream.end(),
                    destroy: () => stream.destroy(),
                    signal: gone.signal,
                }).catch((caught) => this.failures.push(caught as Error));
            });
        });
        this.servers = [h1, h2];
        for (const server of this.servers) {
            try {
                await new Promise<void>((done, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", () => done());
                });
            } catch (caught) {
                await this.stop(0);
                throw caught;
            }
            this.urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }
    }

    async stop(graceMs = 5_000): Promise<void> {
        (this.servers[0] as Server | undefined)?.closeAllConnections();
        for (const session of this.sessions) session.destroy();
        await Promise.all(
            this.servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
        );
        const deadline = Date.now() + graceMs;
        while (this.inFlight > 0 && Date.now() < deadline) await Bun.sleep(10);
    }

    private async handle(request: Request, outer: Sink) {
        let sent = 0;
        const sink: Sink & { sent: () => number } = {
            ...outer,
            status: (code, headers) => {
                const delivered = sent === 0 && outer.status(code, headers);
                if (delivered) sent = code;
                return delivered;
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
            done = await this.serve(request, sink, call, (d) => {
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
        request: Request,
        sink: Sink & { sent: () => number },
        call: number,
        progress: (d: Done) => void,
    ): Promise<Done> {
        const { path, method, header, body: upload } = request;
        const received = upload.received;
        const started = performance.now();
        const route = ROUTE.exec(path.split("?", 1)[0] ?? "");
        const parse = <T>(f: () => T): T | undefined => {
            try {
                return f();
            } catch {
                return undefined;
            }
        };
        const model = parse(() => decodeURIComponent(route?.[1] ?? ""));
        const early = !route
            ? [404, `unknown operation ${path}`]
            : method !== "POST"
              ? [405, `${method} is not POST`]
              : !upload.ended
                ? [400, `the client left after ${received} bytes of the body`]
                : received > MAX_BODY
                  ? [413, `body of ${received} bytes over the limit`]
                  : model === undefined
                    ? [400, "malformed model id"]
                    : null;
        const raw = Buffer.concat(upload.chunks);
        const body = early ? null : parse(() => JSON.parse(raw.toString("utf8")) as ConverseBody);
        const problem =
            early ??
            (!body || typeof body !== "object" || Array.isArray(body)
                ? [400, `malformed body (${received} bytes)`]
                : null);
        if (!route || !body || model === undefined || problem) {
            const [status, error] = problem as [number, string];
            if (upload.ended) sink.status(status, { "content-type": "application/json" });
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
        progress(done);
        const fault = this.options.injector.take(tag.component, call);
        const rng = new Rng(this.options.rng.nextU32());
        const firstByte = () => {
            if (done.first_byte_ms != null) return;
            done.first_byte_ms = performance.now() - started;
            const event = { kind: "call_started", component: tag.component, wall_ms: Date.now() };
            this.options.observe?.(event as CallStarted);
        };
        const answer = (code: number, headers: Record<string, string>): boolean => {
            const accepted = sink.status(code, headers);
            if (accepted) firstByte();
            return accepted;
        };
        if (fault && fault.type !== "slow_stream") {
            const tool = body.toolConfig?.tools?.[0]?.toolSpec;
            const { applied, ...outcome } = await writeFault(
                fault.type,
                fault.params,
                streaming,
                { ...sink, status: answer },
                tool,
            );
            if (applied) done.fault_ref = fault.id;
            return { ...done, ...outcome };
        }
        const usage: Usage = {};
        const delay = async () => {
            if (!fault) return;
            done.fault_ref = fault.id;
            await sleep(fault.params.delay_ms ?? 2_000, sink.signal);
        };
        let retries = 0;
        let sawStop = false;
        let sawMetadata = false;
        try {
            const deadlineAt = Date.now() + (this.options.requestDeadlineMs ?? 900_000);
            const response = await sendWithRetry(
                () => this.options.upstream.converse(model, body, streaming, sink.signal),
                {
                    rng,
                    deadlineAt,
                    signal: sink.signal,
                    onRetry: () => retries++,
                },
            );
            if ("json" in response) {
                await delay();
                Object.assign(usage, response.json.usage ?? {});
                const reason = response.json.stopReason as string | undefined;
                if (reason) done.finish_reason = reason;
                else {
                    done.finish_reason = "stream_cut";
                    done.error ??= "the response carried no stopReason";
                }
                answer(200, { "content-type": "application/json" });
                sink.write(Buffer.from(wireJson(response.json)));
            } else {
                const accepted = sink.status(200, {
                    "content-type": "application/vnd.amazon.eventstream",
                });
                for await (const event of response.events) {
                    for (const [type, member] of Object.entries(event)) {
                        if (member === undefined) continue;
                        await delay();
                        const m = member as { usage?: Usage; stopReason?: string };
                        if (type === "metadata") {
                            sawMetadata = true;
                            Object.assign(usage, m.usage ?? {});
                        }
                        if (type === "messageStop" && m.stopReason) {
                            sawStop = true;
                            done.finish_reason = m.stopReason;
                        }
                        const frame = type.endsWith("Exception")
                            ? encodeException(type, member)
                            : encodeEvent(type, member);
                        if (type.endsWith("Exception")) done.error = type;
                        if (accepted && sink.write(frame)) firstByte();
                    }
                }
                if (!sawStop || !sawMetadata) {
                    done.finish_reason = "stream_cut";
                    done.error ??= sink.signal.aborted
                        ? "client disconnected before the stream ended"
                        : "the stream ended without both a stop reason and metadata";
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
            const errorType = failure.name ?? "InternalServerException";
            const text = failure.message ?? "error";
            if (sink.sent() === 0) {
                answer(done.status, {
                    "content-type": "application/json",
                    "x-amzn-errortype": errorType,
                });
                sink.write(Buffer.from(JSON.stringify({ message: text })));
            } else if (streaming) {
                if (!sawStop || !sawMetadata) done.finish_reason = "stream_cut";
                const frame = errorType.endsWith("Exception")
                    ? encodeException(errorType, { message: text })
                    : encodeError(errorType, text);
                if (sink.write(frame)) firstByte();
            }
        }
        return {
            ...done,
            proxy_retries: retries,
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_tokens: usage.cacheReadInputTokens ?? 0,
            cache_write_tokens: usage.cacheWriteInputTokens ?? 0,
        };
    }
}
