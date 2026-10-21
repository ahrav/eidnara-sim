import { Rng } from "../rng";
import type { FaultEpisode, FaultType } from "../scenario/faults";
import { encodeEvent } from "./eventstream";
import type { CallRecord, Component } from "./records";

export type ProxyFault = Pick<FaultEpisode, "id" | "type" | "strategy" | "params">;

/** One arm's execution of one episode; the scheduler arms and observes each arm separately. */
export interface Witness {
    arm: string;
    fault: string;
    type: FaultType;
    armed: boolean;
    injected_seq: number[];
    host_observed_seq: number[];
    proxy_retried: boolean;
}

export interface WitnessReport extends Witness {
    status: "fired" | "untriggered";
}

/**
 * Whether `value` is a witness as `report()` writes it: every field of its type, sequence numbers
 * as non-negative safe integers, and `fired` exactly when an injection and an observation exist.
 */
export function isWitnessReport(value: unknown): value is WitnessReport {
    const w = value as Partial<Record<keyof WitnessReport, unknown>> | null;
    const seqs = (x: unknown) =>
        Array.isArray(x) && x.every((n) => Number.isSafeInteger(n) && (n as number) >= 0);
    if (typeof w !== "object" || w === null) return false;
    if (typeof w.arm !== "string" || typeof w.fault !== "string" || typeof w.type !== "string") {
        return false;
    }
    if (typeof w.armed !== "boolean" || typeof w.proxy_retried !== "boolean") return false;
    if (!seqs(w.injected_seq) || !seqs(w.host_observed_seq)) return false;
    const fired =
        (w.injected_seq as number[]).length > 0 && (w.host_observed_seq as number[]).length > 0;
    return w.status === (fired ? "fired" : "untriggered");
}

interface Armed {
    arm: string;
    fault: ProxyFault;
    calls: number;
    /** The arming on the monotonic clock; a call received before it takes nothing from this fault. */
    at: number;
}

export const TARGET: Component = "agent";

/** The generator for one episode: one draw from `base` mixed with the episode id. */
export function episodeStream(base: Rng, id: string): Rng {
    return new Rng((base.nextU32() ^ fnv1a(id)) >>> 0);
}

