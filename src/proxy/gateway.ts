import {
    createServer as createHttp1Server,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import {
    createServer as createHttp2Server,
    type Http2Server,
    type ServerHttp2Session,
} from "node:http2";
import type { AddressInfo, Socket } from "node:net";
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
    /** Read when a request's first byte arrives; the call keeps that scope through its upload. */
    scope: () => Scope;
    /**
     * Sees every request as its first byte arrives, before the body is complete. A returned
     * function runs once the call is classified and `observe` has seen it, or once the request is
     * rejected, so the hold it represents hands over to the classified call without a gap.
     */
    arrival?: () => unknown;
    /**
     * A returned function runs once the call's record is written, or once the write failed. A
     * hook that throws is recorded in `failures`; the call itself is still served.
     */
    observe?: (event: CallStarted) => unknown;
    requestDeadlineMs?: number;
    /** HTTP/2 session errors, GOAWAY frames, and stream resets on the host side of the proxy. */
    downstream?: (event: Record<string, unknown>) => void;
    /** How long `stop` waits for in-flight handlers and uploads to write their records. */
    drainMs?: number;
    /** The first arrival ordinal to assign; a resume passes one past the persisted maximum. */
    firstArrival?: number;
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
    expect: string | undefined;
    body: Body;
    /** Receipt of the request's first bytes on the monotonic clock, before its body arrived. */
    receivedMono: number;
    /** The same receipt on the wall clock. */
    receivedWall: number;
    /** The retry seed, drawn from the root stream at receipt so the draw order is the receipt order. */
    seed: number;
    /** The arrival ordinal, assigned at receipt; the record carries it as `arrival`. */
    call: number;
    /** Ends the arrival hold; runs once, after classification or when the request is rejected. */
    release: () => void;
    /** Aborts the request's upstream work; `stop` aborts every request still in flight. */
    gone: AbortController;
    /**
     * The arm, session, turn, and scenario time that owned the request at receipt, or the
     * error reading them raised with whatever was read first; `handle()` records that error
     * against the request under that scope.
     */
    owner: { scope: Scope; scenario_ms: number } | { scope?: Scope; error: unknown };
}

export class Gateway {
    private servers: (Server | Http2Server)[] = [];
    private readonly sessions = new Set<ServerHttp2Session>();
    /** Open HTTP/1 sockets, destroyed on stop so a client mid-upload cannot hold the close. */
    private readonly sockets = new Set<Socket>();
    /** The abort controller of every request received and not yet recorded. */
    private readonly aborts = new Set<AbortController>();
    inFlight = 0;
    readonly failures: Error[] = [];
    /** Arrival ordinals continue after the highest one the persisted records carry. */
    private calls: number;
    /** Set once `stop` returns; a handler that settles afterwards persists nothing. */
    private closed = false;
    readonly urls: string[] = [];

    constructor(private readonly options: GatewayOptions) {
        this.calls = (options.firstArrival ?? 0) | 0;
    }

    /** Calls the arrival hook; a hook that throws is recorded as a failure and the request still runs. */
    private arrive(): () => void {
        let release: unknown;
        try {
            release = this.options.arrival?.();
        } catch (caught) {
            this.failures.push(caught as Error);
        }
        const once = { done: false };
        return () => {
            if (once.done || typeof release !== "function") return;
            once.done = true;
            try {
                (release as () => void)();
            } catch (caught) {
                this.failures.push(caught as Error);
            }
        };
    }

