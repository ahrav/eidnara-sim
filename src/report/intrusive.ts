import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNote } from "../hosts/storecheck";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { runOracles } from "../oracle/oracles";
import { readJournal } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import type { PairingRecord } from "../usersim/usersim";

export interface Intrusiveness {
    arm: string;
    internal_string_hits: { source: "agent-response"; at: string; evidence: string }[];
    /** `null` when the arm's `memory.json` records that its notes could not be read. */
    corrections_referencing_injected_text: { event: string; label: string; quote: string }[] | null;
    reverted_edits: { turn: string | null; command: string }[];
    latency_ms: { n: number; p50: number | null; p95: number | null };
}

/** Each `git` invocation in a shell command: its subcommand and the arguments up to a separator. */
const GIT = /\bgit\s+(?:-[Cc]\s+\S+\s+)*([a-z-]+)((?:\s+[^\s;&|]+)*)/g;
const SHINGLE = 5;

function jsonl<T>(path: string): T[] {
    return existsSync(path) ? (readJournal(path) as unknown as T[]) : [];
}

/**
 * The arm's memory notes: `undefined` when the arm wrote no `memory.json`, `null` when it wrote
 * one recording that the notes could not be read.
 */
export function notesOf(dir: string, arm: string): MemoryNote[] | null | undefined {
    const path = join(dir, arm, "memory.json");
    return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as MemoryNote[] | null)
        : undefined;
}

function scriptedText(dir: string): string[] {
    const path = join(dir, "scenario.json");
    if (!existsSync(path)) return [];
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
    return scenario.events
        .filter((e) => e.kind === "user_turn" && typeof e.text === "string")
        .map((e) => e.text as string);
}

const hasFlag = (args: string[], long: string, short: string) =>
    args.some((a) => a === long || (/^-[A-Za-z]+$/.test(a) && a.includes(short)));

/**
 * A `git restore` reverts working-tree edits unless `--staged`/`-S` is given without
 * `--worktree`/`-W`; short options may be clustered, as in `-Sq`.
 */
const restoresWorktree = (args: string[]) =>
    hasFlag(args, "--worktree", "W") || !hasFlag(args, "--staged", "S");

export function isRevert(command: string): boolean {
    for (const [, sub, rest] of command.matchAll(GIT)) {
        const args = (rest ?? "")
            .trim()
            .split(/\s+/)
            .filter((a) => a !== "");
        if (sub === "revert") return true;
        if (sub === "reset" && args.includes("--hard")) return true;
        if (sub === "checkout" && args.includes("--")) return true;
        if (sub === "restore" && restoresWorktree(args)) return true;
    }
    return false;
}

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

/** Each turn's `prompt_ms` from `EndTurn`: the host's prompt call, after the user-sim delivered. */
export function turnLatencies(arm: ArmLogs): number[] {
    return arm.journal
        .filter((e) => e.kind === "EndTurn")
        .map((e) => e.prompt_ms)
        .filter((ms): ms is number => typeof ms === "number");
}

/**
 * A correction references injected text when a pushback or redirect the agent received shares a
 * five-word run with a memory note whose `first_delivery_ms` is at or before the turn's
 * `BeginTurn` time (`base_wall_ms + scenario_ms`), and neither four-word half of the run is in
 * the scenario's scripted user text: a user restating a rule it gave is quoting itself.
 */
function corrections(run: RunLogs, arm: ArmLogs) {
    const own = new Set(scriptedText(run.dir).flatMap((t) => shingles(t, SHINGLE - 1)));
    const quoted = (s: string) => {
        const words = s.split(" ");
        return own.has(words.slice(1).join(" ")) || own.has(words.slice(0, -1).join(" "));
    };
    const written = notesOf(run.dir, arm.arm);
    if (written === null) return null;
    const notes = (written ?? []).filter((n) => n.first_delivery_ms !== null);
    const began = new Map(
        arm.journal
            .filter((e) => e.kind === "BeginTurn")
            .map((e) => [String(e.event), run.base_wall_ms + e.scenario_ms]),
    );
    return userSimReplies(run.dir, arm.arm)
        .filter((r) => r.label === "pushback" || r.label === "redirect")
        .flatMap((r) => {
            const at = began.get(r.event);
            if (at === undefined) return [];
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

export function intrusiveness(run: RunLogs, arm: ArmLogs): Intrusiveness {
    const latencies = turnLatencies(arm);
    return {
        arm: arm.arm,
        internal_string_hits: runOracles({ ...run, arms: [arm] })
            .filter((a) => a.oracle === "F7")
            .map((a) => ({ source: "agent-response" as const, at: a.at, evidence: a.evidence })),
        corrections_referencing_injected_text: corrections(run, arm),
        reverted_edits: arm.tools
            .filter((t) => t.exit === 0 && isRevert(t.command))
            .map((t) => ({ turn: t.turn, command: t.command.slice(0, 200) })),
        latency_ms: {
            n: latencies.length,
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
        },
    };
}