function fnv1a(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

export class FaultInjector {
    private readonly armed = new Map<string, Armed>();
    private readonly witnesses = new Map<string, Witness>();
    /** `at` is a monotonic `performance.now()` stamp, so a wall-clock step cannot move the window. */
    private readonly pending: { key: string; arm: string; at: number; call: number }[] = [];
    /** Injections an earlier invocation's records hold, awaiting the host call that saw them. */
    private readonly restoring: { key: string; arm: string; wall: number }[] = [];
    /** Agent calls by arm and arrival ordinal: receipt on the monotonic clock, and seq once recorded. */
    private readonly candidates = new Map<string, Map<number, { at: number; seq?: number }>>();
    /**
     * One generator per episode, seeded from the injector's generator and the episode id, so an
     * episode's draws depend on nothing another episode did and every arm replays them alike.
     */
    private readonly streams = new Map<string, { rng: Rng; seed: Uint32Array }>();
    private resetAt = 0;

    constructor(
        private readonly faults: ProxyFault[],
        rng: Rng,
        private readonly windowMs: number,
    ) {
        for (const f of faults) {
            const stream = episodeStream(rng, f.id);
            this.streams.set(f.id, { rng: stream, seed: stream.state() });
        }
        this.reset();
    }

    /**
     * Returns the live state to its constructed form: nothing armed or pending, and every
     * episode's generator back at its seed, so every arm draws the same masks. The scheduler
     * calls it at each arm's start. Witnesses are kept per arm, so `report()` describes every arm.
     */
    reset(): void {
        this.resetAt = performance.now();
        this.armed.clear();
        this.pending.length = 0;
        this.candidates.clear();
        for (const s of this.streams.values()) s.rng.restore(s.seed);
    }

    private witness(arm: string, id: string): Witness {
        const key = `${arm}/${id}`;
        let w = this.witnesses.get(key);
        if (w) return w;
        const fault = this.faults.find((f) => f.id === id);
        if (!fault) throw new Error(`unknown proxy fault ${id}`);
        w = {
            arm,
            fault: id,
            type: fault.type,
            armed: false,
            injected_seq: [],
            host_observed_seq: [],
            proxy_retried: false,
        };
        this.witnesses.set(key, w);
        return w;
    }

    /** Arming after `restoreRecord` continues a multi-call episode from the injections already made. */
    arm(id: string, arm: string): void {
        const w = this.witness(arm, id);
        const fault = this.faults.find((f) => f.id === id) as ProxyFault;
        const calls = w.injected_seq.length;
        this.armed.set(`${arm}/${id}`, { arm, fault, calls, at: performance.now() });
        w.armed = true;
    }

    disarm(id: string, arm: string): void {
        this.armed.delete(`${arm}/${id}`);
    }

    /** Records an earlier invocation's arming of the episode for `arm` in the witness state. */
    armedBefore(id: string, arm: string): void {
        if (this.faults.some((f) => f.id === id)) this.witness(arm, id).armed = true;
    }

    /**
     * `startedMono` is the call's receipt on the monotonic clock; a call received before the
     * last reset belongs to the previous arm and takes nothing from this one, and a call
     * received before a fault was armed takes nothing from that fault.
     */
    take(
        component: Component,
        call: number,
        startedMono = performance.now(),
        arm = "",
    ): ProxyFault | null {
        if (component !== TARGET || startedMono < this.resetAt) return null;
        this.candidate(arm).set(call, { at: startedMono });
        for (const [key, a] of this.armed) {
            if (a.arm !== arm || startedMono < a.at) continue;
            const { strategy, params } = a.fault;
            const limit =
                strategy === "persistent"
                    ? Number.POSITIVE_INFINITY
                    : (params.count ?? params.calls ?? 1);
            if (a.calls >= limit) {
                this.armed.delete(key);
                continue;
            }
            a.calls++;
            if (a.calls >= limit) this.armed.delete(key);
            const draw = () => (this.streams.get(a.fault.id) as { rng: Rng }).rng.next();
            if (strategy !== "intermittent" || draw() < (params.probability ?? 1)) {
                this.pending.push({ key, arm, at: startedMono, call });
                return a.fault;
            }
        }
        return null;
    }

    /**
     * `startedMono` is the call's receipt on the same monotonic clock `take()` and `reset()`
     * stamp; a call received before the last reset belongs to the previous arm and is ignored,
     * and a call received before an injection cannot be the host's reaction to it.
     */
    observe(record: CallRecord, call: number, startedMono: number): void {
        if (startedMono < this.resetAt) return;
        const calls = this.candidate(record.arm);
        if (record.component === TARGET) {
            calls.set(call, { at: calls.get(call)?.at ?? startedMono, seq: record.seq });
        }
        if (record.fault_ref === null) {
            const own = this.pending.findIndex((p) => p.call === call);
            if (own >= 0) this.pending.splice(own, 1);
        }
        this.settle(record.arm, calls);
        if (!this.pending.some((p) => p.arm === record.arm)) this.candidates.delete(record.arm);
        if (record.fault_ref === null) return;
        const w = this.witness(record.arm, record.fault_ref);
        w.injected_seq.push(record.seq);
        if (record.proxy_retries > 0) w.proxy_retried = true;
    }

    private candidate(arm: string): Map<number, { at: number; seq?: number }> {
        let calls = this.candidates.get(arm);
        if (!calls) {
            calls = new Map();
            this.candidates.set(arm, calls);
        }
        return calls;
    }

    /**
     * An injection is witnessed by the first later agent call to arrive, once its record is
     * written, when that call arrived inside the window. Arrival ordinals and receipt stamps rise
     * together, so a first later call past the window ends the injection's watch unwitnessed.
     */
    private settle(arm: string, calls: Map<number, { at: number; seq?: number }>): void {
        const ordered = [...calls].sort(([a], [b]) => a - b);
        for (const p of this.pending.filter((x) => x.arm === arm)) {
            const first = ordered.find(([c, x]) => c > p.call && x.at >= p.at);
            if (!first) continue;
            const [, next] = first;
            if (next.at <= p.at + this.windowMs) {
                if (next.seq === undefined) continue;
                (this.witnesses.get(p.key) as Witness).host_observed_seq.push(next.seq);
            }
            this.pending.splice(this.pending.indexOf(p), 1);
        }
    }

    /**
     * Feeds one record an earlier invocation of the same run persisted, in `restoreOrder`, so a
     * resumed run's witnesses carry the injections and observations made before the restart.
     * An injection is witnessed by the first later agent call of its arm that started inside
     * the window, on the wall clock both records carry.
     */
    restoreRecord(record: CallRecord): void {
        const known =
            record.fault_ref !== null && this.faults.some((f) => f.id === record.fault_ref);
        // Every later agent call settles the injections before it, a faulted one included, as
        // `observe()` does live; the call's own injection registers after.
        if (record.component === TARGET) {
            for (const p of this.restoring.filter((x) => x.arm === record.arm)) {
                if (record.started_wall_ms <= p.wall + this.windowMs) {
                    (this.witnesses.get(p.key) as Witness).host_observed_seq.push(record.seq);
                }
                this.restoring.splice(this.restoring.indexOf(p), 1);
            }
        }
        if (!known) return;
        const w = this.witness(record.arm, record.fault_ref as string);
        w.armed = true;
        w.injected_seq.push(record.seq);
        if (record.proxy_retries > 0) w.proxy_retried = true;
        const key = `${record.arm}/${w.fault}`;
        this.restoring.push({ key, arm: record.arm, wall: record.started_wall_ms });
    }

    /** Every episode's witness for each arm that ran, or for `arm` alone; one never armed is `untriggered`. */
    report(arm?: string): WitnessReport[] {
        const arms =
            arm === undefined
                ? [...new Set([...this.witnesses.values()].map((w) => w.arm))]
                : [arm];
        return arms.flatMap((a) =>
            this.faults.map((f) => {
                const w = this.witness(a, f.id);
                const fired = w.injected_seq.length > 0 && w.host_observed_seq.length > 0;
                return { ...w, status: fired ? "fired" : "untriggered" };
            }),
        );
    }
}

/** Arrival order puts a delayed injected call before the retries it caused. */
export function restoreOrder(
    a: Pick<CallRecord, "arrival" | "started_wall_ms" | "seq">,
    b: Pick<CallRecord, "arrival" | "started_wall_ms" | "seq">,
): number {
    if (a.arrival !== undefined && b.arrival !== undefined) return a.arrival - b.arrival;
    return a.started_wall_ms - b.started_wall_ms || a.seq - b.seq;
}

export function excludedFromFaultMetrics(witnesses: WitnessReport[]): boolean {
    return witnesses.some((w) => w.status === "untriggered");
}

export interface Sink {
    status(code: number, headers: Record<string, string>): boolean;
    /** Hands a chunk to the client; false once the client is gone and the chunk cannot reach it. */
    write(chunk: Buffer): boolean;
    end(): void;
    destroy(): void;
    signal: AbortSignal;
}

export interface FaultOutcome {
    status: number;
    finish_reason: string | null;
    error: string | null;
    /** The assistant text an injected reply carried, as the host received it. */
    text?: string;
    /** Whether the transport accepted the fault's defining effect; a timeout's silence always counts. */
    applied: boolean;
}

export const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const wake = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", wake);
            resolve();
        };
        const timer = setTimeout(wake, ms);
        signal.addEventListener("abort", wake, { once: true });
    });

