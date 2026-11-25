import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { piSessionFiles } from "../evidence/load";
import { carries } from "../grade/text";
import type { ConverseBody } from "../proxy/classify";
import type { HeldCall } from "../run/calllog";
import type { ChangeKind, CitedSpan, DaemonClock, ReviewerChange } from "./changes";
import {
    eventText,
    factsOf,
    type factTimeline,
    inForceReading,
    type ReviewScenario,
} from "./truth";

/** One reference a stage-2 review request showed its model, as the host labelled it. */
export interface Reference {
    alias: string;
    writer: "user" | "assistant" | "tool" | "repository file" | "unrecorded";
    /** The time the host gave for the message, on the daemon's clock; null when its label holds none. */
    at_ms: number | null;
    /** How the host places it against the memory's source: the source itself, written after it, or written before it. */
    relation: "source" | "later" | "earlier";
    text: string;
}

/** One stage-2 request of the memory reviewer as the gateway recorded it. */
export interface ReviewRequest {
    seq: number;
    /** The wall time the call ended. */
    ended_wall_ms: number;
    /** The memory under review: the text of `ref-1`. */
    memory: string;
    references: Map<string, Reference>;
}

/** A reference's line as the host writes it: the writer, a time when the host knows one, and the relation. */
const LABEL =
    /^(?:a message (?:the (user|assistant)|a (tool|repository file)) wrote|a source of (unrecorded) origin)(?: at (\S+))?; (?:(the memory cites it as its source)|written (after|before) the memory's source)$/;

/**
 * The references of one stage-2 request text: the bytes between each pair of host markers, and
 * each one's label from the list that follows the memory's own bytes, so a memory that holds a
 * line shaped like the list names no reference.
 */
export function parseReferences(
    user: string,
): { memory: string; references: Map<string, Reference> } | null {
    const first = /^\[ref-1 ([0-9a-f]+)\]\n/.exec(user);
    if (!first) return null;
    const token = first[1] as string;
    const bodies = new Map<string, string>();
    const marker = new RegExp(
        `^\\[(ref-\\d+) ${token}\\]\\n([\\s\\S]*?)\\n\\[/\\1 ${token}\\]$`,
        "gm",
    );
    for (const m of user.matchAll(marker)) bodies.set(m[1] as string, m[2] as string);
    const memory = bodies.get("ref-1");
    if (memory === undefined) return null;
    const references = new Map<string, Reference>();
    const close = `\n[/ref-1 ${token}]`;
    const after = user.slice(user.indexOf(close) + close.length);
    const listed = /\nlinked references:\n([\s\S]*?)\n\n/.exec(after)?.[1] ?? "";
    for (const line of listed.split("\n")) {
        const [, alias, label] = /^(ref-\d+): (.*)$/.exec(line) ?? [];
        const text = alias === undefined ? undefined : bodies.get(alias);
        const m = label === undefined ? null : LABEL.exec(label);
        if (alias === undefined || text === undefined || !m) continue;
        const at = m[4] === undefined ? Number.NaN : Date.parse(m[4]);
        references.set(alias, {
            alias,
            writer: (m[1] ?? m[2] ?? m[3]) as Reference["writer"],
            at_ms: Number.isFinite(at) ? at : null,
            relation: m[5] ? "source" : m[6] === "after" ? "later" : "earlier",
            text,
        });
    }
    return { memory, references };
}

const blockText = (content: unknown): string =>
    (Array.isArray(content) ? content : [])
        .map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : ""))
        .join("\n");

/** The stage-2 review requests of `arm`, in call order; `bodyOf` rebuilds a call's stored request. */
export function reviewRequests(
    calls: readonly HeldCall[],
    bodyOf: (position: number) => ConverseBody | null,
    arm: string,
): ReviewRequest[] {
    const out: ReviewRequest[] = [];
    calls.forEach((call, position) => {
        if (call.arm !== arm || call.component !== "memory_reviewer_stage2") return;
        const messages = bodyOf(position)?.messages ?? [];
        const user = messages
            .filter((m) => m.role === "user")
            .map((m) => blockText(m.content))
            .join("\n\n");
        const read = parseReferences(user);
        if (read) out.push({ seq: call.seq, ended_wall_ms: call.wall_ms, ...read });
    });
    return out;
}

