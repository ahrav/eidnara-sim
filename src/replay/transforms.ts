import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConverseBody } from "../proxy/classify";
import type { Component } from "../proxy/records";
import type { GroundTruth } from "../scenario/compile";

/**
 * Replay-only delivery transforms. The replay proxy applies the declared transform to each agent
 * request of the replayed probe turn before it stores and forwards the body; campaign runs
 * construct their gateway without a transform, so these functions never shape a campaign call.
 * Adding a variant is one entry in `TRANSFORMS`.
 */

/** What a transform may read about the probe it rewrites. */
export interface TransformInputs {
    /** The probe's user text as the host sends it, before any marker the plugin adds. */
    probe_text: string;
    ground_truth: Pick<GroundTruth, "present" | "stale" | "absent">;
    /** The oracle note `oracleBackground` builds for the probe, or null when it names no source. */
    oracle_note: string | null;
    /** The short note built from the probe's ground-truth source events, or null without sources. */
    evidence_note: string | null;
    /** The probe's ground-truth source text as a `<project-memory>` block. */
    project_memory: string | null;
}

/** One application to one request: whether the body changed and what the transform did. */
export interface Applied {
    changed: boolean;
    detail: Record<string, unknown>;
}

export interface ReplayTransform {
    id: string;
    /** The letter the delivery-ablation plan names the variant by. */
    alias: string;
    summary: string;
    apply(body: ConverseBody, inputs: TransformInputs): Applied;
}

type Block = Record<string, unknown>;
type Message = { role: string; content: Block[] };

const EIDNARA_TOOL = /^eidnara_/;
/** The blocks Eidnara's daemon and plugin write into request text. */
const MEMORY_TAGS = [
    "project-memory",
    "memory-updates",
    "project-note",
    "eidnara-search-auto",
    "eidnara-search-hint",
];

/**
 * The probe's message: the last user message with a text block holding the probe text. Its
 * block index points at that text block.
 */
export function probeBlock(
    body: ConverseBody,
    probeText: string,
): { message: number; block: number } | null {
    const messages = (body.messages ?? []) as Message[];
    for (let m = messages.length - 1; m >= 0; m--) {
        const msg = messages[m] as Message;
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        const block = msg.content.findIndex(
            (b) => typeof b.text === "string" && (b.text as string).includes(probeText),
        );
        if (block >= 0) return { message: m, block };
    }
    return null;
}

/** Rewrites the probe text inside its block; returns false when the body holds no probe message. */
function rewriteProbe(
    body: ConverseBody,
    probeText: string,
    rewrite: (text: string) => string,
): boolean {
    const at = probeBlock(body, probeText);
    if (!at) return false;
    const block = (body.messages as Message[])[at.message]?.content[at.block] as Block;
    const text = block.text as string;
    const i = text.indexOf(probeText);
    block.text = text.slice(0, i) + rewrite(probeText) + text.slice(i + probeText.length);
    return true;
}

const TAGGED = new RegExp(`<(${MEMORY_TAGS.join("|")})((?:\\s[^>]*)?)>([\\s\\S]*?)</\\1>`, "g");

/**
 * Rewrites each text Eidnara delivered memory through: the text of an `eidnara_*` tool's result,
 * and the inside of each tagged block in the system prompt or a message. `edit` gets the tool or
 * tag name and the text, and returns the text to keep.
 */
function editMemory(body: ConverseBody, edit: (name: string, text: string) => string): void {
    const toolNames = new Map<string, string>();
    const messages = (body.messages ?? []) as Message[];
    const contents = messages.map((m) => (Array.isArray(m.content) ? m.content : []));
    for (const b of contents.flat()) {
        const use = b.toolUse as { toolUseId?: string; name?: string } | undefined;
        if (use?.toolUseId && use.name) toolNames.set(use.toolUseId, use.name);
    }
    const tagged = (b: Block) => {
        if (typeof b.text !== "string") return;
        b.text = (b.text as string).replace(
            TAGGED,
            (_, tag: string, attrs: string, inner: string) =>
                `<${tag}${attrs}>${edit(tag, inner)}</${tag}>`,
        );
    };
    for (const b of body.system ?? []) tagged(b);
    for (const b of contents.flat()) {
        const result = b.toolResult as { toolUseId?: string; content?: Block[] } | undefined;
        const name = result?.toolUseId ? toolNames.get(result.toolUseId) : undefined;
        if (!result || !name || !EIDNARA_TOOL.test(name)) {
            tagged(b);
            continue;
        }
        for (const c of result.content ?? []) {
            if (typeof c.text === "string") c.text = edit(name, c.text);
        }
    }
}