const EVENTSTREAM = { "content-type": "application/vnd.amazon.eventstream" };
const usage = {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metrics: { latencyMs: 1 },
};
export interface ToolSpec {
    name: string;
    inputSchema?: { json?: unknown };
}

type Ev = readonly [string, unknown];
const text = (t: string): Ev => ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: t } }];
const stop = (reason: string): Ev => ["messageStop", { stopReason: reason }];
const blockStop: Ev = ["contentBlockStop", { contentBlockIndex: 0 }];

/** A type-violating object for a schema with typed required properties, or a bare string a `type: object` schema rejects. */
export type WrongToolInput = Record<string, unknown> | string;

/** Candidate values, one per JSON type, so a required property can take a value outside its declared types. */
const OFF_TYPE: [string, unknown][] = [
    ["number", 0],
    ["string", "not a value of the declared type"],
    ["boolean", true],
    ["null", null],
    ["array", []],
    ["object", {}],
];

export function wrongToolInput(tool: ToolSpec | undefined): WrongToolInput {
    const schema = tool?.inputSchema?.json as
        | { properties?: Record<string, { type?: string | string[] }>; required?: string[] }
        | undefined;
    const input: Record<string, unknown> = {};
    for (const name of schema?.required ?? []) {
        const declared = schema?.properties?.[name]?.type;
        if (!declared) continue;
        const allowed = new Set(Array.isArray(declared) ? declared : [declared]);
        if (allowed.has("number")) allowed.add("integer");
        if (allowed.has("integer")) allowed.add("number");
        const off = OFF_TYPE.find(([t]) => !allowed.has(t));
        if (off) input[name] = off[1];
    }
    return Object.keys(input).length > 0 ? input : "{not json";
}