/**
 * The request that produced a change: the last stage-2 request for the change's memory text that
 * ended by the change's commit, at wall time `commitWallMs`, and holds every alias the applied
 * proposal cites.
 */
export function requestOf(
    change: ReviewerChange,
    requests: readonly ReviewRequest[],
    commitWallMs: number,
): ReviewRequest | null {
    const cited = change.proposal?.contradictions ?? [];
    return (
        requests
            .filter(
                (r) =>
                    r.memory === change.text &&
                    r.ended_wall_ms <= commitWallMs &&
                    cited.every((c) => r.references.has(c.alias)),
            )
            .at(-1) ?? null
    );
}

/** One entry of a session transcript. */
export interface Spoken {
    at_ms: number;
    session: string;
    speaker: "user" | "assistant" | "tool call" | "tool output";
    /** The tool's name, on a call and on its output. */
    name?: string;
    text: string;
}

/**
 * Pi's session transcripts under `sessionsDir` as entries in time order: user messages, assistant
 * text, tool calls with their arguments, and tool outputs, each with the time Pi recorded. Null
 * when the directory is absent or lies behind a link.
 */
export function readConversation(sessionsDir: string, within: string): Spoken[] | null {
    const files = piSessionFiles(sessionsDir, within);
    if (!files) return null;
    const out: Spoken[] = [];
    for (const path of files) {
        const session = /_sim-(.+)\.jsonl$/.exec(basename(path))?.[1];
        if (!session) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line.includes('"message"')) continue;
            let entry: { type?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            const m = entry.message;
            const at =
                typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
            if (entry.type !== "message" || !m || !Number.isFinite(at)) continue;
            const blocks = (Array.isArray(m.content) ? m.content : []) as Record<string, unknown>[];
            const text = blocks
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text as string)
                .join("\n");
            const say = (speaker: Spoken["speaker"], text: string, name?: string) =>
                out.push({ at_ms: at, session, speaker, text, ...(name ? { name } : {}) });
            if (m.role === "user") say("user", text);
            else if (m.role === "toolResult") say("tool output", text, String(m.toolName ?? ""));
            else if (m.role === "assistant") {
                if (text.trim() !== "") say("assistant", text);
                for (const b of blocks.filter((b) => b?.type === "toolCall")) {
                    say("tool call", JSON.stringify(b.arguments ?? {}), String(b.name ?? ""));
                }
            }
        }
    }
    // A stable sort keeps a file's own order for entries of one millisecond.
    return out.sort((a, b) => a.at_ms - b.at_ms);
}

/** What the labeller's view cuts each text to, in characters. */
export const VIEW_LIMITS = {
    row: 6_000,
    cited: 6_000,
    user: 3_000,
    assistant: 1_800,
    tool_call: 300,
    tool_output: 400,
    conversation: 36_000,
    conversation_head: 9_000,
    conversation_tail: 18_000,
    conversation_middle: 6_000,
    middle_user: 500,
    scenario_event: 700,
    /** How far before an uncited row's storing the conversation starts, in milliseconds. */
    uncited_lead_ms: 900_000,
} as const;
/** Changes whenever the view's text for the same inputs changes, so a stored label names its view. */
export const VIEW_VERSION = "sim-reviewer-view/v1";

/** `text` cut to `max` characters: its start and its end around a marked cut. */
export function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.7);
    const tail = max - head;
    return `${text.slice(0, head)} [... ${text.length - max} characters cut ...] ${text.slice(text.length - tail)}`;
}

const ARM_PATH = /(?:\/[\w.@+~-]+)+\/r\/(workspaces|home)\//g;

/**
 * Text as the labeller reads it: block tags removed, every workspace or home path of an arm
 * shortened to its last part, the run directory's name and each arm's name replaced whole, the
 * arm token replaced, and a run of three or more `<` or `>` spaced apart so the view's own frames
 * stay distinct. `names` lists the run directory's name and then the run's arm names. The path
 * rule reads only the lines that hold an arm path, so a long text without one costs one scan.
 */
