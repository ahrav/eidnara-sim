import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitBytes } from "../git";
import type { ProbeItem } from "../scenario/compile";
import type { Command, CommandLog, Snapshot } from "./artefacts";

/** One line of a reflog: the commit the ref left, the one it reached, when, and git's note. */
export interface HeadMove {
    old: string;
    new: string;
    time_s: number;
    message: string;
}

/** What the grader reads of a commit object. */
export interface CommitObject {
    subject: string;
    committer_email: string;
    committer_time_s: number;
}

/** The committer the harness's own commits carry (`src/hosts/driver.ts`). */
const HARNESS_EMAIL = "sim-user@users.noreply.github.com";
/** Reflog lines and bytes read at most; a longer log gives no commit log. */
const MOVE_CAP = 100_000;
const LOG_BYTE_CAP = 64 << 20;
const LOG_FILE_CAP = 1_000;
const GIT_TIMEOUT_MS = 60_000;
/** A commit object placed on HEAD by `update-ref` or `reset` counts as written then when git made it at most this long before. */
const PLACED_WITHIN_S = 600;
/** Actions whose commit carries a message git copied or wrote: a pick, a pull, a merge of another line. */
const CARRIES = /^(?:rebase|cherry-pick|revert|merge|pull|am|clone)\b/;
/** Subjects git writes for a commit made to be folded into another. */
const FOLDED = /^(?:fixup|squash|amend)! /;
const MOVE = /^([0-9a-f]{40}) ([0-9a-f]{40}) .* (\d+) [+-]\d{4}(?:\t(.*))?$/;

/** The moves a HEAD reflog's text records, oldest first; a line of another shape is skipped. */
export function parseHeadLog(text: string): HeadMove[] {
    return text.split("\n").flatMap((line) => {
        const m = MOVE.exec(line);
        if (!m) return [];
        return [{ old: m[1], new: m[2], time_s: Number(m[3]), message: m[4] ?? "" } as HeadMove];
    });
}

const shellQuoted = (w: string) => `'${w.replace(/'/g, "'\\''")}'`;

/**
 * The commit messages the agent wrote, each as the command `git commit -m '<subject>'` at the
 * scenario time git recorded it (`epochMs` is the wall time of scenario time 0 on the arm's
 * clock). A move counts when its commit holds a message written for it: a `commit`, an amend
 * whose subject differs from the commit it replaces, and a commit object placed on HEAD the
 * first time within `PLACED_WITHIN_S` of its making (`commit-tree` with `update-ref` or
 * `reset`). A message git carries over or writes itself is left out: a rebase pick, a
 * cherry-pick, a revert, a merge, an amend that keeps the subject, and a `fixup!`, `squash!`,
 * or `amend!` subject. The harness's own commits (an unlabelled move to a commit of its
 * committer) are left out.
 */
export function writtenCommits(
    moves: HeadMove[],
    commits: ReadonlyMap<string, CommitObject>,
    epochMs: number,
): Command[] {
    const seen = new Set<string>();
    const out: Command[] = [];
    for (const move of moves) {
        const first = !seen.has(move.new);
        seen.add(move.new);
        const commit = commits.get(move.new);
        const scenario_ms = move.time_s * 1000 - epochMs;
        if (!commit || scenario_ms < 0 || FOLDED.test(commit.subject)) continue;
        const action = move.message.split(":", 1)[0] ?? "";
        const harness = move.message === "" && commit.committer_email === HARNESS_EMAIL;
        const placed =
            first && !harness && Math.abs(move.time_s - commit.committer_time_s) <= PLACED_WITHIN_S;
        const written = /^commit(?: \((?:initial|merge)\))?$/.test(action)
            ? true
            : action === "commit (amend)"
              ? commit.subject !== commits.get(move.old)?.subject
              : !CARRIES.test(action) && placed;
        if (!written) continue;
        out.push({ command: `git commit -m ${shellQuoted(commit.subject)}`, exit: 0, scenario_ms });
    }
    return out;
}

/** A regular file's text when it lies within the byte bound, or null; a link is no regular file. */
function regularText(path: string): string | null {
    try {
        const stat = lstatSync(path);
        return stat.isFile() && stat.size <= LOG_BYTE_CAP ? readFileSync(path, "utf8") : null;
    } catch {
        return null;
    }
}

/** The reflog files under a directory of branch logs, links left out, or null past the file bound. */
function branchLogs(dir: string, found: string[] = []): string[] | null {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (branchLogs(path, found) === null) return null;
        } else if (entry.isFile()) found.push(path);
        if (found.length > LOG_FILE_CAP) return null;
    }
    return found;
}

