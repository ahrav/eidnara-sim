import type { Rng } from "../rng";
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

interface Armed {
    arm: string;
    fault: ProxyFault;
    calls: number;
}

export const TARGET: Component = "agent";

export class FaultInjector {
    private readonly armed = new Map<string, Armed>();
    private readonly witnesses = new Map<string, Witness>();
    private readonly pending: { key: string; arm: string; at: number; call: number }[] = [];

    constructor(
        private readonly faults: ProxyFault[],
        private readonly rng: Rng,
        private readonly windowMs: number,
    ) {}

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

    /** Arming after `restore` continues a multi-call episode from the injections already made. */
    arm(id: string, arm: string): void {
        const w = this.witness(arm, id);
        const fault = this.faults.find((f) => f.id === id) as ProxyFault;
        this.armed.set(`${arm}/${id}`, { arm, fault, calls: w.injected_seq.length });
        w.armed = true;
    }

    disarm(id: string, arm: string): void {
        this.armed.delete(`${arm}/${id}`);
    }

    /** `at` is the request's arrival time, the same instant `restore` reads from the record. */
    take(component: Component, call: number, arm: string, at = Date.now()): ProxyFault | null {
        if (component !== TARGET) return null;
        for (const [key, a] of this.armed) {
            if (a.arm !== arm) continue;
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
            if (strategy !== "intermittent" || this.rng.next() < (params.probability ?? 1)) {
                this.pending.push({ key, arm, at, call });
                return a.fault;
            }
        }
        return null;
    }

    /**
     * An injection is witnessed by the first later agent call that started inside the window.
     * Records arrive in completion order, so a pending injection stays until such a call settles.
     */
    observe(record: CallRecord, call: number): void {
        for (const p of this.pending.filter((x) => x.arm === record.arm && call > x.call)) {
            const inWindow = record.started_wall_ms <= p.at + this.windowMs;
            const sameCaller = record.component === TARGET;
            if (sameCaller && inWindow) {
                (this.witnesses.get(p.key) as Witness).host_observed_seq.push(record.seq);
                this.pending.splice(this.pending.indexOf(p), 1);
            }
        }
        if (record.fault_ref === null) return;
        const w = this.witness(record.arm, record.fault_ref);
        w.injected_seq.push(record.seq);
        if (record.proxy_retries > 0) w.proxy_retried = true;
    }

    /** Every episode's witness for `arm`; an episode never armed there is `untriggered`. */
    report(arm: string): WitnessReport[] {
        return this.faults.map((f) => {
            const w = this.witness(arm, f.id);
            const fired = w.injected_seq.length > 0 && w.host_observed_seq.length > 0;
            return { ...w, status: fired ? "fired" : "untriggered" };
        });
    }

    /**
     * `restore` rebuilds `injected_seq` and `host_observed_seq` from the call records an earlier
     * invocation of the same run persisted, replayed in request-start order so a delayed injected
     * call precedes the retries it caused. Observations are matched within those records only;
     * the live pending list starts empty.
     */
    restore(prior: CallRecord[]): void {
        const byStart = [...prior].sort(
            (a, b) => a.started_wall_ms - b.started_wall_ms || a.seq - b.seq,
        );
        byStart.forEach((record, call) => {
            const known =
                record.fault_ref !== null && this.faults.some((f) => f.id === record.fault_ref);
            if (known) {
                const w = this.witness(record.arm, record.fault_ref as string);
                w.armed = true;
                const key = `${record.arm}/${w.fault}`;
                this.pending.push({ key, arm: record.arm, at: record.started_wall_ms, call });
            }
            if (known || record.fault_ref === null) this.observe(record, call);
        });
        this.pending.length = 0;
    }
}

export function excludedFromFaultMetrics(witnesses: WitnessReport[]): boolean {
    return witnesses.some((w) => w.status === "untriggered");
}

export interface Sink {
    status(code: number, headers: Record<string, string>): void;
    write(chunk: Buffer): void;
    end(): void;
    destroy(): void;
    signal: AbortSignal;
}

export interface FaultOutcome {
    status: number;
    finish_reason: string | null;
    error: string | null;
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
    return { status: 200, finish_reason: finish, error: cut ? "stream cut (injected)" : null };
}