    async start(): Promise<void> {
        const onRequest = (req: IncomingMessage, res: ServerResponse) => {
            this.inFlight++;
            const receivedMono = performance.now();
            const receivedWall = Date.now();
            const seed = this.options.rng.nextU32();
            const call = this.calls++;
            const owner = this.received();
            const release = this.arrive();
            const gone = new AbortController();
            this.aborts.add(gone);
            res.on("close", () => !res.writableFinished && gone.abort());
            collectBody(req, (body) => {
                const request: Request = {
                    path: req.url ?? "",
                    method: req.method ?? "",
                    header: req.headers[COMPONENT_HEADER] as string | undefined,
                    expect: req.headers.expect,
                    body,
                    receivedMono,
                    receivedWall,
                    seed,
                    call,
                    release,
                    gone,
                    owner,
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
        };
        const h1 = createHttp1Server(onRequest);
        h1.on("checkExpectation", onRequest);
        h1.on("connection", (socket: Socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
        });
        const h2 = createHttp2Server();
        const log = (kind: string, detail: Record<string, unknown>) =>
            this.options.downstream?.({ kind, wall_ms: Date.now(), ...detail });
        const ids = new WeakMap<object, number>();
        let sessions = 0;
        h2.on("session", (session) => {
            this.sessions.add(session);
            session.on("close", () => this.sessions.delete(session));
            const h2_session = sessions++;
            ids.set(session, h2_session);
            const at = () => ({ ...this.options.scope(), h2_session });
            session.on("error", (e: Error) => log("session_error", { ...at(), error: e.message }));
            session.on("frameError", (type: number, code: number) =>
                log("frame_error", { ...at(), type, code }),
            );
            session.on("goaway", (code: number) => log("goaway", { ...at(), code }));
        });
        h2.on("stream", (stream, headers) => {
            this.inFlight++;
            const receivedMono = performance.now();
            const receivedWall = Date.now();
            const seed = this.options.rng.nextU32();
            const call = this.calls++;
            const owner = this.received();
            const release = this.arrive();
            const gone = new AbortController();
            this.aborts.add(gone);
            const opened = { ...this.options.scope(), h2_session: ids.get(stream.session ?? {}) };
            stream.on("close", () => {
                if (stream.rstCode)
                    log("stream_reset", {
                        ...opened,
                        code: stream.rstCode,
                        finished: stream.writableFinished,
                    });
                if (!stream.writableFinished) gone.abort();
            });
            collectBody(stream, (body) => {
                const live = () => !stream.destroyed;
                const request: Request = {
                    path: String(headers[":path"] ?? ""),
                    method: String(headers[":method"] ?? ""),
                    header: headers[COMPONENT_HEADER] as string | undefined,
                    expect: undefined,
                    body,
                    receivedMono,
                    receivedWall,
                    seed,
                    call,
                    release,
                    gone,
                    owner,
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
                    server.listen(0, "127.0.0.1", () => {
                        server.off("error", reject);
                        server.on("error", (caught) => this.failures.push(caught));
                        done();
                    });
                });
            } catch (caught) {
                await this.stop(0);
                throw caught;
            }
            this.urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }
    }

    /**
     * Connections are destroyed before `close()`: under Bun, `closeAllConnections()` after
     * `close()` leaves them open. Every in-flight request is aborted, so a partial upload yields
     * its rejected record and a handler writes what it saw. The close wait and the drain share
     * `graceMs`; a request still in flight after it is a failure, and its record is dropped.
     * Idempotent: a second call after the gateway closed returns at once.
     */
    async stop(graceMs = this.options.drainMs ?? 10_000): Promise<void> {
        if (this.closed) return;
        const deadline = Date.now() + graceMs;
        (this.servers[0] as Server | undefined)?.closeAllConnections();
        for (const socket of this.sockets) socket.destroy();
        for (const session of this.sessions) session.destroy();
        for (const gone of this.aborts) gone.abort();
        const closed = Promise.all(
            this.servers.map((s) => new Promise<void>((done) => s.close(() => done()))),
        );
        await Promise.race([closed, Bun.sleep(Math.max(0, deadline - Date.now()))]);
        while (this.inFlight > 0 && Date.now() < deadline) await Bun.sleep(10);
        if (this.inFlight > 0) {
            this.failures.push(
                new Error(
                    `${this.inFlight} proxy handler(s) still active ${graceMs} ms after stop`,
                ),
            );
        }
        this.closed = true;
    }

    /** The owning scope and scenario time, read when a request's first bytes arrive. */
    private received(): Request["owner"] {
        let scope: Scope | undefined;
        try {
            const { arm, session, turn } = this.options.scope();
            scope = { arm, session, turn };
            return { scope, scenario_ms: this.options.clock.scenarioMs() };
        } catch (error) {
            return { scope, error };
        }
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
        const call = request.call;
        const startedWall = request.receivedWall;
        const startedMono = request.receivedMono;
        let done: Done = {
            component: "rejected",
            componentSource: "inferred",
            model: "",
            status: 500,
        };
        let scope: Scope = request.owner.scope ?? { arm: "", session: null, turn: null };
        let scenario_ms = 0;
        const after: { ended: (() => void) | null } = { ended: null };
        try {
            if ("error" in request.owner) throw request.owner.error;
            ({ scope, scenario_ms } = request.owner);
            done = await this.serve(
                request,
                sink,
                call,
                startedMono,
                (d) => {
                    done = d;
                },
                (end) => {
                    after.ended = end;
                },
            );
        } catch (caught) {
            done = { ...done, error: `${(caught as Error).name}: ${(caught as Error).message}` };
            sink.status(500, { "content-type": "application/json" });
        }
        sink.end();
        const base = {
            ...scope,
            arrival: call,
            started_wall_ms: startedWall,
            scenario_ms,
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
        try {
            if (this.closed) {
                this.failures.push(
                    new Error("a proxy handler settled after stop; its record was dropped"),
                );
                return;
            }
            const record = this.options.records.write({ ...base, ...done, status: sent });
            this.options.injector.observe(record, call, startedMono);
        } finally {
            this.inFlight--;
            this.aborts.delete(request.gone);
            request.release();
            if (!this.closed) {
                try {
                    after.ended?.();
                } catch (caught) {
                    this.failures.push(caught as Error);
                }
            }
        }
    }

    private async serve(
        request: Request,
        sink: Sink & { sent: () => number },
        call: number,
        startedMono: number,
        progress: (d: Done) => void,
        onEnd: (end: () => void) => void,
    ): Promise<Done> {
        const { path, method, header, expect, body: upload } = request;
        const received = upload.received;
        const started = startedMono;
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
              : expect !== undefined && expect.toLowerCase() !== "100-continue"
                ? [417, `unsupported Expect ${expect}`]
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
        const stripped = stripUnsupported(model, body);
        if (stripped) done.stripped = stripped;
        progress(done);
        const event = { kind: "call_started", component: tag.component, wall_ms: Date.now() };
        try {
            const ended = this.options.observe?.(event as CallStarted);
            if (typeof ended === "function") onEnd(ended as () => void);
        } catch (caught) {
            this.failures.push(caught as Error);
        }
        request.release();
        const arm = request.owner.scope?.arm ?? "";
        const fault = this.options.injector.take(tag.component, call, startedMono, arm);
        const rng = new Rng(request.seed);
        const firstByte = () => {
            if (done.first_byte_ms != null) return;
            done.first_byte_ms = performance.now() - started;
        };
        const answer = (code: number, headers: Record<string, string>): boolean => {
            const accepted = sink.status(code, headers);
            if (accepted) firstByte();
            return accepted;
        };
        if (fault && fault.type !== "slow_stream") {
            const tool = body.toolConfig?.tools?.[0]?.toolSpec;
            const { applied, text, ...outcome } = await writeFault(
                fault.type,
                fault.params,
                streaming,
                { ...sink, status: answer },
                tool,
            );
            if (applied) done.fault_ref = fault.id;
            const relayed = text && RELAYED_TEXT.has(done.component) ? { response_text: text } : {};
            return { ...done, ...outcome, ...relayed };
        }
        const usage: Usage = {};
        const deadlineMs = this.options.requestDeadlineMs ?? 900_000;
        const signal = AbortSignal.any([sink.signal, AbortSignal.timeout(deadlineMs)]);
        const delay = async () => {
            if (!fault) return;
            await sleep(fault.params.delay_ms ?? 2_000, signal);
            if (signal.aborted) throw signal.reason;
        };
        const delivered = () => {
            if (fault) done.fault_ref = fault.id;
        };
        let retries = 0;
        let sawStop = false;
        let sawMetadata = false;
        const text: string[] = [];
        let textLength = 0;
        let truncated = false;
        const keep = RELAYED_TEXT.has(done.component);
        const retain = (piece: string) => {
            if (!keep) return;
            const room = RESPONSE_TEXT_LIMIT - textLength;
            if (piece.length > room) truncated = true;
            if (room <= 0) return;
            const kept = piece.slice(0, room);
            text.push(kept);
            textLength += kept.length;
        };
        try {
            const deadlineAt = Date.now() + deadlineMs;
            const response = await sendWithRetry(
                () => this.options.upstream.converse(model, body, streaming, signal),
                {
                    rng,
                    deadlineAt,
                    signal,
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
                const output = response.json.output as
                    | { message?: { content?: Array<{ text?: string }> } }
                    | undefined;
                const blocks = (output?.message?.content ?? []).map((b) => b.text ?? "");
                const accepted = answer(200, { "content-type": "application/json" });
                if (accepted) delivered();
                const written =
                    accepted &&
                    !sink.signal.aborted &&
                    sink.write(Buffer.from(wireJson(response.json)));
                if (written) retain(blocks.filter(Boolean).join("\n"));
                else done.error ??= "client disconnected before the response was delivered";
            } else {
                const accepted = sink.status(200, {
                    "content-type": "application/vnd.amazon.eventstream",
                });
                let block: number | null = null;
                let relaying = accepted;
                events: for await (const event of response.events) {
                    for (const [type, member] of Object.entries(event)) {
                        if (member === undefined) continue;
                        await delay();
                        const m = member as {
                            usage?: Usage;
                            stopReason?: string;
                            contentBlockIndex?: number;
                            delta?: { text?: string };
                        };
                        const frame = type.endsWith("Exception")
                            ? encodeException(type, member)
                            : encodeEvent(type, member);
                        if (!relaying || sink.signal.aborted || !sink.write(frame)) {
                            relaying = false;
                            break events;
                        }
                        firstByte();
                        delivered();
                        if (type === "contentBlockDelta" && m.delta?.text) {
                            const index = m.contentBlockIndex ?? 0;
                            if (block !== null && index !== block) retain("\n");
                            block = index;
                            retain(m.delta.text);
                        }
                        if (type === "metadata") {
                            sawMetadata = true;
                            Object.assign(usage, m.usage ?? {});
                        }
                        if (type === "messageStop" && m.stopReason) {
                            sawStop = true;
                            done.finish_reason = m.stopReason;
                        }
                        if (type.endsWith("Exception")) done.error = type;
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
            const payload: Record<string, unknown> = { message: text };
            for (const [key, value] of Object.entries(failure)) {
                if (!key.startsWith("$") && !["name", "message", "stack"].includes(key)) {
                    payload[key] = value;
                }
            }
            if (sink.sent() === 0) {
                answer(done.status, {
                    "content-type": "application/json",
                    "x-amzn-errortype": errorType,
                });
                sink.write(Buffer.from(JSON.stringify(payload)));
            } else if (streaming) {
                if (!sawStop || !sawMetadata) done.finish_reason = "stream_cut";
                const member = errorType[0]?.toLowerCase() + errorType.slice(1);
                const frame = errorType.endsWith("Exception")
                    ? encodeException(member, payload)
                    : encodeError(errorType, text);
                if (sink.write(frame)) firstByte();
            }
        }
        const relayed = text.join("");
        const cut = truncated ? { response_text_truncated: true as const } : {};
        return {
            ...done,
            ...(relayed && keep ? { response_text: relayed, ...cut } : {}),
            proxy_retries: retries,
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_tokens: usage.cacheReadInputTokens ?? 0,
            cache_write_tokens: usage.cacheWriteInputTokens ?? 0,
        };
    }
}
