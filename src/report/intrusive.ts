import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { armBase } from "../hosts/arms";
import type { MemoryNote } from "../hosts/storecheck";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { INTERNAL_TEXT } from "../oracle/oracles";
import { RESPONSE_TEXT_LIMIT } from "../proxy/records";
import { readJournal } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import type { PairingRecord } from "../usersim/usersim";

export interface Intrusiveness {
    arm: string;
    /**
     * `null` when an agent response reached the proxy's `RESPONSE_TEXT_LIMIT`, or a turn was
     * interrupted (`ItemState` `failed(interrupted)` naming the turn's `event`; a fault's record
     * precedes any turn): the recorded text may lack the suffix the user saw, or a streamed
     * response has no record at all, so a scan of the records cannot clear the arm.
     */
    internal_string_hits: { source: "agent-response"; at: string; evidence: string }[] | null;
    /**
     * Internal strings in tool output the agent saw. `null`: the hosts record each tool run's
     * command and exit status, so there is no tool output to scan and SIM-P59's second source
     * is unavailable.
     */
    tool_output_hits: { source: "tool-output"; at: string; evidence: string }[] | null;
    /** `null` when the arm's `memory.json` records that its notes could not be read. */
    corrections_referencing_injected_text: { event: string; label: string; quote: string }[] | null;
    reverted_edits: { turn: string | null; command: string }[];
    /**
     * `null` when a completed, unskipped turn has no `prompt_ms`: a journal begun before the
     * field existed.
     */
    latency_ms: { n: number; p50: number | null; p95: number | null } | null;
}

/**
 * Each `git` invocation at a command position on one line of a shell command: at the line start or
 * after a separator or a grouping `(` (a `$(` substitution's status is the outer command's, so it
 * is no position), past any `VAR=value` assignments and `sudo`, `env`, `time`, `nice`, `nohup`,
 * or `exec` prefixes with their options, and past git's own global options (`-C <path>`,
 * `-c <k>=<v>`, and any `--option` or `--option=value`); its subcommand and arguments run up to
 * the next separator. Group 1 is the separator before it: after `||` the shell may have skipped
 * the invocation.
 */
const GIT =
    /(^|&&|\|\||[;&|]|(?<!\$)\()[ \t]*(?:\w+=[^ \t\n]*[ \t]+)*(?:(?:sudo|env|time|nice|nohup|exec)(?:[ \t]+(?:-[^ \t\n]*|\w+=[^ \t\n]*))*[ \t]+)*git[ \t]+(?:-[Cc][ \t]+[^ \t\n]+[ \t]+|--[^ \t\n]+[ \t]+)*([a-z-]+)((?:[ \t]+[^ \t\n;&|)]+)*)/gm;