export function blindText(text: string, names: readonly string[]): string {
    const [run = "", ...arms] = names;
    let out = text.replace(/§\d+§ ?/g, "");
    if (out.includes("/r/workspaces/") || out.includes("/r/home/")) {
        out = out
            .split("\n")
            .map((line) => (line.includes("/r/") ? line.replace(ARM_PATH, "/$1/") : line))
            .join("\n");
    }
    if (run !== "") out = out.replaceAll(run, "run");
    // A longer arm name goes first, so `eidnara-reviewer` is replaced before `eidnara`.
    for (const arm of [...arms].sort((a, b) => b.length - a.length)) {
        if (arm !== "") out = out.replaceAll(arm, "arm");
    }
    return out
        .replace(/eidnara/gi, "memtool")
        .replace(/<{3,}|>{3,}/g, (marks) => marks.split("").join(" "));
}

/** A transcript's entries with every text and tool name blinded, once for all the views that read them. */
export const blindConversation = (
    entries: readonly Spoken[],
    blinded: (text: string) => string,
): Spoken[] =>
    entries.map((e) => ({
        ...e,
        text: blinded(e.text),
        ...(e.name === undefined ? {} : { name: blinded(e.name) }),
    }));

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

const KIND_TEXT: Record<ChangeKind, string> = {
    disputed: "dispute (the whole row is marked disputed)",
    contested: "contest mark (the row stays and carries a mark that names a later statement)",
    retired: "retirement (the row is removed)",
    revised: "revision (the row's text is replaced)",
    created: "new row (the reviewer wrote a row of its own)",
};
const WRITER_TEXT: Record<Reference["writer"], string> = {
    user: "user message",
    assistant: "assistant message",
    tool: "tool output",
    "repository file": "repository file",
    unrecorded: "source of unrecorded origin",
};
/**
 * A line inside an entry that opens as one of the view's own lines does: an entry's time and
 * speaker, a section's heading, or the answer line. Such a line is marked, so text an agent wrote
 * reads as that entry's text and never as a turn of the user or a section of the view.
 */