export type Segment = { line: string } | { item: string[] };

const ITEM_HEADER = /^\[\d+\] \[[a-z_-]+\]/;
const BULLET = /^- /;

export function splitListing(text: string): Segment[] {
    const lines = text.split("\n");
    const numbered = lines.some((l) => ITEM_HEADER.test(l));
    const segments: Segment[] = [];
    let current: string[] | null = null;
    for (const line of lines) {
        if (numbered ? ITEM_HEADER.test(line) : BULLET.test(line)) {
            current = numbered ? [line] : null;
            segments.push({ item: current ?? [line] });
        } else if (current && line !== "") {
            current.push(line);
        } else {
            current = null;
            segments.push({ line });
        }
    }
    return segments;
}

export const joinListing = (segments: Segment[]) =>
    segments.flatMap((s) => ("item" in s ? s.item : [s.line])).join("\n");

const itemsOf = (segments: Segment[]) => segments.flatMap((s) => ("item" in s ? [s.item] : []));

const quoteRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function carries(text: string, literal: string): boolean {
    if (literal.length === 0) return false;
    const pattern = /^\d+(?:\.\d+)?$/.test(literal)
        ? `(?<![\\d.])${quoteRe(literal)}(?![\\d.]*\\d)`
        : quoteRe(literal);
    return new RegExp(pattern, "i").test(text);
}

/** An item supports the ground truth when it carries a literal of every `present` group. */
const supports = (item: string, gt: TransformInputs["ground_truth"]) =>
    gt.present.length > 0 && gt.present.every((group) => group.some((l) => carries(item, l)));

const isStale = (item: string, gt: TransformInputs["ground_truth"]) =>
    [...gt.stale, ...gt.absent].some((l) => carries(item, l));

const carriesPresent = (text: string, gt: TransformInputs["ground_truth"]) =>
    gt.present.some((group) => group.some((l) => carries(text, l)));

const CAUTION = new RegExp(
    `\\b(?:${[
        "can['\u2019]?t confirm",
        "cannot confirm",
        "not confirmed",
        "unconfirmed",
        "unverified",
        "can['\u2019]?t verify",
        "not verified",
        "don['\u2019]?t (?:assume|deploy|guess|pick|choose)",
        "ask (?:before|first|the user|you)",
        "before (?:implementing|building|committing|I start)",
        "wait(?:ing)? (?:for|on) (?:you|the user|your)",
        "still (?:open|pending|unanswered|waiting)",
        "haven['\u2019]?t (?:decided|made a decision)",
        "no decision",
        "needs? (?:your|the user['\u2019]?s) (?:confirmation|decision|approval)",
        "approval",
        "go-ahead",
        "say-so",
        "undecided",
        "never got an answer",
        "not (?:yet )?answered",
    ].join("|")})\\b`,
    "i",
);

const USER_STATED = /^(?:- )?(?:User|The user) (?:stated|said|wrote|noted)\b/;

const statementOf = (item: string[], numbered: boolean) =>
    (numbered ? item.slice(1) : item).filter((l) => !isProvenanceLine(l));

function isCautionItem(item: string[], numbered: boolean): boolean {
    const statement = statementOf(item, numbered);
    return !USER_STATED.test(statement[0] ?? "") && CAUTION.test(statement.join("\n"));
}

function stripCaution(
    item: string[],
    gt: TransformInputs["ground_truth"],
): { item: string[]; removed: number } {
    let removed = 0;
    const out: string[] = [item[0] as string];
    for (const line of item.slice(1)) {
        if (isProvenanceLine(line)) {
            out.push(line);
            continue;
        }
        const sentences = line.split(/(?<=[.!?;])\s+/);
        const kept = sentences.filter((s) => !(CAUTION.test(s) && !carriesPresent(s, gt)));
        removed += sentences.length - kept.length;
        if (kept.length > 0) out.push(kept.join(" "));
    }
    return { item: out, removed };
}

