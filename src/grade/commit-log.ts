import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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
/** Reflog moves, bytes over every log file, and branch logs read at most; a repository past a bound gives no commit log. */
const MOVE_CAP = 100_000;
const LOG_BYTE_CAP = 64 << 20;
const LOG_FILE_CAP = 1_000;
/** A commit object read at most; a larger one gives no subject. */
const COMMIT_BYTE_CAP = 1 << 20;
const GIT_TIMEOUT_MS = 60_000;
/** A commit object placed on HEAD by `update-ref` or `reset` counts as written then when git made it at most this long before. */
const PLACED_WITHIN_S = 600;
/** Actions that place a commit object on HEAD: an unlabelled `update-ref`, and a `reset`. */
const PLACES = /^(?:reset)?$/;
const SECOND_MS = 1_000;
/** Subjects git writes for a commit made to be folded into another. */
const FOLDED = /^(?:fixup|squash|amend)! /;
/** A reflog line: the two ids, the identity (which holds no tab), the time, and git's note after a tab. */
const MOVE = /^([0-9a-f]{40}) ([0-9a-f]{40}) [^\t]* (\d+) [+-]\d{4}(?:\t(.*))?$/;

/** The moves a HEAD reflog's text records, oldest first; a line of another shape is skipped. */
export function parseHeadLog(text: string): HeadMove[] {
    return text.split("\n").flatMap((line) => {
        const m = MOVE.exec(line);
        const time_s = Number(m?.[3]);
        if (!m || !Number.isSafeInteger(time_s)) return [];
        return [{ old: m[1], new: m[2], time_s, message: m[4] ?? "" } as HeadMove];
    });
}

const shellQuoted = (w: string) => `'${w.replace(/'/g, "'\\''")}'`;

/**
 * The commit messages the agent wrote, each as the command `git commit -m '<subject>'` at the
 * scenario time of the move (`scenarioMs` maps the time git recorded, `armClock`). A move counts
 * when its commit holds a message written for it: a `commit` (a merge the agent concluded with
 * `git commit` included), an amend whose subject differs from the commit it replaces, and a
 * commit object placed on HEAD the first time within `PLACED_WITHIN_S` of its making
 * (`commit-tree` with `update-ref` or `reset`). A message git carries over or writes itself is
 * left out: a rebase pick, a cherry-pick, a revert, a `git merge` or `git pull`, an amend that
 * keeps the subject, and a `fixup!`, `squash!`, or `amend!` subject. The harness's own commits
 * (an unlabelled move to a commit of its committer) are left out, and so is a move at a time
 * outside the arm's clock. Null when the clock cannot place a written commit (`ambiguous`): the
 * repository then gives no record.
 */
export function writtenCommits(
    moves: HeadMove[],
    commits: ReadonlyMap<string, CommitObject>,
    scenarioMs: (stampMs: number) => Placed,
): Command[] | null {
    const seen = new Set<string>();
    const out: Command[] = [];
    for (const move of moves) {
        const first = !seen.has(move.new);
        seen.add(move.new);
        const commit = commits.get(move.new);
        if (!commit || FOLDED.test(commit.subject)) continue;
        const action = move.message.split(":", 1)[0] ?? "";
        const harness = move.message === "" && commit.committer_email === HARNESS_EMAIL;
        const placed =
            first && !harness && Math.abs(move.time_s - commit.committer_time_s) <= PLACED_WITHIN_S;
        const written = /^commit(?: \((?:initial|merge)\))?$/.test(action)
            ? true
            : action === "commit (amend)"
              ? commit.subject !== commits.get(move.old)?.subject
              : PLACES.test(action) && placed;
        if (!written) continue;
        const scenario_ms = scenarioMs(move.time_s * 1000);
        if (scenario_ms === "ambiguous") return null;
        if (scenario_ms === "outside" || scenario_ms < 0) continue;
        out.push({ command: `git commit -m ${shellQuoted(commit.subject)}`, exit: 0, scenario_ms });
    }
    return out;
}

