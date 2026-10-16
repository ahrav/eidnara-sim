import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNote } from "../hosts/storecheck";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import { readJournal } from "../run/journal";
import type { PairingRecord } from "../usersim/usersim";

export interface Intrusiveness {
    arm: string;
    internal_string_hits: { source: "agent-response"; at: string; evidence: string }[];
    corrections_referencing_injected_text: { event: string; label: string; quote: string }[];
    reverted_edits: { turn: string | null; command: string }[];
    latency_ms: { n: number; p50: number | null; p95: number | null };
}

const REVERT =
    /\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:revert\b|restore\b(?!\s+--staged)|checkout\b(?:\s+[^\s;&|]+)*?\s+--(?=\s)|reset\s+--hard\b)/;
const SHINGLE = 5;

function jsonl<T>(path: string): T[] {
    return existsSync(path) ? (readJournal(path) as unknown as T[]) : [];
}

export function notesOf(dir: string, arm: string): MemoryNote[] | null {
    const path = join(dir, arm, "memory.json");
    return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as MemoryNote[] | null)
        : null;
}

export const isRevert = (command: string) => REVERT.test(command);

const shingles = (text: string, size = SHINGLE) => {
    const words = text.toLowerCase().match(/[\w[\]-]+/g) ?? [];
    return words
        .slice(0, Math.max(0, words.length - size + 1))
        .map((_, i) => words.slice(i, i + size).join(" "));
};

export function userSimReplies(
    dir: string,
    arm: string,
): { event: string; label: string; text: string }[] {
    const tape = jsonl<{ event: string; label: string; digest: string; text: string }>(
        join(dir, "tape.jsonl"),
    );
    return jsonl<PairingRecord>(join(dir, "pairing.jsonl")).flatMap((r) => {
        if (r.kind !== "turn" || r.arm !== arm || r.source === "script") return [];
        if (!r.delivered || (r.fallback?.length ?? 0) > 0) return [];
        const hit = tape.find(
            (t) => t.event === r.event && t.label === r.label && t.digest === r.digest,
        );
        return hit ? [{ event: r.event, label: r.label, text: hit.text }] : [];
    });
}

export function percentile(values: number[], q: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
}

export function turnLatencies(arm: ArmLogs): number[] {
    const begins = new Map(
        arm.journal.filter((e) => e.kind === "BeginTurn").map((e) => [String(e.event), e.wall_ms]),
    );
    return arm.journal
        .filter((e) => e.kind === "EndTurn" && begins.has(String(e.event)))
        .map((e) => e.wall_ms - (begins.get(String(e.event)) as number));
}

/**
 * A correction references injected text when a pushback or redirect the agent received shares a
 * five-word run with a memory note delivered before that turn (both in the hosts' faked clock,
 * `base_wall_ms` plus scenario time), and neither four-word half of the
 * run is in scripted user text: a user restating a rule it gave is quoting itself.
 */
function corrections(run: RunLogs, arm: ArmLogs, userText: readonly string[]) {
    const own = new Set(userText.flatMap((t) => shingles(t, SHINGLE - 1)));
    const quoted = (s: string) => {
        const words = s.split(" ");
        return own.has(words.slice(1).join(" ")) || own.has(words.slice(0, -1).join(" "));
    };
    const notes = (notesOf(run.dir, arm.arm) ?? []).filter((n) => n.first_delivery_ms !== null);
    const sent = new Map(
        arm.journal
            .filter((e) => e.kind === "UserTurn")
            .map((e) => [String(e.event), run.base_wall_ms + e.scenario_ms]),
    );
    return userSimReplies(run.dir, arm.arm)
        .filter((r) => r.label === "pushback" || r.label === "redirect")
        .flatMap((r) => {
            const at = sent.get(r.event) ?? Number.POSITIVE_INFINITY;
            const injected = new Set(
                notes
                    .filter((n) => (n.first_delivery_ms as number) <= at)
                    .flatMap((n) => shingles(n.content))
                    .filter((s) => !quoted(s)),
            );
            const quote = shingles(r.text).find((s) => injected.has(s));
            return quote ? [{ event: r.event, label: r.label, quote }] : [];
        });
}

export function intrusiveness(
    run: RunLogs,
    arm: ArmLogs,
    userText: readonly string[] = [],
): Intrusiveness {
    const latencies = turnLatencies(arm);
    return {
        arm: arm.arm,
        internal_string_hits: runOracles({ ...run, arms: [arm] })
            .filter((a) => a.oracle === "F7")
            .map((a) => ({ source: "agent-response" as const, at: a.at, evidence: a.evidence })),
        corrections_referencing_injected_text: corrections(run, arm, userText),
        reverted_edits: arm.tools
            .filter((t) => isRevert(t.command))
            .map((t) => ({ turn: t.turn, command: t.command.slice(0, 200) })),
        latency_ms: {
            n: latencies.length,
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
        },
    };
}
