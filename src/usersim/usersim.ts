import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import type { NormalisationRule } from "../prereg/schema";
import { COMPONENT_HEADER } from "../proxy/classify";
import { readJournal } from "../run/journal";
import { HarnessFailure } from "../run/scheduler";
import { markerHits } from "../scenario/compile";
import type { Label, Plan } from "./plan";

/** One model call: the user's reply text and the model's stop reason. */
export type Llm = (prompt: string) => Promise<{ text: string; stop: string }>;

export function proxyUserSim(gatewayUrl: string, model: string, maxTokens: number): Llm {
    return async (prompt) => {
        const response = await fetch(`${gatewayUrl}/model/${encodeURIComponent(model)}/converse`, {
            method: "POST",
            headers: { [COMPONENT_HEADER]: "user-sim", "content-type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "user", content: [{ text: prompt }] }],
                inferenceConfig: { maxTokens },
            }),
        });
        if (!response.ok) throw new HarnessFailure(`user-sim call failed: ${response.status}`);
        const body = (await response.json()) as {
            output?: { message?: { content?: Array<{ text?: string }> } };
            stopReason?: string;
        };
        const text = (body.output?.message?.content ?? [])
            .map((b) => b.text)
            .filter((t): t is string => typeof t === "string")
            .join("\n");
        return { text, stop: body.stopReason ?? "unknown" };
    };
}