/** Whether `path` is a directory itself, a link to one excluded. */
function plainDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** A regular file's text when it holds at most `budget` bytes, or null; a link is no regular file. */
function regularText(path: string, budget: number): string | null {
    try {
        const stat = lstatSync(path);
        return stat.isFile() && stat.size <= budget ? readFileSync(path, "utf8") : null;
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
    if (entries.length > LOG_FILE_CAP) return null;
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            // A directory counts toward the bound through the entries it holds.
            if (found.length + 1 > LOG_FILE_CAP || branchLogs(path, found) === null) return null;
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
        const from = at;
        at += length + 1;
        if (type !== "commit" || length > COMMIT_BYTE_CAP) continue;
        const body = batch.subarray(from, from + length).toString("utf8");
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
 * holds no readable log: `gitDir`, its `logs` directory, or its HEAD log is missing or is a
 * link, its objects lie in another store (a linked `objects` directory, an alternates file, a
 * common-directory file), the logs pass the read bounds, or git cannot print the objects. The agent wrote the
 * repository, so the objects are read with `cat-file --batch`, which runs no hook, filter, or
 * signature check, with lazy fetching, every transport, and replace refs off, so a configured
 * promisor remote starts no fetch and each id reads as its own object.
 */
export function readHeadLog(
    gitDir: string,
): { moves: HeadMove[]; commits: Map<string, CommitObject> } | null {
    const logs = join(gitDir, "logs");
    if (!plainDirectory(gitDir) || !plainDirectory(logs)) return null;
    // The objects are the repository's own: its object directory is a plain one, and no
    // alternates or common-directory file points git at another store.
    const objects = join(gitDir, "objects");
    const elsewhere = [join(objects, "info", "alternates"), join(gitDir, "commondir")];
    if (!plainDirectory(objects) || elsewhere.some((path) => existsSync(path))) return null;
    // A branch log is read only below plain directories, so no link leads the walk elsewhere.
    const heads = [join(logs, "refs"), join(logs, "refs", "heads")];
    const branches = heads.every(plainDirectory) ? branchLogs(heads[1] as string) : [];
    if (branches === null) return null;
    const seen = new Set<string>();
    const moves: HeadMove[] = [];
    let budget = LOG_BYTE_CAP;
    for (const path of [join(logs, "HEAD"), ...branches]) {
        const text = regularText(path, budget);
        if (text === null) return null;
        budget -= Buffer.byteLength(text);
        for (const move of parseHeadLog(text)) {
            const key = `${move.old} ${move.new} ${move.time_s} ${move.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            moves.push(move);
            if (moves.length > MOVE_CAP) return null;
        }
    }
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
            {
                GIT_OPTIONAL_LOCKS: "0",
                GIT_NO_LAZY_FETCH: "1",
                GIT_NO_REPLACE_OBJECTS: "1",
                // No transport is allowed, for a git from before `GIT_NO_LAZY_FETCH`.
                GIT_ALLOW_PROTOCOL: "",
            },
            GIT_TIMEOUT_MS,
            { input: Buffer.from(`${ids.join("\n")}\n`) },
        );
        return { moves, commits: parseCommits(batch) };
    } catch {
        return null;
    }
}

/** The least lead of scenario time over wall time between two journal entries that marks a clock jump. */
const JUMP_MS = 1_000;

/** A journal entry as the clock reads it; a clock entry carries the offset the arm's processes read from then on. */
interface ClockEntry {
    kind?: unknown;
    event?: unknown;
    arm: string | null;
    wall_ms: number;
    scenario_ms: number;
    offset_s?: unknown;
    offset_wall_ms?: unknown;
}

/**
 * The scenario time of a stamp an arm's process read: a time, `outside` for a stamp from before
 * the arm's clock, or `ambiguous` when two clock offsets claim the stamp and the arm's turns do
 * not decide between them.
 */
export type Placed = number | "outside" | "ambiguous";

/**
 * Maps a time an arm's process read to scenario time, or null for a journal that holds no clock
 * offset for the arm. The arm's processes read wall time plus a whole-second offset the harness
 * sets at the arm's start, at each clock jump, and at a resume, and scenario time runs at wall
 * speed inside a turn and holds still between turns. A stamp is taken back to wall time through
 * the offset in effect when it was read. An offset that is smaller than the one before it (a
 * resume, or a jump shorter than the idle time before it) steps the arm's clock back, so two
 * offsets can claim one stamp; the one whose wall time lies inside a turn of the arm is taken,
 * and a stamp no turn or several turns decide is `ambiguous`. The wall time is then placed
 * between the arm's journal entries around it: the earlier entry's scenario time plus the wall
 * time since, at most the later entry's scenario time, and the earlier entry's scenario time
 * when the later one is a clock jump.
 */
export function armClock(
    entries: readonly ClockEntry[],
    arm: string,
): ((stampMs: number) => Placed) | null {
    const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const mine = entries
        .filter((e) => e.arm === arm && finite(e.wall_ms) && finite(e.scenario_ms))
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.wall_ms - b.e.wall_ms || a.i - b.i)
        .map(({ e }) => e);
    /** Each offset with the wall time it was written at; it holds until the next one is written. */
    const spans = mine
        .filter((e) => finite(e.offset_s))
        .map((e) => ({
            offset: (e.offset_s as number) * 1000,
            wall: finite(e.offset_wall_ms) ? e.offset_wall_ms : e.wall_ms,
        }))
        .sort((a, b) => a.wall - b.wall);
    if (spans.length === 0) return null;
    const begins = new Map<unknown, number>();
    const turns: [from: number, to: number][] = [];
    for (const e of mine) {
        if (e.kind === "BeginTurn") begins.set(e.event, e.wall_ms);
        const from = e.kind === "EndTurn" ? begins.get(e.event) : undefined;
        if (from !== undefined) turns.push([from, e.wall_ms]);
    }
    // Git records the whole second a commit began in, so a wall time can read up to a second early.
    const inTurn = (wall: number) =>
        turns.some(([from, to]) => wall + SECOND_MS > from && wall <= to);
    /** The index of the last item of an ascending list whose key is at most `value`, or -1. */
    const lastAtMost = <T>(items: T[], key: (item: T) => number, value: number): number => {
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (key(items[mid] as T) <= value) lo = mid + 1;
            else hi = mid;
        }
        return lo - 1;
    };
    const scenarioAt = (wall: number): number | null => {
        const at = lastAtMost(mine, (e) => e.wall_ms, wall);
        const before = mine[at];
        if (!before) return null;
        const running = before.scenario_ms + (wall - before.wall_ms);
        const after = mine[at + 1];
        if (!after) return running;
        // An entry that lies further ahead in scenario time than in wall time is a clock jump,
        // which the harness makes while the arm is idle: the clock stood still up to it.
        const jumped =
            after.scenario_ms - before.scenario_ms > after.wall_ms - before.wall_ms + JUMP_MS;
        return jumped ? before.scenario_ms : Math.min(running, after.scenario_ms);
    };
    return (stampMs) => {
        // The wall times the stamp has under each offset that was in effect at that wall time.
        const walls = spans.flatMap((span, i) => {
            const wall = stampMs - span.offset;
            const until = spans[i + 1]?.wall ?? Number.POSITIVE_INFINITY;
            return wall + SECOND_MS > span.wall && wall < until ? [wall] : [];
        });
        if (walls.length === 0) return "outside";
        const decided = walls.length === 1 ? walls : walls.filter(inTurn);
        if (decided.length !== 1) return "ambiguous";
        return scenarioAt(decided[0] as number) ?? "outside";
    };
}

/**
 * How far a recorded commit's scenario time can lie before the time its command ran: git
 * records whole seconds. A reader that takes the commits after an instant adds it.
 */
export const CLOCK_SLACK_MS = 2_000;

/**
 * `snap` with the `recorded` command log a P13 item's grader reads when its check names a
 * command channel: the written commits of the item's project up to the end of the probe turn
 * (`untilMs`). Git records the whole second a commit began in, so a commit's mapped time lies
 * at or before its true time and a commit of the next turn stays out. `written` gives them, or null when the run holds no readable repository, and the
 * snapshot then stays as it is, so the grader reads the commands.
 */
export function withRecordedCommits(
    snap: Snapshot,
    probe: ProbeItem,
    written: () => Command[] | null,
    untilMs: () => number,
): Snapshot {
    const check = (probe.check ?? {}) as Record<string, unknown>;
    if (probe.type !== "P13") return snap;
    if (check.commands_must === undefined && check.commands_must_not === undefined) return snap;
    const commits = written();
    if (commits === null) return snap;
    const until = untilMs();
    const recorded: CommandLog = {
        id: `${snap.id}:recorded-commits`,
        class: "command-log",
        role: "recorded",
        commands: commits.filter((c) => c.scenario_ms <= until),
    };
    return { ...snap, artefacts: [...snap.artefacts, recorded] };
}