/**
 * Drops each stale item (one carrying a `stale` or `absent` literal) and, in a listing that holds
 * a supporting item, every item that does not support the ground truth. A numbered listing is
 * renumbered from 1 and its count line follows the kept items.
 */
function dropCompeting(body: ConverseBody, inputs: TransformInputs, caution = false): Applied {
    const gt = inputs.ground_truth;
    const slots: Record<string, unknown>[] = [];
    const unparsed: string[] = [];
    let changed = false;
    editMemory(body, (name, text) => {
        const segments = splitListing(text);
        const items = itemsOf(segments);
        if (items.length === 0) {
            unparsed.push(name);
            return text;
        }
        const numbered = items.some((i) => ITEM_HEADER.test(i[0] ?? ""));
        const texts = items.map((i) => i.join("\n"));
        const anySupport = texts.some((t) => supports(t, gt));
        let cautionDropped = 0;
        const keep = new Map(
            items.map((item, i) => {
                const t = texts[i] as string;
                const competing = isStale(t, gt) || (anySupport && !supports(t, gt));
                const cautious =
                    caution && !competing && !supports(t, gt) && isCautionItem(item, numbered);
                if (cautious) cautionDropped++;
                return [item, !competing && !cautious] as const;
            }),
        );
        const rewritten = new Map<string[], string[]>();
        let sentences = 0;
        if (caution && numbered) {
            for (const item of items) {
                if (!keep.get(item) || !isCautionItem(item, numbered)) continue;
                const stripped = stripCaution(item, gt);
                if (stripped.removed === 0) continue;
                sentences += stripped.removed;
                rewritten.set(item, stripped.item);
            }
        }
        const dropped = [...keep.values()].filter((k) => !k).length;
        slots.push({
            slot: name,
            items: items.length,
            dropped,
            supporting: anySupport,
            ...(caution ? { caution_dropped: cautionDropped, caution_sentences: sentences } : {}),
        });
        if (dropped === 0 && sentences === 0) return text;
        changed = true;
        const kept: Segment[] = [];
        let n = 0;
        let skipBlank = false;
        for (const s of segments) {
            if ("item" in s && !keep.get(s.item)) {
                skipBlank = true;
                continue;
            }
            if ("line" in s && skipBlank && s.line === "") {
                skipBlank = false;
                continue;
            }
            skipBlank = false;
            if ("item" in s) {
                n++;
                const [first, ...rest] = rewritten.get(s.item) ?? s.item;
                kept.push({ item: [(first as string).replace(/^\[\d+\]/, `[${n}]`), ...rest] });
            } else {
                kept.push(s);
            }
        }
        const first = kept.findIndex((s) => "item" in s);
        const opening = first < 0 ? kept.length : first;
        const count = /\b\d+( (?:results?|related fragments?)\b)/;
        return joinListing(
            kept.map((s, i) =>
                "line" in s && i < opening ? { line: s.line.replace(count, `${n}$1`) } : s,
            ),
        );
    });
    return { changed, detail: { slots, unparsed } };
}

const ATTRIBUTION =
    /^(?:User|Assistant|The user|The assistant) (?:stated|reported|said|wrote|noted): /;
const TRUST = / trust=\[[^\]]*\]/;
const NOTICE = /^(\u00a7\d+\u00a7)? ?Memory: /;
const SEARCH_TOOL = "eidnara_search";

/** A provenance record line: a JSON object naming the memory's citation or capture source. */
const PROVENANCE_KEYS = ["anchor", "citation", "quote", "source"];

function isProvenanceLine(line: string): boolean {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) return false;
    try {
        const v = JSON.parse(t) as Record<string, unknown>;
        return (
            typeof v === "object" &&
            v !== null &&
            !Array.isArray(v) &&
            PROVENANCE_KEYS.every((k) => typeof v[k] === "string")
        );
    } catch {
        return false;
    }
}

/**
 * Removes Eidnara's provenance wording from each delivered memory item: the `trust=[...]` label
 * on its header, the attribution that opens its statement, and its JSON provenance record.
 */
