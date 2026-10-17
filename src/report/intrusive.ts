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
    /**
     * Internal strings in tool output the agent saw. `null`: the hosts record each tool run's
     * command and exit status, so there is no tool output to scan and SIM-P59's second source
     * is unavailable.
     */
    tool_output_hits: { source: "tool-output"; at: string; evidence: string }[] | null;
    /** `null` when the arm's `memory.json` records that its notes could not be read. */
    corrections_referencing_injected_text: { event: string; label: string; quote: string }[] | null;
    reverted_edits: { turn: string | null; command: string }[];
    /** `null` when a completed turn has no `prompt_ms`: a journal begun before the field existed. */
    latency_ms: { n: number; p50: number | null; p95: number | null } | null;
}

/**
 * Each `git` invocation at a command position on one line of a shell command: at the line start or
 * after a separator or `(`, past any `VAR=value` assignments and `sudo`, `env`, `time`, `nice`,
 * `nohup`, or `exec` prefixes; its subcommand and arguments run up to the next separator.
 */
const GIT =
    /(?:^|[;&|(][ \t]*)[ \t]*(?:\w+=[^ \t\n]*[ \t]+)*(?:(?:sudo|env|time|nice|nohup|exec)(?:[ \t]+(?:-[^ \t\n]*|\w+=[^ \t\n]*))*[ \t]+)*git[ \t]+(?:-[Cc][ \t]+[^ \t\n]+[ \t]+)*([a-z-]+)((?:[ \t]+[^ \t\n;&|)]+)*)/gm;
const COMMENT = /(^|[ \t])#.*$/g;
/** Redirections (`2>&1`, `&>f`, `>f`, `<f`), which are part of a command rather than separators. */
const REDIRECT = /[ \t]*(?:\d*[<>]{1,2}&?\d*|&>>?)[ \t]*[^ \t\n;&|)]*/g;
const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1/g;
const QUOTED = /'[^'\n]*'|"(?:[^"\\\n]|\\.)*"/g;
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

/** The options before `--`; what follows `--` is pathspecs. */
const options = (args: string[]) => {
    const dd = args.indexOf("--");
    return dd < 0 ? args : args.slice(0, dd);
};

const hasFlag = (args: string[], long: string, short: string) =>
    options(args).some((a) => a === long || (/^-[A-Za-z]+$/.test(a) && a.includes(short)));

/**
 * A `git restore` reverts working-tree edits unless `--staged`/`-S` is given without
 * `--worktree`/`-W`; short options may be clustered, as in `-Sq`.
 */
const restoresWorktree = (args: string[]) =>
    hasFlag(args, "--worktree", "W") || !hasFlag(args, "--staged", "S");

/** A `git checkout` reverts working-tree files when a pathspec follows `--`. */
const checksOutPaths = (args: string[]) => {
    const dd = args.indexOf("--");
    return dd >= 0 && dd < args.length - 1;
};

/**
 * The command's lines as the shell runs them: each quoted string becomes one plain word, so later
 * words keep their positions; a comment (`#` at a word start outside quotes), redirections, and
 * the body lines of a heredoc whose `<<` sits outside quotes are dropped.
 */
function executable(command: string): string {
    const lines: string[] = [];
    let tag: string | null = null;
    for (const line of command.split("\n")) {
        if (tag !== null) {
            if (line.trim() === tag) tag = null;
            continue;
        }
        const quoted = [...line.matchAll(QUOTED)].map((m) => [m.index, m.index + m[0].length]);
        const inQuotes = (i: number) =>
            quoted.some(([a, b]) => i >= (a as number) && i < (b as number));
        const heredoc = [...line.matchAll(HEREDOC)].find((m) => !inQuotes(m.index));
        if (heredoc) tag = heredoc[2] as string;
        const comment = [...line.matchAll(COMMENT)].find(
            (m) => !inQuotes(m.index + (m[1] as string).length),
        );
        const code = comment ? line.slice(0, comment.index) : line;
        lines.push(code.replace(QUOTED, "_").replace(REDIRECT, " "));
    }
    return lines.join("\n");
}

const reverts = (sub: string, args: string[]) =>
    sub === "revert" ||
    (sub === "reset" && args.includes("--hard")) ||
    (sub === "checkout" && checksOutPaths(args)) ||
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

/**
 * Each completed turn's `prompt_ms` from `EndTurn`: the host's prompt call, after the user-sim
 * delivered. A failed turn is dependability's, counted there as a failed turn or hang. `null`
 * when a completed turn carries no `prompt_ms`, so a journal from before the field never yields
 * a sample over part of its turns.
 */
export function turnLatencies(arm: ArmLogs): number[] | null {
    const completed = arm.journal.filter((e) => e.kind === "EndTurn" && e.outcome === "ok");
    const latencies = completed
        .map((e) => e.prompt_ms)
        .filter((ms): ms is number => typeof ms === "number");
    return latencies.length === completed.length ? latencies : null;
}

/**
 * A correction references injected text when a pushback or redirect the agent received shares a
 * five-word run with a memory note whose `first_delivery_ms` is at least `CLOCK_SLACK_MS` before
 * the turn's `BeginTurn` time (`base_wall_ms + scenario_ms`), and neither four-word half of the
 * run is in the scripted user text up to and including that turn: a user restating a rule it
 * gave is quoting itself. The journal must hold the turn's `BeginTurn` and a delivered `UserTurn`;
 * a pairing record alone is the user-sim's intent, which a kill before the turn ends leaves
 * undelivered.
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
    const delivered = new Set(
        arm.journal
            .filter((e) => e.kind === "UserTurn" && e.delivered === true)
            .map((e) => String(e.event)),
    );
    return userSimReplies(run.dir, arm.arm)
        .filter((r) => r.label === "pushback" || r.label === "redirect")
        .flatMap((r) => {
            const at = began.get(r.event);
            if (at === undefined || !delivered.has(r.event)) return [];
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
        tool_output_hits: null,
        corrections_referencing_injected_text: corrections(run, arm),
        reverted_edits: arm.tools
            .filter((t) => t.exit === 0 && isRevert(t.command))
            .map((t) => ({ turn: t.turn, command: t.command.slice(0, 200) })),
        latency_ms:
            latencies === null
                ? null
                : {
                      n: latencies.length,
                      p50: percentile(latencies, 0.5),
                      p95: percentile(latencies, 0.95),
                  },
    };
}
