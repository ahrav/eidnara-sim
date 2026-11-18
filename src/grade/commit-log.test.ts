import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../git";
import type { ProbeItem } from "../scenario/compile";
import type { Snapshot } from "./artefacts";
import {
    armEpochMs,
    CLOCK_SLACK_MS,
    type CommitObject,
    type HeadMove,
    parseHeadLog,
    readHeadLog,
    withRecordedCommits,
    writtenCommits,
} from "./commit-log";

const ZERO = "0".repeat(40);
const id = (n: number) => n.toString(16).padStart(40, "0");
const EPOCH_MS = 1_000_000_000_000;
/** A move at `at` scenario seconds that takes HEAD from commit `from` to commit `to`. */
const move = (from: number, to: number, at: number, message: string): HeadMove => ({
    old: from === 0 ? ZERO : id(from),
    new: id(to),
    time_s: EPOCH_MS / 1000 + at,
    message,
});
const agent = (subject: string, at: number): CommitObject => ({
    subject,
    committer_email: "agent@example.invalid",
    committer_time_s: EPOCH_MS / 1000 + at,
});
const harness = (subject: string, at: number): CommitObject => ({
    ...agent(subject, at),
    committer_email: "sim-user@users.noreply.github.com",
});
const subjects = (moves: HeadMove[], commits: [number, CommitObject][]) =>
    writtenCommits(moves, new Map(commits.map(([n, c]) => [id(n), c])), EPOCH_MS).map((c) => [
        c.command,
        c.scenario_ms,
    ]);

describe("the commit messages the agent wrote, read from git's record", () => {
    test("a commit counts once with its subject as git recorded it, at its scenario time", () => {
        const moves = [move(1, 2, 10, "commit: [tag] add the cap")];
        expect(subjects(moves, [[2, agent("[tag] add the cap", 10)]])).toEqual([
            ["git commit -m '[tag] add the cap'", 10_000],
        ]);
        const quoted = [move(1, 2, 10, "commit: it's done")];
        expect(subjects(quoted, [[2, agent("it's done", 10)]])).toEqual([
            ["git commit -m 'it'\\''s done'", 10_000],
        ]);
    });

    test("a message git carries over or writes itself is left out", () => {
        const commits: [number, CommitObject][] = [
            [2, agent("[tag] first", 10)],
            [3, agent("[tag] first", 20)],
            [4, agent("[tag] reworded", 30)],
            [5, agent("fixup! [tag] first", 40)],
            [6, agent("[tag] first", 50)],
            [7, agent("old subject", 60)],
            [8, agent('Revert "[tag] first"', 70)],
        ];
        const moves = [
            move(1, 2, 10, "commit: [tag] first"),
            move(2, 3, 20, "commit (amend): [tag] first"),
            move(3, 4, 30, "commit (amend): [tag] reworded"),
            move(4, 5, 40, "commit: fixup! [tag] first"),
            move(5, 6, 50, "rebase (fixup): [tag] first"),
            move(6, 7, 60, "cherry-pick: old subject"),
            move(7, 8, 70, 'revert: Revert "[tag] first"'),
            move(8, 8, 80, "rebase (finish): returning to refs/heads/main"),
            move(8, 2, 90, "checkout: moving from main to topic"),
        ];
        expect(subjects(moves, commits)).toEqual([
            ["git commit -m '[tag] first'", 10_000],
            ["git commit -m '[tag] reworded'", 30_000],
        ]);
    });

    test("the harness's own commits are left out, and a commit object the agent placed on HEAD counts", () => {
        const commits: [number, CommitObject][] = [
            [2, harness("Add src/limits/body.ts", 10)],
            [3, agent("[tag] from commit-tree", 20)],
            [4, agent("upstream commit", -90_000)],
        ];
        const moves = [
            move(1, 2, 10, ""),
            move(2, 3, 20, ""),
            move(3, 4, 30, "checkout: moving from main to v1"),
            move(4, 3, 40, "reset: moving to main"),
        ];
        expect(subjects(moves, commits)).toEqual([
            ["git commit -m '[tag] from commit-tree'", 20_000],
        ]);
        // A commit placed by a reset counts the first time HEAD reaches it.
        const placed = [move(1, 3, 25, "reset: moving to 0003")];
        expect(subjects(placed, commits)).toEqual([
            ["git commit -m '[tag] from commit-tree'", 25_000],
        ]);
    });

    test("a move before the run's clock began, or to an object git no longer holds, is left out", () => {
        const moves = [move(0, 2, -5, "commit (initial): before"), move(2, 3, 5, "commit: gone")];
        expect(subjects(moves, [[2, agent("before", -5)]])).toEqual([]);
    });

    test("a reflog line of another shape is skipped", () => {
        const line = `${id(1)} ${id(2)} A U Thor <a@b> 1700000000 +0000\tcommit: subject`;
        expect(
            parseHeadLog(`${line}\nnot a move\n${id(2)} ${id(3)} x <y> 1700000005 -0700\n`),
        ).toEqual([
            { old: id(1), new: id(2), time_s: 1_700_000_000, message: "commit: subject" },
            { old: id(2), new: id(3), time_s: 1_700_000_005, message: "" },
        ]);
    });
});