/** The commit objects `cat-file --batch` printed: each `<id> commit <size>` header with its body. */
function parseCommits(batch: Buffer): Map<string, CommitObject> {
    const commits = new Map<string, CommitObject>();
    let at = 0;
    while (at < batch.length) {
        const eol = batch.indexOf(0x0a, at);
        if (eol < 0) break;
        const [id, type, size] = batch.subarray(at, eol).toString("utf8").split(" ");
        at = eol + 1;
        if (id === undefined || type === "missing" || size === undefined) continue;
        const length = Number(size);
        if (!Number.isSafeInteger(length) || length < 0) break;
        const body = batch.subarray(at, at + length).toString("utf8");
        at += length + 1;
        if (type !== "commit") continue;
        const split = body.indexOf("\n\n");
        const headers = split < 0 ? body : body.slice(0, split);
        const committer = /^committer .*<([^>\n]*)> (\d+) [+-]\d{4}$/m.exec(headers);
        if (!committer) continue;
        // The subject is the message's first paragraph on one line, as git's `%s` gives it.
        const message = split < 0 ? "" : body.slice(split + 2).replace(/^\n+/, "");
        const subject = (message.split(/\n[ \t]*\n/, 1)[0] ?? "").replace(/\s*\n\s*/g, " ").trim();
        commits.set(id, {
            subject,
            committer_email: committer[1] as string,
            committer_time_s: Number(committer[2]),
        });
    }
    return commits;
}

/**
 * The moves the repository at `gitDir` recorded for HEAD and for each branch, oldest first, with
 * the commit objects they name. A commit made in a linked worktree moves its branch alone, so
 * the branch logs join HEAD's, and a move both logs hold counts once. Null when the directory
 * holds no readable log: `gitDir` or its HEAD log is missing or is no plain directory or file,
 * a log passes the read bounds, or git cannot print the objects. The objects are read with
 * `cat-file --batch`, which runs no hook, filter, or signature check of the repository.
 */
export function readHeadLog(
    gitDir: string,
): { moves: HeadMove[]; commits: Map<string, CommitObject> } | null {
    try {
        if (!lstatSync(gitDir).isDirectory()) return null;
    } catch {
        return null;
    }
    const head = regularText(join(gitDir, "logs", "HEAD"));
    const branches = branchLogs(join(gitDir, "logs", "refs", "heads"));
    if (head === null || branches === null) return null;
    const seen = new Set<string>();
    const moves: HeadMove[] = [];
    for (const text of [head, ...branches.map(regularText)]) {
        if (text === null) return null;
        for (const move of parseHeadLog(text)) {
            const key = `${move.old} ${move.new} ${move.time_s} ${move.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            moves.push(move);
        }
    }
    if (moves.length > MOVE_CAP) return null;
    // Array.prototype.sort is stable, so moves of one second keep their log order.
    moves.sort((a, b) => a.time_s - b.time_s);
    const ids = [...new Set(moves.flatMap((m) => [m.old, m.new]))].filter((id) =>
        /[1-9a-f]/.test(id),
    );
    if (ids.length === 0) return { moves, commits: new Map() };
    try {
        const batch = gitBytes(
            gitDir,
            ["--git-dir=.", "cat-file", "--batch"],
            { GIT_OPTIONAL_LOCKS: "0" },
            GIT_TIMEOUT_MS,
            { input: Buffer.from(`${ids.join("\n")}\n`) },
        );
        return { moves, commits: parseCommits(batch) };
    } catch {
        return null;
    }
}

/**
 * The wall time of scenario time 0 on an arm's clock, from the arm's first journaled clock
 * offset, or null for a journal without one. The arm's processes read wall time plus the
 * offset, so a time git recorded maps to scenario time as `time - epoch`, within the whole
 * second the offset is rounded to.
 */
export function armEpochMs(
    entries: readonly {
        kind: string;
        arm: string | null;
        scenario_ms: number;
        [k: string]: unknown;
    }[],
    arm: string,
): number | null {
    const first = entries.find((e) => e.kind === "ClockOffset" && e.arm === arm);
    const wall = first?.offset_wall_ms;
    const offset = first?.offset_s;
    if (!first || typeof wall !== "number" || typeof offset !== "number") return null;
    const epoch = wall + offset * 1000 - first.scenario_ms;
    return Number.isFinite(epoch) ? epoch : null;
}

/**
 * How far a recorded commit's scenario time can lie from the time its command ran: the arm's
 * clock offset is a whole second, and git records whole seconds.
 */
export const CLOCK_SLACK_MS = 2_000;

/**
 * `snap` with the `recorded` command log a P13 item's grader reads when its check names a
 * command channel: the written commits of the item's project up to the end of the probe turn
 * (`untilMs`). `written` gives them, or null when the run holds no readable repository, and the
 * snapshot then stays as it is, so the grader reads the commands.
 */
export function withRecordedCommits(
    snap: Snapshot,
    probe: ProbeItem,
    written: () => Command[] | null,
    untilMs: number,
): Snapshot {
    const check = (probe.check ?? {}) as Record<string, unknown>;
    if (probe.type !== "P13") return snap;
    if (check.commands_must === undefined && check.commands_must_not === undefined) return snap;
    const commits = written();
    if (commits === null) return snap;
    const recorded: CommandLog = {
        id: `${snap.id}:recorded-commits`,
        class: "command-log",
        role: "recorded",
        commands: commits.filter((c) => c.scenario_ms <= untilMs + CLOCK_SLACK_MS),
    };
    return { ...snap, artefacts: [...snap.artefacts, recorded] };
}