function faultEvents(type: FaultType, tool: string | undefined): [Ev[], string | null] {
    const start: Ev = ["messageStart", { role: "assistant" }];
    if (type === "truncated_length") {
        return [[start, text("The change is partly"), blockStop, stop("max_tokens")], "max_tokens"];
    }
    if (type === "truncated_no_length")
        return [[start, text("The change is partly")], "stream_cut"];
    if (type === "empty_content") return [[start, stop("end_turn")], "end_turn"];
    if (type === "schema_wrong_tool_call") {
        const use = { toolUse: { toolUseId: "tooluse_injected", name: tool ?? "bash" } };
        const delta = { contentBlockIndex: 0, delta: { toolUse: { input: "{not json" } } };
        const events: Ev[] = [
            start,
            ["contentBlockStart", { contentBlockIndex: 0, start: use }],
            ["contentBlockDelta", delta],
            blockStop,
            stop("tool_use"),
        ];
        return [events, "tool_use"];
    }
    throw new Error(`faultEvents: the gateway applies ${type}`);
}

export async function writeFault(
    type: FaultType,
    params: Record<string, number>,
    streaming: boolean,
    sink: Sink,
    tool: ToolSpec | undefined,
): Promise<FaultOutcome> {
    const error = (code: number, errorType: string): FaultOutcome => {
        const applied = sink.status(code, {
            "content-type": "application/json",
            "x-amzn-errortype": errorType,
        });
        sink.write(Buffer.from(JSON.stringify({ message: `${errorType} (injected)` })));
        sink.end();
        return { status: code, finish_reason: null, error: `${errorType} (injected)`, applied };
    };
    if (type === "provider_429") return error(429, "ThrottlingException");
    if (type === "provider_5xx") return error(503, "ServiceUnavailableException");
    if (type === "provider_timeout") {
        await sleep(params.timeout_ms ?? 120_000, sink.signal);
        sink.destroy();
        return { status: 0, finish_reason: null, error: "timeout (injected)", applied: true };
    }
    const [events, finish] = faultEvents(type, tool?.name);
    const cut = finish === "stream_cut";
    if (!cut) events.push(["metadata", usage]);
    let applied: boolean;
    if (streaming) {
        applied = sink.status(200, EVENTSTREAM);
        for (const [t, member] of events) sink.write(encodeEvent(t, member));
    } else {
        const content: unknown[] = events.flatMap(([t, m]) => {
            const delta = (m as { delta?: { text?: string } }).delta;
            return t === "contentBlockDelta" && delta?.text ? [{ text: delta.text }] : [];
        });
        if (type === "schema_wrong_tool_call") {
            const input = wrongToolInput(tool);
            content.push({
                toolUse: { toolUseId: "tooluse_injected", name: tool?.name ?? "bash", input },
            });
        }
        const message = { role: "assistant", content };
        const json = JSON.stringify({ output: { message }, stopReason: finish, ...usage });
        applied = sink.status(200, { "content-type": "application/json" });
        sink.write(Buffer.from(cut ? json.slice(0, json.length / 2) : json));
    }
    sink.end();
    const relayed = events.flatMap(([t, m]) => {
        const delta = (m as { delta?: { text?: string } }).delta;
        return t === "contentBlockDelta" && delta?.text ? [delta.text] : [];
    });
    const text = !applied || (cut && !streaming) ? "" : relayed.join("");
    return {
        status: 200,
        finish_reason: finish,
        error: cut ? "stream cut (injected)" : null,
        applied,
        text,
    };
}