describe("reading a repository's record", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-commit-log-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const identity = {
        GIT_AUTHOR_NAME: "agent",
        GIT_AUTHOR_EMAIL: "agent@example.invalid",
        GIT_COMMITTER_NAME: "agent",
        GIT_COMMITTER_EMAIL: "agent@example.invalid",
    };
    const repo = join(root, "repo");
    mkdirSync(repo);
    const run = (args: string[], cwd = repo) => git(cwd, args, identity);
    run(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    run(["add", "a.txt"]);
    run(["commit", "-q", "-m", "[tag] first\n\nbody line"]);
    run(["commit", "-q", "--amend", "--no-edit"]);
    writeFileSync(join(repo, "b.txt"), "b\n");
    run(["add", "b.txt"]);
    run(["commit", "-q", "-m", "second line one\nline two"]);
    // A commit made in a linked worktree moves its branch and leaves the main HEAD log as it was.
    const linked = join(root, "linked");
    run(["worktree", "add", "-q", "-b", "topic", linked]);
    writeFileSync(join(linked, "c.txt"), "c\n");
    run(["add", "c.txt"], linked);
    run(["commit", "-q", "-m", "[tag] from the linked worktree"], linked);
    run(["worktree", "remove", "--force", linked]);

    test("the HEAD and branch logs give each written commit once, with the subject on one line", () => {
        const log = readHeadLog(join(repo, ".git"));
        if (!log) throw new Error("the repository's log was not read");
        const epoch = ((log.moves[0] as HeadMove).time_s - 100) * 1000;
        const written = writtenCommits(log.moves, log.commits, epoch).map((c) => c.command);
        expect(written.sort()).toEqual([
            "git commit -m '[tag] first'",
            "git commit -m '[tag] from the linked worktree'",
            "git commit -m 'second line one line two'",
        ]);
    });

    test("a directory without a plain HEAD log gives no record", () => {
        expect(readHeadLog(join(root, "missing"))).toBeNull();
        const bare = join(root, "empty");
        mkdirSync(bare);
        expect(readHeadLog(bare)).toBeNull();
        // A link in place of the log is no regular file, so nothing outside the repository is read.
        const linkedLog = join(root, "linked-log");
        mkdirSync(join(linkedLog, "logs"), { recursive: true });
        symlinkSync(join(repo, ".git", "logs", "HEAD"), join(linkedLog, "logs", "HEAD"));
        expect(readHeadLog(linkedLog)).toBeNull();
        const linkedDir = join(root, "linked-dir");
        symlinkSync(join(repo, ".git"), linkedDir);
        expect(readHeadLog(linkedDir)).toBeNull();
    });
});

describe("the recorded command log of a snapshot", () => {
    const snapshot: Snapshot = {
        id: "s1",
        item: "q-1",
        arm: "host",
        session: "s-1",
        turn: "e-1",
        turn_outcome: "ok",
        artefacts: [],
    };
    const probe = (type: string, check: Record<string, unknown>) =>
        ({ id: "q-1", type, check, project: "p", session: "s-1" }) as unknown as ProbeItem;
    const commit = (scenario_ms: number) => ({
        command: "git commit -m 'x'",
        exit: 0,
        scenario_ms,
    });

    test("a P13 item with a command channel gets the commits up to the end of its turn", () => {
        const p13 = probe("P13", { commands_must: ["git commit"], turns: [0, 5] });
        const commits = [commit(1_000), commit(5_000 + CLOCK_SLACK_MS), commit(8_000)];
        const got = withRecordedCommits(snapshot, p13, () => commits, 5_000);
        expect(got.artefacts).toEqual([
            {
                id: "s1:recorded-commits",
                class: "command-log",
                role: "recorded",
                commands: commits.slice(0, 2),
            },
        ]);
        expect(snapshot.artefacts).toEqual([]);
    });

    test("a run without a readable repository, another probe, and a header rule leave the snapshot as it is", () => {
        const p13 = probe("P13", { commands_must: ["git commit"], turns: [0, 5] });
        expect(withRecordedCommits(snapshot, p13, () => null, 5_000)).toBe(snapshot);
        const header = probe("P13", { first_line_must: ["^// x"], turns: [0, 5] });
        const unread = () => {
            throw new Error("the repository is read for a commit rule alone");
        };
        expect(withRecordedCommits(snapshot, header, unread, 5_000)).toBe(snapshot);
        expect(
            withRecordedCommits(snapshot, probe("P1", { commands_must: ["x"] }), unread, 0),
        ).toBe(snapshot);
    });

    test("an arm's scenario epoch comes from its own first clock offset", () => {
        const entries = [
            { kind: "ClockOffset", arm: "other", scenario_ms: 0, offset_wall_ms: 1, offset_s: 0 },
            {
                kind: "ClockOffset",
                arm: "host",
                scenario_ms: 3_000,
                offset_wall_ms: 10_000,
                offset_s: 5,
            },
            {
                kind: "ClockOffset",
                arm: "host",
                scenario_ms: 9_000,
                offset_wall_ms: 99_000,
                offset_s: 9,
            },
        ];
        expect(armEpochMs(entries, "host")).toBe(12_000);
        expect(armEpochMs(entries, "absent")).toBeNull();
        expect(
            armEpochMs([{ kind: "ClockOffset", arm: "host", scenario_ms: 0 }], "host"),
        ).toBeNull();
    });
});
