import type { Rng } from "../rng";
import type { FaultEpisode, FaultType } from "../scenario/faults";
import { encodeEvent } from "./eventstream";
import type { CallRecord, Component } from "./records";

export type ProxyFault = Pick<FaultEpisode, "id" | "type" | "strategy" | "params">;

export interface Witness {
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

interface Armed {
    fault: ProxyFault;
    calls: number;
}

export const TARGET: Component = "agent";

export class FaultInjector {
    private readonly armed = new Map<string, Armed>();
    private readonly witnesses = new Map<string, Witness>();
    private readonly pending: { fault: string; at: number; call: number }[] = [];

    constructor(
        private readonly faults: ProxyFault[],
        private readonly rng: Rng,
        private readonly windowMs: number,
    ) {
        for (const f of faults) {
            this.witnesses.set(f.id, {
                fault: f.id,
                type: f.type,
                armed: false,
                injected_seq: [],
                host_observed_seq: [],
                proxy_retried: false,
            });
        }
    }

    arm(id: string): void {
        const fault = this.faults.find((f) => f.id === id);
        if (!fault) throw new Error(`unknown proxy fault ${id}`);
        this.armed.set(id, { fault, calls: 0 });
        (this.witnesses.get(id) as Witness).armed = true;
    }

    disarm(id: string): void {
        this.armed.delete(id);
    }

    take(component: Component, call: number): ProxyFault | null {
        if (component !== TARGET) return null;
        for (const [id, a] of this.armed) {
            const { strategy, params } = a.fault;
            a.calls++;
            const limit =
                strategy === "persistent"
                    ? Number.POSITIVE_INFINITY
                    : (params.count ?? params.calls ?? 1);
            if (a.calls >= limit) this.armed.delete(id);
            if (strategy !== "intermittent" || this.rng.next() < (params.probability ?? 1)) {
                this.pending.push({ fault: id, at: Date.now(), call });
                return a.fault;
            }
        }
        return null;
    }

    observe(record: CallRecord, call: number): void {
        for (const p of this.pending.filter((x) => call > x.call)) {
            const inWindow = record.started_wall_ms <= p.at + this.windowMs;
            const sameCaller = record.component === TARGET;
            if (sameCaller && inWindow) {
                (this.witnesses.get(p.fault) as Witness).host_observed_seq.push(record.seq);
            }
            if (!inWindow || sameCaller) this.pending.splice(this.pending.indexOf(p), 1);
        }
        if (record.fault_ref === null) return;
        const w = this.witnesses.get(record.fault_ref) as Witness;
        w.injected_seq.push(record.seq);
        if (record.proxy_retries > 0) w.proxy_retried = true;
    }

    report(): WitnessReport[] {
        return [...this.witnesses.values()].map((w) => {
            const fired = w.injected_seq.length > 0 && w.host_observed_seq.length > 0;
            return { ...w, status: fired ? "fired" : "untriggered" };
        });
    }
}

export function excludedFromFaultMetrics(witnesses: WitnessReport[]): boolean {
    return witnesses.some((w) => w.status === "untriggered");
}

export interface Sink {
    status(code: number, headers: Record<string, string>): void;
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
type Ev = readonly [string, unknown];
const text = (t: string): Ev => ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: t } }];
const stop = (reason: string): Ev => ["messageStop", { stopReason: reason }];
const blockStop: Ev = ["contentBlockStop", { contentBlockIndex: 0 }];

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
    tool: string | undefined,
): Promise<FaultOutcome> {
    const error = (code: number, errorType: string): FaultOutcome => {
        sink.status(code, { "content-type": "application/json", "x-amzn-errortype": errorType });
        sink.write(Buffer.from(JSON.stringify({ message: `${errorType} (injected)` })));
        sink.end();
        return { status: code, finish_reason: null, error: `${errorType} (injected)` };
    };
    if (type === "provider_429") return error(429, "ThrottlingException");
    if (type === "provider_5xx") return error(503, "ServiceUnavailableException");
    if (type === "provider_timeout") {
        await sleep(params.timeout_ms ?? 120_000, sink.signal);
        sink.destroy();
        return { status: 0, finish_reason: null, error: "timeout (injected)" };
    }
    const [events, finish] = faultEvents(type, tool);
    const cut = finish === "stream_cut";
    if (!cut) events.push(["metadata", usage]);
    if (streaming) {
        sink.status(200, EVENTSTREAM);
        for (const [t, member] of events) sink.write(encodeEvent(t, member));
    } else {
        const content: unknown[] = events.flatMap(([t, m]) => {
            const delta = (m as { delta?: { text?: string } }).delta;
            return t === "contentBlockDelta" && delta?.text ? [{ text: delta.text }] : [];
        });
        if (type === "schema_wrong_tool_call") {
            const input = { unexpected_argument: "{not json" };
            content.push({
                toolUse: { toolUseId: "tooluse_injected", name: tool ?? "bash", input },
            });
        }
        const message = { role: "assistant", content };
        const json = JSON.stringify({ output: { message }, stopReason: finish, ...usage });
        sink.status(200, { "content-type": "application/json" });
        sink.write(Buffer.from(cut ? json.slice(0, json.length / 2) : json));
    }
    sink.end();
    const relayed = events.flatMap(([t, m]) => {
        const delta = (m as { delta?: { text?: string } }).delta;
        return t === "contentBlockDelta" && delta?.text ? [delta.text] : [];
    });
    const text = cut && !streaming ? "" : relayed.join("");
    return {
        status: 200,
        finish_reason: finish,
        error: cut ? "stream cut (injected)" : null,
        text,
    };
}
