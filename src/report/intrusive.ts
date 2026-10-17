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
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const SEPARATOR = /&&|\|\||[;|&\n]/g;
const SHINGLE = 5;
/** Clock slack between a note's delivery stamp and the harness's nominal turn boundary. */
const CLOCK_SLACK_MS = 1_000;

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

/** The scenario's events in order, with the text of each scripted user turn. */
function scriptedTurns(dir: string): { id: string; text: string | null }[] {
    const path = join(dir, "scenario.json");
    if (!existsSync(path)) return [];
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
    return scenario.events.map((e) => ({
        id: String(e.id),
        text: e.kind === "user_turn" && typeof e.text === "string" ? e.text : null,
    }));
}

const hasFlag = (args: string[], long: string, short: string) =>
    args.some((a) => a === long || (/^-[A-Za-z]+$/.test(a) && a.includes(short)));

/**
 * A `git restore` reverts working-tree edits unless `--staged`/`-S` is given without
 * `--worktree`/`-W`; short options may be clustered, as in `-Sq`.
 */
const restoresWorktree = (args: string[]) =>
    hasFlag(args, "--worktree", "W") || !hasFlag(args, "--staged", "S");

/**
 * The command with heredoc bodies removed and each quoted string replaced by one plain word, so
 * the words the shell runs keep their positions.
 */
const executable = (command: string) => command.replace(HEREDOC, " ").replace(QUOTED, "_");

const reverts = (sub: string, args: string[]) =>
    sub === "revert" ||
    (sub === "reset" && args.includes("--hard")) ||
    (sub === "checkout" && args.includes("--")) ||
    (sub === "restore" && restoresWorktree(args));

/**
 * Whether a zero exit status of the whole command establishes that a reverting `git` invocation
 * in it succeeded: every command after that invocation is joined by `&&`, so the shell ran them
 * only after the revert exited 0 and the final status is theirs only when all succeeded.
 */
export function isRevert(command: string): boolean {
    const shell = executable(command);
    for (const m of shell.matchAll(GIT)) {
        const [, sub, rest] = m;
        const args = (rest ?? "")
            .trim()
            .split(/\s+/)
            .filter((a) => a !== "");
        if (!reverts(sub ?? "", args)) continue;
        const after = shell.slice(m.index + m[0].length).match(SEPARATOR) ?? [];
        if (after.every((sep) => sep === "&&")) return true;
    }
    return false;
}

const shingles = (text: string, size = SHINGLE) => {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_[\]-]+/gu) ?? [];
    return words
        .slice(0, Math.max(0, words.length - size + 1))
        .map((_, i) => words.slice(i, i + size).join(" "));
};

export function userSimReplies(
    dir: string,
    arm: string,
): { event: string; label: string; text: string }[] {
    const tape = jsonl<{ key: string; event: string; label: string; digest: string; text: string }>(
        join(dir, "tape.jsonl"),
    );
    return jsonl<PairingRecord>(join(dir, "pairing.jsonl")).flatMap((r) => {
        if (r.kind !== "turn" || r.arm !== arm || r.source === "script") return [];
        if (!r.delivered || (r.fallback?.length ?? 0) > 0) return [];
        const hit = tape.find((t) => t.key === r.tape_key);
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
 * five-word run with a memory note whose `first_delivery_ms` is at least `CLOCK_SLACK_MS` before
 * the turn's `BeginTurn` time (`base_wall_ms + scenario_ms`), and neither four-word half of the
 * run is in the scripted user text up to and including that turn: a user restating a rule it
 * gave is quoting itself.
 */
function corrections(run: RunLogs, arm: ArmLogs) {
    const script = scriptedTurns(run.dir);
    const ownBy = (event: string) => {
        const at = script.findIndex((t) => t.id === event);
        const texts = script.slice(0, at + 1).flatMap((t) => (t.text === null ? [] : [t.text]));
        return new Set(texts.flatMap((t) => shingles(t, SHINGLE - 1)));
    };
    const quoted = (own: Set<string>, s: string) => {
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
            const own = ownBy(r.event);
            const injected = new Set(
                notes
                    .filter((n) => (n.first_delivery_ms as number) <= at - CLOCK_SLACK_MS)
                    .flatMap((n) => shingles(n.content))
                    .filter((s) => !quoted(own, s)),
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