function provenanceOff(body: ConverseBody, notices = false): Applied {
    let changed = false;
    const counts: { trust: number; attribution: number; records: number; notices?: number } = {
        trust: 0,
        attribution: 0,
        records: 0,
    };
    if (notices) counts.notices = 0;
    const unparsed: string[] = [];
    editMemory(body, (name, text) => {
        const segments = splitListing(text);
        const stripNotices = notices && name === SEARCH_TOOL;
        if (itemsOf(segments).length === 0) {
            unparsed.push(name);
            if (!stripNotices) return text;
        }
        const scrub = (item: string[]) => {
            const out: string[] = [];
            item.forEach((line, i) => {
                if (i > 0 && i === item.length - 1 && isProvenanceLine(line)) {
                    counts.records++;
                    return;
                }
                let l = line;
                if (i === 0 && TRUST.test(l)) {
                    l = l.replace(TRUST, "");
                    counts.trust++;
                }
                if (i === 1 && ATTRIBUTION.test(l)) {
                    l = l.replace(ATTRIBUTION, "");
                    counts.attribution++;
                }
                out.push(l);
            });
            return out;
        };
        const unnoticed = (s: Segment): Segment[] => {
            if (!stripNotices || !("line" in s)) return [s];
            const m = NOTICE.exec(s.line);
            if (!m) return [s];
            counts.notices = (counts.notices ?? 0) + 1;
            return m[1] ? [{ line: m[1] }] : [];
        };
        const next = joinListing(
            segments.flatMap((s) => ("item" in s ? [{ item: scrub(s.item) }] : unnoticed(s))),
        );
        if (next !== text) changed = true;
        return next;
    });
    return { changed, detail: { ...counts, unparsed } };
}

const M0_END = "</session-history>";

function injectProjectMemory(body: ConverseBody, inputs: TransformInputs): Applied {
    const block = inputs.project_memory;
    if (block === null) return { changed: false, detail: { reason: "no sources" } };
    const first = (body.messages ?? [])[0] as Message | undefined;
    const content = first?.role === "user" && Array.isArray(first.content) ? first.content : [];
    const m0 = content.find((b) => typeof b.text === "string" && b.text.includes(M0_END));
    if (!m0) return { changed: false, detail: { reason: "no m0 region" } };
    if ((m0.text as string).includes("<project-memory>")) {
        return { changed: false, detail: { reason: "m0 region holds a project-memory block" } };
    }
    m0.text = `${m0.text as string}\n\n${block}`;
    return { changed: true, detail: { bytes: Buffer.byteLength(block) } };
}

export const TRANSFORMS: Record<string, ReplayTransform> = {
    none: {
        id: "none",
        alias: "a",
        summary: "forwards each request unchanged; the replay-noise baseline",
        apply: () => ({ changed: false, detail: {} }),
    },
    "evidence-note": {
        id: "evidence-note",
        alias: "b",
        summary: "appends the probe's ground-truth source text as a short note after the prompt",
        apply(body, inputs) {
            const note = inputs.evidence_note;
            if (note === null) return { changed: false, detail: { reason: "no sources" } };
            const changed = rewriteProbe(body, inputs.probe_text, (t) => `${t}\n\n${note}`);
            return { changed, detail: changed ? {} : { reason: "no probe message" } };
        },
    },
    "drop-competing": {
        id: "drop-competing",
        alias: "c",
        summary:
            "removes stale items and items that compete with a supporting one from Eidnara-delivered memory",
        apply: dropCompeting,
    },
    "drop-competing-caution": {
        id: "drop-competing-caution",
        alias: "c2",
        summary:
            "drop-competing, plus caution items that do not support the ground truth and caution sentences of kept items",
        apply: (body, inputs) => dropCompeting(body, inputs, true),
    },
    "provenance-off": {
        id: "provenance-off",
        alias: "d",
        summary: "removes Eidnara's provenance wording from delivered memory items",
        apply: (body) => provenanceOff(body),
    },
    "provenance-notices-off": {
        id: "provenance-notices-off",
        alias: "d2",
        summary: "provenance-off, plus the daemon's `Memory:` notice lines in search results",
        apply: (body) => provenanceOff(body, true),
    },
    "oracle-note": {
        id: "oracle-note",
        alias: "e",
        summary: "puts the host-oracle arm's note ahead of the probe text",
        apply(body, inputs) {
            const note = inputs.oracle_note;
            if (note === null) return { changed: false, detail: { reason: "no sources" } };
            const changed = rewriteProbe(body, inputs.probe_text, (t) => `${note}${t}`);
            return { changed, detail: changed ? {} : { reason: "no probe message" } };
        },
    },
    "memory-block": {
        id: "memory-block",
        alias: "f",
        summary:
            "appends the probe's ground-truth source text as a <project-memory> block to the m0 region",
        apply: injectProjectMemory,
    },
};

