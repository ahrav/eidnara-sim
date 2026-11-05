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

/**
 * A memory listing split into a head and items. An item opens at a numbered header such as
 * `[1] [memory] score=0.33 id=...` or at a `- ` bullet, and runs to the next item or a line
 * that leaves the listing.
 */
interface Listing {
    head: string[];
    items: string[][];
    tail: string[];
}

const ITEM_HEADER = /^\[\d+\] \[[a-z_-]+\]/;
const BULLET = /^- /;

export function splitListing(text: string): Listing {
    const lines = text.split("\n");
    const head: string[] = [];
    const items: string[][] = [];
    const tail: string[] = [];
    const numbered = lines.some((l) => ITEM_HEADER.test(l));
    const opens = (l: string) => (numbered ? ITEM_HEADER.test(l) : BULLET.test(l));
    let current: string[] | null = null;
    for (const line of lines) {
        if (opens(line)) {
            current = [line];
            items.push(current);
        } else if (current && (numbered || BULLET.test(line))) {
            current.push(line);
        } else if (current) {
            // A bullet listing ends at its first line that is not a bullet.
            tail.push(line);
            current = null;
        } else if (items.length > 0) {
            tail.push(line);
        } else {
            head.push(line);
        }
    }
    return { head, items, tail };
}

const joinListing = (l: Listing) => [...l.head, ...l.items.flat(), ...l.tail].join("\n");

const quoteRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, with a number matched as a whole value, as the scenario's exposure checks compare. */
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

/**
 * Drops each stale item (one carrying a `stale` or `absent` literal) and, in a listing that holds
 * a supporting item, every item that does not support the ground truth. A numbered listing is
 * renumbered from 1 and its count line follows the kept items.
 */
function dropCompeting(body: ConverseBody, inputs: TransformInputs): Applied {
    const gt = inputs.ground_truth;
    const slots: Record<string, unknown>[] = [];
    let changed = false;
    editMemory(body, (name, text) => {
        const listing = splitListing(text);
        if (listing.items.length === 0) return text;
        const texts = listing.items.map((i) => i.join("\n"));
        const anySupport = texts.some((t) => supports(t, gt));
        const keep = texts.map((t) => !isStale(t, gt) && (!anySupport || supports(t, gt)));
        const dropped = keep.filter((k) => !k).length;
        slots.push({ slot: name, items: texts.length, dropped, supporting: anySupport });
        if (dropped === 0) return text;
        changed = true;
        let n = 0;
        listing.items = listing.items
            .filter((_, i) => keep[i])
            .map(([first, ...rest]) => {
                n++;
                return [(first as string).replace(/^\[\d+\]/, `[${n}]`), ...rest];
            });
        listing.head = listing.head.map((l) =>
            l.replace(/\b\d+( (?:results?|related fragments?)\b)/, `${n}$1`),
        );
        return joinListing(listing);
    });
    return { changed, detail: { slots } };
}

const ATTRIBUTION =
    /^(?:User|Assistant|The user|The assistant) (?:stated|reported|said|wrote|noted): /;
const TRUST = / trust=\[[^\]]*\]/;

/** A provenance record line: a JSON object naming the memory's citation or capture source. */
function isProvenanceLine(line: string): boolean {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) return false;
    try {
        const v = JSON.parse(t) as Record<string, unknown>;
        return typeof v === "object" && v !== null && ("citation" in v || "source" in v);
    } catch {
        return false;
    }
}

/**
 * Removes Eidnara's provenance wording from each delivered memory item: the `trust=[...]` label
 * on its header, the attribution that opens its statement, and its JSON provenance record.
 */
function provenanceOff(body: ConverseBody): Applied {
    let changed = false;
    const counts = { trust: 0, attribution: 0, records: 0 };
    editMemory(body, (_, text) => {
        const listing = splitListing(text);
        if (listing.items.length === 0) return text;
        listing.items = listing.items.map((item) => {
            const out: string[] = [];
            item.forEach((line, i) => {
                if (isProvenanceLine(line)) {
                    counts.records++;
                    return;
                }
                let l = line;
                if (i === 0 && TRUST.test(l)) {
                    l = l.replace(TRUST, "");
                    counts.trust++;
                }
                if (ATTRIBUTION.test(l)) {
                    l = l.replace(ATTRIBUTION, "");
                    counts.attribution++;
                }
                out.push(l);
            });
            return out;
        });
        const next = joinListing(listing);
        if (next !== text) changed = true;
        return next;
    });
    return { changed, detail: counts };
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
    "provenance-off": {
        id: "provenance-off",
        alias: "d",
        summary: "removes Eidnara's provenance wording from delivered memory items",
        apply: (body) => provenanceOff(body),
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
};

/** The transform a variant name or letter selects. */
export function transformFor(variant: string): ReplayTransform {
    const found = TRANSFORMS[variant] ?? Object.values(TRANSFORMS).find((t) => t.alias === variant);
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