const COMMENT = /(^|[ \t])#.*$/g;
/** Redirections (`2>&1`, `&>f`, `>f`, `<f`), which are part of a command rather than separators. */
const REDIRECT = /[ \t]*(?:\d*[<>]{1,2}&?\d*|&>>?)[ \t]*[^ \t\n;&|)]*/g;
const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1/g;
const QUOTED = /'[^'\n]*'|"(?:[^"\\\n]|\\.)*"/g;
/** A quoted string as one shell word: its text with every shell-significant character made plain. */
const unquote = (q: string) => q.slice(1, -1).replace(/[\s;&|()<>$#'"\\`]/g, "_") || "_";
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

/**
 * The notes a correction can quote: `[]` for the host arm, which keeps no store, and `null` for
 * a memory arm with no readable `memory.json`, whether it wrote `null` or finished before the
 * driver wrote the file.
 */
function quotableNotes(dir: string, arm: string): MemoryNote[] | null {
    const written = notesOf(dir, arm);
    if (written === undefined) return armBase(arm) === "host" ? [] : null;
    return written;
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
 * The command's lines as the shell runs them: each quoted string becomes the one word the shell
 * passes (`"-S"` is `-S`, `"my file"` is `my_file`), so options keep their meaning and later
 * words their positions; a comment (`#` at a word start outside quotes), redirections, and
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
        lines.push(code.replace(QUOTED, unquote).replace(REDIRECT, " "));
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
 * in it ran and succeeded: it does not follow `||`, which may have skipped it, and every command
 * after it is joined by `&&`, so the shell ran them only after the revert exited 0 and the final
 * status is theirs only when all succeeded. Trailing whitespace, `;`, and comment-only lines
 * close no command, so `git restore f;` is the last command.
 */
export function isRevert(command: string): boolean {
    const shell = executable(command).trimEnd();
    for (const m of shell.matchAll(GIT)) {
        const [, before, sub, rest] = m;
        if (before === "||") continue;
        const args = (rest ?? "")
            .trim()
            .split(/\s+/)
            .filter((a) => a !== "");
        if (!reverts(sub ?? "", args)) continue;
        const tail = shell.slice(m.index + m[0].length).replace(/[\s;]+$/, "");
        const after = tail.match(SEPARATOR) ?? [];
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

/**
 * The arm's delivered user-sim replies with their tape text. `null` when a delivered reply's
 * pairing record has no `tape_key`: a run begun before the key was recorded, whose tape entry
 * this join cannot name.
 */
export function userSimReplies(
    dir: string,
    arm: string,
): { event: string; label: string; text: string }[] | null {
    const tape = jsonl<{ key: string; event: string; label: string; digest: string; text: string }>(
        join(dir, "tape.jsonl"),
    );
    const replies = jsonl<PairingRecord>(join(dir, "pairing.jsonl")).filter(
        (r) =>
            r.kind === "turn" &&
            r.arm === arm &&
            r.source !== "script" &&
            r.delivered &&
            (r.fallback?.length ?? 0) === 0,
    ) as Extract<PairingRecord, { kind: "turn" }>[];
    if (replies.some((r) => r.tape_key === undefined)) return null;
    return replies.flatMap((r) => {
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
 * delivered. A failed turn is dependability's, counted there as a failed turn or hang, and a
 * turn the user-sim skipped (`UserTurn` with `delivered: false`) ran no prompt. A completed turn
 * with a `prompt_ms` counts whether or not its `UserTurn` was journaled, since a kill between
 * the two writes loses only the delivery record. `null` when a completed turn has no `prompt_ms`
 * and no skip record, so a journal from before the field never yields a sample over part of its
 * turns.
 */
export function turnLatencies(arm: ArmLogs): number[] | null {
    const skipped = new Set(
        arm.journal
            .filter((e) => e.kind === "UserTurn" && e.delivered === false)
            .map((e) => String(e.event)),
    );
    const latencies: number[] = [];
    for (const e of arm.journal) {
        if (e.kind !== "EndTurn" || e.outcome !== "ok") continue;
        if (typeof e.prompt_ms === "number") latencies.push(e.prompt_ms);
        else if (!skipped.has(String(e.event))) return null;
    }
    return latencies;
}

/**
 * A correction references injected text when a pushback or redirect the agent received shares a
 * five-word run with a memory note whose `first_delivery_ms` is at least `CLOCK_SLACK_MS` before
 * the turn's `BeginTurn` time (`base_wall_ms + scenario_ms`), and neither four-word half of the
 * run is in the scripted user text up to and including that turn: a user restating a rule it
 * gave is quoting itself. The journal must hold the turn's `BeginTurn` and a delivered `UserTurn`;
 * a pairing record alone is the user-sim's intent, which a kill before the turn ends leaves
 * undelivered. `null` when the notes or the replies are unavailable.
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
    const written = quotableNotes(run.dir, arm.arm);
    const replies = userSimReplies(run.dir, arm.arm);
    if (written === null || replies === null) return null;
    const notes = written.filter((n) => n.first_delivery_ms !== null);
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
    return replies
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

/** Every match of every F7 pattern in every relayed agent response, in response order. */
function internalStrings(arm: ArmLogs) {
    return arm.calls
        .filter((c) => c.component === "agent" && c.response_text)
        .flatMap((c) =>
            INTERNAL_TEXT.flatMap((re) =>
                [...(c.response_text ?? "").matchAll(new RegExp(re.source, `${re.flags}g`))].map(
                    (m) => ({
                        source: "agent-response" as const,
                        at: c.turn ?? `call ${c.seq}`,
                        evidence: m[0],
                    }),
                ),
            ),
        );
}

export function intrusiveness(run: RunLogs, arm: ArmLogs): Intrusiveness {
    const latencies = turnLatencies(arm);
    const cut =
        arm.calls.some(
            (c) => c.component === "agent" && (c.response_text?.length ?? 0) >= RESPONSE_TEXT_LIMIT,
        ) ||
        arm.journal.some(
            (e) =>
                e.kind === "ItemState" &&
                e.state === "failed(interrupted)" &&
                typeof e.event === "string",
        );
    return {
        arm: arm.arm,
        internal_string_hits: cut ? null : internalStrings(arm),
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