/** The transform a variant name or letter selects. */
export function transformFor(variant: string): ReplayTransform {
    const found = Object.hasOwn(TRANSFORMS, variant)
        ? TRANSFORMS[variant]
        : Object.values(TRANSFORMS).find((t) => t.alias === variant);
    if (!found) {
        const known = Object.values(TRANSFORMS)
            .map((t) => `${t.alias}=${t.id}`)
            .join(", ");
        throw new Error(`unknown replay variant ${variant}; known: ${known}`);
    }
    return found;
}

const SOURCE = new URL("./transforms.ts", import.meta.url);

type SourceEvent = Record<string, unknown> & { id: string };

/**
 * evidenceNote quotes the probe's ground-truth source events in the user's voice and in scenario
 * order. Committed-file fences use max(3, longest backtick run + 1) backticks, so backticks in
 * the file stay inside the block.
 */
export function evidenceNote(
    events: readonly Record<string, unknown>[],
    sources: readonly string[],
): string | null {
    const order = new Map(events.map((e, i) => [String(e.id), i]));
    const picked = sources
        .map((id) => events[order.get(id) ?? -1] as SourceEvent | undefined)
        .filter((e): e is SourceEvent => e !== undefined)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    if (picked.length === 0) return null;
    const lines = picked.map((e) => {
        if (e.kind === "user_turn") {
            return `- I wrote: ${String(e.text ?? "")
                .replace(/\s*\n\s*/g, " ")
                .trim()}`;
        }
        if (e.remove === true) return `- ${String(e.path)} was removed from the repository.`;
        const content = String(e.content ?? "").replace(/\n$/, "");
        const run = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(Math.max(3, run + 1));
        return `- ${String(e.path)} was committed with:\n${fence}\n${content}\n${fence}`;
    });
    return `Note from earlier sessions:\n${lines.join("\n")}`;
}

const MEMORY_CATEGORY: Record<string, string> = {
    P1: "PROJECT_RULES",
    P3: "CONSTRAINTS",
    P4: "PROJECT_RULES",
    P6: "USER_DIRECTIVES",
    P8: "CONFIG_VALUES",
    P12: "CONFIG_VALUES",
};

const escapeXml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function projectMemoryBlock(
    events: readonly Record<string, unknown>[],
    sources: readonly string[],
    probeType: string,
): string | null {
    const byId = new Map(events.map((e) => [String(e.id), e]));
    const picked = sources
        .map((id) => byId.get(id))
        .filter((e): e is Record<string, unknown> => e !== undefined);
    if (picked.length === 0) return null;
    const rows = picked.map((e) => {
        const content =
            e.kind === "user_turn"
                ? `User stated: ${String(e.text ?? "")
                      .replace(/\s*\n\s*/g, " ")
                      .trim()}`
                : e.remove === true
                  ? `${String(e.path)} was removed from the repository.`
                  : `${String(e.path)} was committed with:\n${String(e.content ?? "").replace(/\n$/, "")}`;
        const digest = createHash("sha256")
            .update(`${String(e.id)}\n${content}`)
            .digest("hex");
        const id = `mem_${digest.slice(0, 32)}`;
        return { id, line: `${id}: ${escapeXml(content).split("\n").join("\n  ")}` };
    });
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const category = MEMORY_CATEGORY[probeType] ?? "PROJECT_RULES";
    return [
        "<project-memory>",
        `<${category}>`,
        ...rows.map((r) => r.line),
        `</${category}>`,
        "</project-memory>",
    ].join("\n");
}

/**
 * Binds the variant to the transform code and the inputs it reads, so two replays with one
 * digest applied the same rewrite.
 */
export function transformDigest(t: ReplayTransform, inputs: TransformInputs): string {
    const code = createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
    return createHash("sha256")
        .update(JSON.stringify({ id: t.id, code, inputs }))
        .digest("hex");
}

/** The only component a replay transform rewrites: the agent's own calls. */
export const TRANSFORMED: Component = "agent";