const RULES: Record<NormalisationRule, [RegExp, string]> = {
    "iso-8601-timestamps": [
        /\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g,
        "<ts>",
    ],
    durations: [
        /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|min|mins|minutes|m|h|hours)\b/g,
        "<dur>",
    ],
    pids: [/\b(?:pid|PID)\b[:= ]\s*\d+/g, "<pid>"],
    "temp-paths": [
        /\/(?:tmp|var\/tmp|var\/folders|private\/var)\/[^\s'"`)\]]*[^\s'"`)\]?!.,:;]/g,
        "<tmp>",
    ],
    "run-ids": [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<run>"],
};

/** The pre-registered digest normalisation, in its listed order; an unknown rule is refused. */
export function normaliser(rules: readonly string[]): (text: string) => string {
    const steps = rules.map((name) => {
        const rule = RULES[name as NormalisationRule];
        if (!rule)
            throw new HarnessFailure(`divergence_policy.normalisation: unknown rule ${name}`);
        return rule;
    });
    return (text) => steps.reduce((t, [re, to]) => t.replace(re, to), text);
}

/**
 * Reads a JSONL log the way the journal is read: a cut last line, which a kill mid-append
 * leaves, is dropped, and a corrupt earlier line is refused. The run's own log is cut back to
 * its complete prefix so the next append starts a whole line; a replay source must exist.
 */
function jsonl<T>(path: string, role: "own" | "source"): T[] {
    if (role === "source") requireSource(path);
    const read = readJournal(path);
    if (role === "own" && existsSync(path)) truncateSync(path, read.bytes ?? 0);
    return read as unknown as T[];
}

const pairingBeside = (tape: string) => join(dirname(tape), "pairing.jsonl");

function requireSource(path: string): string {
    if (!existsSync(path)) throw new HarnessFailure(`replay source ${path} does not exist`);
    return path;
}

export function tapeDigests(tapes: readonly string[]): string[] {
    return tapes.map((tape) =>
        sha256Hex(
            JSON.stringify([
                readFileSync(requireSource(tape), "utf8"),
                readFileSync(requireSource(pairingBeside(tape)), "utf8"),
            ]),
        ),
    );
}

interface TapeEntry {
    key: string;
    event: string;
    label: Label;
    digest: string;
    text: string;
    stop: string;
}

interface Taped {
    text: string;
    stop: string;
}

/** User-sim replies keyed by seed, event, label, and the normalised agent-output digest. */
export class Tape {
    private readonly entries = new Map<string, Taped>();
    /** Keys already on this run's own tape; a source hit is copied there once. */
    private readonly own = new Set<string>();

    constructor(
        private readonly path: string,
        sources: readonly string[] = [],
    ) {
        for (const p of sources) {
            for (const e of jsonl<TapeEntry>(p, "source")) this.entries.set(e.key, e);
        }
        for (const e of jsonl<TapeEntry>(path, "own")) {
            this.entries.set(e.key, e);
            this.own.add(e.key);
        }
    }

    get(key: string): Taped | undefined {
        return this.entries.get(key);
    }

    put(entry: TapeEntry): void {
        if (this.own.has(entry.key)) return;
        this.own.add(entry.key);
        this.entries.set(entry.key, entry);
        appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    }
}

export interface TurnRecord {
    kind: "turn";
    arm: string;
    session: string;
    event: string;
    index: number;
    label: Label;
    delivered: boolean;
    digest: string;
    prefix_sha256: string;
    text_sha256: string;
    source: "script" | "tape" | "live";
    fallback?: string[];
}

export interface DivergenceRecord {
    kind: "divergedAt";
    arm: string;
    session: string;
    event: string;
    index: number;
    digest: string;
    reference_digest: string;
    /** `recorded` for the same arm in a replayed run, else the reference arm of this run. */
    against: "recorded" | "reference";
}

export type PairingRecord = TurnRecord | DivergenceRecord;

/**
 * The pairing log; each record is on disk before the turn it describes is sent. Lookups go
 * through indexes kept in step with `records`, since an XL arm appends tens of thousands of
 * turns and each delivery reads the log several times.
 */
export class Pairing {
    readonly records: PairingRecord[];

    /** Every digest the replay sources recorded for an arm's event. */
    private readonly recorded = new Map<string, Set<string>>();
    /** The earliest index at which a replay source saw the arm diverge in a session. */
    private readonly recordedDivergence = new Map<string, number>();
    private readonly turns = new Map<string, TurnRecord>();
    private readonly lastTurn = new Map<string, TurnRecord>();
    private readonly divergence = new Map<string, number>();

    /**
     * `reference(arm)` names the arm whose digests `arm` is compared with; `sources` are the
     * pairing logs of the runs being replayed, whose digests an arm is compared with first.
     */
    constructor(
        private readonly path: string,
        readonly reference: (arm: string) => string,
        sources: readonly string[] = [],
    ) {
        this.records = jsonl<PairingRecord>(path, "own");
        for (const r of this.records) this.index(r);
        for (const r of sources.flatMap((p) => jsonl<PairingRecord>(p, "source"))) {
            if (r.kind === "turn") {
                const key = `${r.arm}/${r.event}`;
                this.recorded.set(key, (this.recorded.get(key) ?? new Set()).add(r.digest));
            } else {
                const key = `${r.arm}/${r.session}`;
                const at = this.recordedDivergence.get(key);
                if (at === undefined || r.index < at) this.recordedDivergence.set(key, r.index);
            }
        }
    }

    private index(r: PairingRecord): void {
        if (r.kind === "turn") {
            this.turns.set(`${r.arm}/${r.event}`, r);
            const key = `${r.arm}/${r.session}`;
            const prev = this.lastTurn.get(key);
            if (!prev || r.index >= prev.index) this.lastTurn.set(key, r);
        } else {
            const key = `${r.arm}/${r.session}`;
            const at = this.divergence.get(key);
            if (at === undefined || r.index < at) this.divergence.set(key, r.index);
        }
    }

    /** The digests the replay sources recorded for the arm's event; empty without a source. */
    recordedDigests(arm: string, event: string): string[] {
        return [...(this.recorded.get(`${arm}/${event}`) ?? [])];
    }

    append(record: PairingRecord): void {
        appendFileSync(this.path, `${JSON.stringify(record)}\n`);
        this.records.push(record);
        this.index(record);
    }

    referenceDigest(arm: string, event: string): string | undefined {
        return this.turns.get(`${this.reference(arm)}/${event}`)?.digest;
    }

    /** The arm's latest record of the session before `index`, to continue its prefix hash. */
    last(arm: string, session: string, index: number): TurnRecord | undefined {
        const latest = this.lastTurn.get(`${arm}/${session}`);
        if (latest && latest.index < index) return latest;
        const mine = this.records.filter(
            (x): x is TurnRecord =>
                x.kind === "turn" && x.arm === arm && x.session === session && x.index < index,
        );
        return mine.at(-1);
    }

    /**
     * The arm whose taped replies `arm` reuses: itself once it has diverged in the session, in
     * this run or in a replayed one, the shared tape for the run's first arm, else its reference
     * arm's owner. A recorded divergence counts whichever source holds it, so an arm matching a
     * source that had not diverged there may miss the shared entry and go live.
     */
    owner(arm: string, session: string, index: number): string {
        const recorded = this.recordedDivergence.get(`${arm}/${session}`);
        if (this.diverged(arm, session, index) || (recorded !== undefined && recorded <= index)) {
            return arm;
        }
        const ref = this.reference(arm);
        return ref === arm ? "" : this.owner(ref, session, index);
    }

    /** Whether the arm diverged in the session at or before `index`, in this run. */
    diverged(arm: string, session: string, index = Number.POSITIVE_INFINITY): boolean {
        const at = this.divergence.get(`${arm}/${session}`);
        return at !== undefined && at <= index;
    }
}

export interface ScriptTurn {
    id: string;
    session: string;
    index: number;
    role: string;
    text: string;
}

/**
 * The agent's last reply as the proxy recorded it: the bounded text, the digest of the whole
 * text, and its last characters when the record cut it.
 */
export interface AgentReply {
    text: string;
    sha256?: string;
    tail?: string;
}

export interface Delivery {
    label: Label;
    text: string;
    delivered: boolean;
    interruptMs?: number;
}

const ASKS: Partial<Record<Label, string>> = {
    pushback:
        "Push back on something specific in the agent's last reply: question a choice, point out something it missed, or ask it to justify or redo part of it.",
    redirect:
        "You have changed your mind about the direction of the current work. Tell the agent to drop its current approach and take the request below another way.",
    abandon:
        "You are giving up on the current line of work. Tell the agent to drop it and leave things as they are.",
    clarify:
        "The agent asked you a question. Answer it briefly and plausibly as the developer, without inventing project rules or conventions.",
};

/** Roles whose script text carries a ledger fact, which the persona prompt leaves out. */
const FACT_ROLES = new Set(["conveyance", "update", "reversal"]);

const FALLBACK: Partial<Record<Label, string>> = {
    pushback: "I'm not convinced by that. Take another look at your last change before moving on.",
    redirect: "Let's stop going down this path and try a different approach.",
    abandon: "Never mind, let's drop this and leave it as it is.",
    clarify: "Use your best judgement on that.",
};

function persona(label: Label, script: string | null, lastAgent: string): string {
    const next =
        script === null
            ? ""
            : `\nYour message is followed verbatim by this request:\n<<<\n${script}\n>>>\n`;
    return [
        "You are a software developer talking to an AI coding agent that works in your repository.",
        "Write the next message you send the agent: one to three plain, direct sentences, under 60 words.",
        "Output only that message, with no quotes or preamble, and never talk about evaluating or grading the agent.",
        "Challenge only the agent's own work and reasoning. Never deny, withdraw, or restate a rule, preference, or fact the agent says you gave it, and never ask it to forget or delete anything.",
        ASKS[label],
        next,
        `The agent's last reply was:\n<<<\n${lastAgent.slice(-6000)}\n>>>`,
    ].join("\n");
}

export const asksQuestion = (text: string) =>
    (text.trim().split("\n").at(-1) ?? "").trim().endsWith("?");

export interface UserSimOptions {
    seed: number;
    plan: Plan;
    tape: Tape;
    pairing: Pairing;
    llm: Llm;
    normalise: (text: string) => string;
    /** Ledger and probe keys the delivered text must never carry. */
    keys: readonly string[];
}

/**
 * Delivers each scripted user turn: probes, pastes, and plain tasks verbatim, and the scheduled
 * behaviours with a reply the model writes in front of the script text. A reply is keyed by the
 * agent's normalised last output, so it comes from the tape while that output matches the one
 * recorded; once an arm diverges in a session, its replies are keyed by the arm as well, so
 * they come from a replayed run's own tape or a live call.
 */
export class UserSim {
    constructor(private readonly o: UserSimOptions) {}

    async deliver(arm: string, t: ScriptTurn, lastAgent: string | AgentReply): Promise<Delivery> {
        const { plan, pairing } = this.o;
        const agent = typeof lastAgent === "string" ? { text: lastAgent } : lastAgent;
        const whole = agent.sha256 ?? sha256Hex(agent.text);
        // A cut record carries the whole text's digest, so two replies that differ only past
        // the cut still get different digests.
        const cut = whole !== sha256Hex(agent.text);
        const normalised = this.o.normalise(agent.text);
        const digest = sha256Hex(cut ? `${normalised}\n${whole}` : normalised);
        const end = cut ? (agent.tail ?? agent.text) : agent.text;
        const prev = t.index === 0 ? undefined : pairing.last(arm, t.session, t.index);
        const chain = prev ? `${prev.prefix_sha256}\n${prev.text_sha256}` : "";
        const prefix = sha256Hex(`${chain}\n${whole}`);
        const base = { arm, session: t.session, event: t.id, index: t.index, digest };
        if (plan.skipped.has(t.id)) {
            const skip = { ...base, prefix_sha256: prefix, text_sha256: sha256Hex("") };
            pairing.append({
                kind: "turn",
                ...skip,
                label: "abandon",
                delivered: false,
                source: "script",
            });
            return { label: "abandon", text: "", delivered: false };
        }
        const recorded = pairing.recordedDigests(arm, t.id);
        const reference =
            arm === pairing.reference(arm) ? undefined : pairing.referenceDigest(arm, t.id);
        const against =
            recorded.length > 0 && !recorded.includes(digest) ? "recorded" : "reference";
        const other = against === "recorded" ? recorded[0] : reference;
        if (!pairing.diverged(arm, t.session) && other !== undefined && other !== digest) {
            pairing.append({ kind: "divergedAt", ...base, reference_digest: other, against });
        }
        let label = plan.labels.get(t.id) ?? "task";
        if (label === "task" && t.role === "filler" && asksQuestion(end)) label = "clarify";
        const reply = ASKS[label] ? await this.reply(arm, t, label, digest, end) : null;
        const text =
            reply === null
                ? t.text
                : label === "abandon"
                  ? reply.text
                  : `${reply.text}\n\n${t.text}`;
        const hits = markerHits(text, this.o.keys);
        if (hits.length > 0)
            throw new HarnessFailure(`${t.id}: delivered text carries markers ${hits.join(", ")}`);
        pairing.append({
            kind: "turn",
            ...base,
            label,
            delivered: true,
            prefix_sha256: prefix,
            text_sha256: sha256Hex(text),
            source: reply?.source ?? "script",
            ...(reply?.fallback ? { fallback: reply.fallback } : {}),
        });
        const interruptMs = plan.interruptMs.get(t.id);
        return {
            label,
            text,
            delivered: true,
            ...(interruptMs === undefined ? {} : { interruptMs }),
        };
    }

    private async reply(
        arm: string,
        t: ScriptTurn,
        label: Label,
        digest: string,
        lastAgent: string,
    ) {
        const owner = this.o.pairing.owner(arm, t.session, t.index);
        // The scripted text is part of the key, so a tape from another scenario that shares the
        // seed and event ids never answers for an edited task.
        const scripted = sha256Hex(t.text);
        const key = sha256Hex(
            `${owner === "" ? "" : `${owner}/`}${this.o.seed}/${t.id}/${label}/${digest}/${scripted}`,
        );
        const taped = this.o.tape.get(key);
        let got = taped;
        if (got === undefined) {
            const script = label === "abandon" || FACT_ROLES.has(t.role) ? null : t.text;
            const live = await this.o.llm(persona(label, script, lastAgent));
            got = { text: live.text.trim(), stop: live.stop };
        }
        // A source hit is written to this run's tape too, so the run's tape holds every reply.
        this.o.tape.put({ key, event: t.id, label, digest, ...got });
        const source: "tape" | "live" = taped === undefined ? "live" : "tape";
        const hits = markerHits(got.text, this.o.keys);
        const cut = got.stop === "max_tokens" ? ["max_tokens"] : [];
        const empty = got.text === "" ? ["empty"] : [];
        const fallback = [...empty, ...cut, ...hits];
        if (fallback.length === 0) return { text: got.text, source };
        return { text: FALLBACK[label] ?? "", source, fallback };
    }
}

/** Sessions where two arms' delivered text differs before the recorded divergence index. */
export function pairingMismatches(
    records: readonly PairingRecord[],
    reference: (arm: string) => string,
): string[] {
    const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
    const byArm = new Map(turns.map((r) => [`${r.arm}/${r.event}`, r]));
    const diverged = new Map(
        records
            .filter((r): r is DivergenceRecord => r.kind === "divergedAt")
            .map((r) => [`${r.arm}/${r.session}`, r.index]),
    );
    return turns
        .filter((r) => r.arm !== reference(r.arm))
        .filter(
            (r) => r.index < (diverged.get(`${r.arm}/${r.session}`) ?? Number.POSITIVE_INFINITY),
        )
        .filter((r) => {
            const other = byArm.get(`${reference(r.arm)}/${r.event}`);
            return other !== undefined && other.text_sha256 !== r.text_sha256;
        })
        .map((r) => `${r.arm} ${r.session} #${r.index}`);
}