const FRAME_LINE =
    /(?<=\n)(?=\[\d{4}-\d\d-\d\dT[\d:]{8}Z\] (?:USER|ASSISTANT|TOOL OUTPUT)|(?:TARGET ROW|CHANGE)(?:\n|$)|CITED LATER (?:SOURCE|STATEMENT)|CONVERSATION \(|SCENARIO RECORD \(|Answer with exactly one letter)/g;

/** The passage of a reference a span cites: its byte range, or the whole text without one. */
function passage(text: string, span: CitedSpan): { text: string; whole: boolean } {
    const bytes = Buffer.from(text, "utf8");
    if (span.start === null || span.end === null || (span.start <= 0 && span.end >= bytes.length)) {
        return { text, whole: true };
    }
    return {
        text: bytes.subarray(Math.max(0, span.start), span.end).toString("utf8"),
        whole: false,
    };
}

/** The entries of the conversation as lines, cut to the view's budget with the cut marked. */
function conversationText(entries: readonly Spoken[]): string {
    const L = VIEW_LIMITS;
    const line = (e: Spoken, userMax: number = L.user): string => {
        const at = `[${iso(e.at_ms)}]`;
        const text = e.text.replace(FRAME_LINE, "| ");
        if (e.speaker === "user") return `${at} USER: ${clip(text, userMax)}`;
        if (e.speaker === "assistant") return `${at} ASSISTANT: ${clip(text, L.assistant)}`;
        if (e.speaker === "tool call") {
            return `${at} ASSISTANT CALLED ${e.name}: ${clip(text, L.tool_call)}`;
        }
        return `${at} TOOL OUTPUT (${e.name}): ${clip(text, L.tool_output)}`;
    };
    const lines = entries.map((e) => line(e));
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    if (total <= L.conversation) return lines.join("\n");
    let head = 0;
    for (let used = 0; head < lines.length; head++) {
        used += (lines[head] as string).length + 1;
        if (used > L.conversation_head) break;
    }
    let tail = lines.length;
    for (let used = 0; tail > head; tail--) {
        used += (lines[tail - 1] as string).length + 1;
        if (used > L.conversation_tail) break;
    }
    // Between the two ends the user's messages stay, each cut short: the newest that fit.
    const middle: string[] = [];
    let used = 0;
    for (let i = tail - 1; i >= head; i--) {
        const e = entries[i] as Spoken;
        if (e.speaker !== "user") continue;
        const short = line(e, L.middle_user);
        if (used + short.length + 1 > L.conversation_middle) break;
        used += short.length + 1;
        middle.unshift(short);
    }
    const cut = tail - head - middle.length;
    return [
        ...lines.slice(0, head),
        `[... ${cut} entries cut; the user's messages among them follow, shortened ...]`,
        ...middle,
        "[... the record continues ...]",
        ...lines.slice(tail),
    ].join("\n");
}

const EVENT_TEXT: Record<string, string> = {
    conveyance: "the user stated",
    reversal: "the user stated (a first value)",
    update: "the user changed it",
    status: "the user closed the plan",
};

/**
 * The scenario's record of a row's subject up to wall time `atWallMs`: for each fact line the row
 * restates (`inForceReading`) or whose value literal stands in the row as a whole token, the
 * events of the line the arm received by then, in order, each with the plan step it set and with
 * a mark where the scenario records it as replacing the line's earlier statement.
 */
export function scenarioRecord(
    text: string,
    atWallMs: number,
    scenario: ReviewScenario,
    timeline: ReturnType<typeof factTimeline>,
    delivered: Map<string, number>,
    clock: DaemonClock,
    blinded: (text: string) => string = (text) => text,
): string {
    const facts = new Map(scenario.facts.map((f) => [f.id, f]));
    const lines = new Set(
        inForceReading(text, atWallMs, scenario, delivered).statements.map((s) => s.line),
    );
    for (const [line, g] of timeline) {
        if (g.literals.some((literal) => carries(text, literal))) lines.add(line);
    }
    const steps = new Map(
        (scenario.plans ?? []).flatMap((p) => p.history.map((h) => [h.event, h.status] as const)),
    );
    const received = (id: string) => delivered.get(id) ?? Number.POSITIVE_INFINITY;
    const out: string[] = [];
    for (const line of [...lines].sort()) {
        const seen = new Set<string>();
        const rows = scenario.events
            .filter(
                (e) =>
                    !(e.kind === "user_turn" && (e.role === "probe" || e.role === "filler")) &&
                    factsOf(e).some((id) => facts.get(id)?.line === line) &&
                    received(e.id) <= atWallMs,
            )
            .sort((a, b) => received(a.id) - received(b.id));
        if (rows.length === 0) continue;
        out.push(`Subject ${line}:`);
        for (const e of rows) {
            const fact = factsOf(e)
                .map((id) => facts.get(id))
                .find((f) => f?.line === line);
            const first = fact !== undefined && !seen.has(fact.id);
            if (fact) seen.add(fact.id);
            const what =
                e.kind === "apply_diff"
                    ? "the user committed a file"
                    : (EVENT_TEXT[e.role ?? ""] ?? "the user wrote");
            const marks = [
                ...(steps.has(e.id) ? [`plan ${steps.get(e.id)}`] : []),
                ...(first && fact?.supersedes
                    ? ["replaces the earlier statement on this subject"]
                    : []),
            ];
            const at = iso(clock.daemon(received(e.id)));
            const body = clip(blinded(eventText(e)), VIEW_LIMITS.scenario_event);
            out.push(`[${at}] ${what}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}: ${body}`);
        }
    }
    return out.length > 0
        ? out.join("\n")
        : "none (the scenario scripts no statement on this row's subject before the change)";
}

/** What one change's view is built from. */
export interface ViewInputs {
    change: ReviewerChange;
    /** The wall time of the change's commit. */
    wallMs: number;
    /** The stage-2 request that produced the change. */
    request: ReviewRequest;
    /**
     * The arm's session entries, already blinded (`blindConversation`), or null for a host whose
     * transcripts the harness leaves unread.
     */
    conversation: readonly Spoken[] | null;
    scenario: ReviewScenario;
    timeline: ReturnType<typeof factTimeline>;
    delivered: Map<string, number>;
    clock: DaemonClock;
    blinded: (text: string) => string;
}

/**
 * The labeller's view of one change, as text: the target row with its writer and times, the
 * change, each cited later source with its writer and time, the conversation of the row's
 * project from the row's time to the change, and the scenario's record of the row's subject.
 * Times are the daemon's clock. The view holds nothing written after the change.
 */
export function changeView(o: ViewInputs): string {
    const { change, request, scenario, clock, blinded } = o;
    const source = [...request.references.values()].find((r) => r.relation === "source");
    const cited = (change.proposal?.contradictions ?? []).flatMap((span) => {
        const ref = request.references.get(span.alias);
        return ref ? [{ ref, ...passage(ref.text, span) }] : [];
    });
    const writer = (ref: Reference) =>
        ref.writer === "user" || ref.writer === "assistant"
            ? `a message the ${ref.writer} wrote`
            : `a ${WRITER_TEXT[ref.writer]}`;
    const from = source
        ? `${writer(source)}${source.at_ms === null ? "" : ` at ${iso(source.at_ms)}`}`
        : "no source recorded";
    const parts = [
        "TARGET ROW",
        `Writer kind: ${change.target_kind}`,
        `Captured from: ${from}`,
        `Stored at: ${change.stored_ms === null ? "not recorded" : iso(change.stored_ms)}`,
        `Text:\n<<<\n${clip(blinded(change.text), VIEW_LIMITS.row)}\n>>>`,
        "",
        "CHANGE",
        `Kind: ${KIND_TEXT[change.kind]}`,
        `Written at: ${iso(change.recorded_ms)}`,
        ...(change.kind === "revised" && change.proposal?.new_text
            ? [`New text:\n<<<\n${clip(blinded(change.proposal.new_text), VIEW_LIMITS.row)}\n>>>`]
            : []),
    ];
    if (change.contested_by) {
        parts.push(
            "",
            "CITED LATER STATEMENT (the row the mark names)",
            `<<<\n${clip(blinded(change.contested_by.text), VIEW_LIMITS.cited)}\n>>>`,
        );
    }
    cited.forEach(({ ref, text, whole }, i) => {
        const length = whole
            ? ""
            : ` (the cited passage of a source of ${ref.text.length} characters)`;
        const none =
            ref.writer === "tool" ? "the host records none for a tool output" : "not recorded";
        parts.push(
            "",
            `CITED LATER SOURCE ${i + 1} of ${cited.length}`,
            `Writer: ${WRITER_TEXT[ref.writer]}`,
            `Time: ${ref.at_ms === null ? none : iso(ref.at_ms)}`,
            `Text${length}:\n<<<\n${clip(blinded(text), VIEW_LIMITS.cited)}\n>>>`,
        );
    });
    if (cited.length === 0 && !change.contested_by) {
        parts.push("", "CITED LATER SOURCE", "none recorded for this change");
    }
    // The conversation runs from the row's source, or from a lead before an uncited row was
    // stored, and from an earlier cited source when one precedes both, to the change.
    const rowAt =
        source?.at_ms ?? (change.stored_ms ?? change.recorded_ms) - VIEW_LIMITS.uncited_lead_ms;
    const start =
        Math.min(rowAt, ...cited.flatMap(({ ref }) => (ref.at_ms === null ? [] : [ref.at_ms]))) -
        1_000;
    const sessions = new Set(
        scenario.sessions.filter((s) => s.project === change.project).map((s) => `${s.id}`),
    );
    parts.push(
        "",
        `CONVERSATION (the project's sessions from ${iso(start)} to the change, oldest first)`,
    );
    if (o.conversation === null) parts.push("not recorded for this host");
    else {
        const between = o.conversation.filter(
            (e) => sessions.has(e.session) && e.at_ms >= start && e.at_ms <= change.recorded_ms,
        );
        parts.push(between.length > 0 ? conversationText(between) : "no entry in this span");
    }
    parts.push(
        "",
        "SCENARIO RECORD (the scripted user's statements on the row's subject, up to the change)",
        scenarioRecord(change.text, o.wallMs, scenario, o.timeline, o.delivered, clock, blinded),
    );
    return parts.join("\n");
}
