import { afterAll, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../git";
import type { ProbeItem } from "../scenario/compile";
import type { Snapshot } from "./artefacts";
import {
    armClock,
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
    writtenCommits(
        moves,
        new Map(commits.map(([n, c]) => [id(n), c])),
        (stampMs) => stampMs - EPOCH_MS,
    )?.map((c) => [c.command, c.scenario_ms]);

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

    test("a merge the agent concluded with git commit counts; a merge, a pull, and an applied patch do not", () => {
        const commits: [number, CommitObject][] = [
            [2, agent("[tag] merge topic by hand", 10)],
            [3, agent("Merge branch 'topic'", 20)],
            [4, agent("upstream subject", 30)],
            [5, agent("patch subject", 40)],
        ];
        const moves = [
            move(1, 2, 10, "commit (merge): [tag] merge topic by hand"),
            move(2, 3, 20, "merge topic: Merge made by the 'ort' strategy."),
            move(3, 4, 30, "pull: Fast-forward"),
            move(4, 5, 40, "am: patch subject"),
        ];
        expect(subjects(moves, commits)).toEqual([
            ["git commit -m '[tag] merge topic by hand'", 10_000],
        ]);
    });

    test("a placed commit counts only when it is the agent's and fresh", () => {
        // An old commit reached for the first time (a checkout of history) was made long before.
        const old: [number, CommitObject][] = [[2, agent("old history", 100 - 601)]];
        expect(subjects([move(1, 2, 100, "reset: moving to HEAD~3")], old)).toEqual([]);
        const fresh: [number, CommitObject][] = [[2, agent("placed", 100 - 600)]];
        expect(subjects([move(1, 2, 100, "reset: moving to 0002")], fresh)).toHaveLength(1);
        // A checkout or a branch switch reaches a commit and writes none.
        expect(subjects([move(1, 2, 100, "checkout: moving from main to 0002")], fresh)).toEqual(
            [],
        );
        // The harness's committer on a labelled move is a commit the agent made under that name.
        const named: [number, CommitObject][] = [[2, harness("[tag] as sim-user", 100)]];
        expect(subjects([move(1, 2, 100, "commit: [tag] as sim-user")], named)).toHaveLength(1);
        expect(subjects([move(1, 2, 100, "reset: moving to 0002")], named)).toHaveLength(1);
        expect(subjects([move(1, 2, 100, "")], named)).toEqual([]);
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
        // A time past the safe integers is no time.
        expect(
            parseHeadLog(`${id(1)} ${id(2)} a <a@b> ${"9".repeat(40)} +0000\tcommit: x`),
        ).toEqual([]);
        // A message that ends like a time is the message; the time is the one ahead of the tab.
        const timed = `${id(1)} ${id(2)} a <a@b> 1700000000 +0000\tcommit: at 1000000300 +0000`;
        expect(parseHeadLog(timed)).toEqual([
            {
                old: id(1),
                new: id(2),
                time_s: 1_700_000_000,
                message: "commit: at 1000000300 +0000",
            },
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
        const written = writtenCommits(log.moves, log.commits, (ms) => ms - epoch)?.map(
            (c) => c.command,
        );
        expect(written?.sort()).toEqual([
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
        const linkedDir = join(root, "linked-dir");
        symlinkSync(join(repo, ".git"), linkedDir);
        expect(readHeadLog(linkedDir)).toBeNull();
    });

    test("a link in place of a log, or of a directory of logs, gives no record of another repository", () => {
        /** A second repository whose objects git can print, with one commit of its own. */
        const other = (name: string) => {
            const dir = join(root, name);
            mkdirSync(dir);
            run(["init", "-q", "-b", "main"], dir);
            run(["commit", "-q", "--allow-empty", "-m", "own commit"], dir);
            return join(dir, ".git");
        };
        expect(readHeadLog(other("plain"))?.moves).toHaveLength(1);
        const linkedLog = other("linked-log");
        rmSync(join(linkedLog, "logs", "HEAD"));
        symlinkSync(join(repo, ".git", "logs", "HEAD"), join(linkedLog, "logs", "HEAD"));
        expect(readHeadLog(linkedLog)).toBeNull();
        const linkedLogs = other("linked-logs");
        rmSync(join(linkedLogs, "logs"), { recursive: true });
        symlinkSync(join(repo, ".git", "logs"), join(linkedLogs, "logs"));
        expect(readHeadLog(linkedLogs)).toBeNull();
        // A linked directory of branch logs is left unread; the repository's own HEAD log stands.
        const linkedHeads = other("linked-heads");
        const heads = join(linkedHeads, "logs", "refs", "heads");
        rmSync(heads, { recursive: true });
        symlinkSync(join(repo, ".git", "logs", "refs", "heads"), heads);
        expect(readHeadLog(linkedHeads)?.moves.map((m) => m.message)).toEqual([
            "commit (initial): own commit",
        ]);
    });

    test("a replace ref leaves each id its own commit, and a repository that reads another object store gives no record", () => {
        const dir = join(root, "replaced");
        mkdirSync(dir);
        run(["init", "-q", "-b", "main"], dir);
        run(["commit", "-q", "--allow-empty", "-m", "first subject"], dir);
        const first = run(["rev-parse", "HEAD"], dir).trim();
        run(["commit", "-q", "--allow-empty", "-m", "second subject"], dir);
        run(["replace", first, "HEAD"], dir);
        const gitDir = join(dir, ".git");
        expect(readHeadLog(gitDir)?.commits.get(first)?.subject).toBe("first subject");
        writeFileSync(
            join(gitDir, "objects", "info", "alternates"),
            `${join(repo, ".git", "objects")}\n`,
        );
        expect(readHeadLog(gitDir)).toBeNull();
        rmSync(join(gitDir, "objects", "info", "alternates"));
        writeFileSync(join(gitDir, "commondir"), `${join(repo, ".git")}\n`);
        expect(readHeadLog(gitDir)).toBeNull();
    });

    test("a promisor remote in the repository's config starts no fetch for a missing object", () => {
        const dir = join(root, "promisor");
        mkdirSync(dir);
        run(["init", "-q", "-b", "main"], dir);
        run(["commit", "-q", "--allow-empty", "-m", "own commit"], dir);
        const marker = join(root, "fetched");
        const gitDir = join(dir, ".git");
        run(["config", "remote.origin.url", join(root, "repo")], dir);
        run(["config", "remote.origin.promisor", "true"], dir);
        run(["config", "remote.origin.partialclonefilter", "blob:none"], dir);
        run(["config", "extensions.partialClone", "origin"], dir);
        run(["config", "remote.origin.uploadpack", `touch ${marker}; git-upload-pack`], dir);
        const missing = "1".repeat(40);
        appendFileSync(
            join(gitDir, "logs", "HEAD"),
            `${ZERO} ${missing} a <a@b> 1700000000 +0000\tcommit: missing object\n`,
        );
        const log = readHeadLog(gitDir);
        expect(log?.moves).toHaveLength(2);
        expect(log?.commits.has(missing)).toBe(false);
        expect(existsSync(marker)).toBe(false);
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
        const commits = [commit(1_000), commit(5_000), commit(5_001)];
        const got = withRecordedCommits(
            snapshot,
            p13,
            () => commits,
            () => 5_000,
        );
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
        expect(
            withRecordedCommits(
                snapshot,
                p13,
                () => null,
                () => 5_000,
            ),
        ).toBe(snapshot);
        const header = probe("P13", { first_line_must: ["^// x"], turns: [0, 5] });
        const unread = (): never => {
            throw new Error("the repository and the journal are read for a commit rule alone");
        };
        expect(withRecordedCommits(snapshot, header, unread, unread)).toBe(snapshot);
        expect(
            withRecordedCommits(snapshot, probe("P1", { commands_must: ["x"] }), unread, unread),
        ).toBe(snapshot);
    });

    // The arm's clock as the scheduler journals it. The arm starts at wall 1,000 with offset 0.
    // Turn A runs from wall 1,000 to 5,000 (scenario 0 to 4,000). After one idle second turn B
    // runs from wall 6,000 to 8,000 (scenario 4,000 to 6,000). The clock then jumps to scenario
    // 100,000: the offset 92 s is written at wall 8,990 and journaled at 9,000. Turn C runs from
    // wall 9,500 to 11,500. The run resumes at wall 200,000 with offset -97 s, and turn D runs
    // from wall 200,500 to 204,500.
    const turn = (event: string, from: number, to: number, scenario: number) => [
        { kind: "BeginTurn", event, arm: "host", wall_ms: from, scenario_ms: scenario },
        { kind: "EndTurn", event, arm: "host", wall_ms: to, scenario_ms: scenario + to - from },
    ];
    const offset = (wall: number, seconds: number, scenario: number, journaled = wall) => ({
        kind: "ClockOffset",
        arm: "host",
        wall_ms: journaled,
        scenario_ms: scenario,
        offset_s: seconds,
        offset_wall_ms: wall,
    });
    const journal = [
        { ...offset(0, 500, 0), arm: "other" },
        offset(1_000, 0, 0),
        ...turn("e-a", 1_000, 5_000, 0),
        ...turn("e-b", 6_000, 8_000, 4_000),
        { kind: "AdvanceClock", arm: "host", wall_ms: 8_980, scenario_ms: 100_000 },
        offset(8_990, 92, 100_000, 9_000),
        ...turn("e-c", 9_500, 11_500, 100_000),
        offset(200_000, -97, 102_000),
        ...turn("e-d", 200_500, 204_500, 102_000),
    ];
    const clock = armClock(journal, "host");
    if (!clock) throw new Error("the arm has a clock");

    test("a stamp maps through the offset in effect and the journal entries around it", () => {
        // Inside a turn scenario time runs with the stamp.
        expect(clock(3_500)).toBe(2_500);
        expect(clock(6_500)).toBe(4_500);
        // Between two turns it holds at the first turn's end, with a jump after it or without.
        expect(clock(5_500)).toBe(4_000);
        expect(clock(8_500)).toBe(6_000);
        // After the jump a stamp carries the new offset: wall 10,500 reads 102,500.
        expect(clock(10_500 + 92_000)).toBe(101_000);
        expect(clock(0)).toBe("outside");
        expect(armClock(journal, "absent")).toBeNull();
        expect(armClock([{ arm: "host", wall_ms: 1, scenario_ms: 0 }], "host")).toBeNull();
        // The order of the journal's lines decides nothing.
        const shuffled = armClock([...journal].reverse(), "host");
        expect(shuffled?.(6_500)).toBe(4_500);
    });

    test("a stamp two offsets claim goes to the one whose wall time lies in a turn", () => {
        // After the resume the arm's clock stepped back, so turn D's stamps repeat earlier ones.
        // Wall 202,000 reads 105,000; under the offset before it that stamp is wall 13,000,
        // which lies in no turn.
        expect(clock(202_000 - 97_000)).toBe(103_500);
        // Stamp 103,500 is the end of turn C under one offset and the start of turn D under the
        // other, and stamp 110,000 lies in no turn under either.
        expect(clock(103_500)).toBe("ambiguous");
        expect(clock(110_000)).toBe("ambiguous");
    });

    test("a written commit the clock cannot place leaves the repository without a record", () => {
        const commits = new Map([[id(2), agent("[tag] first", 10)]]);
        const at = (placed: "ambiguous" | "outside") => () => placed;
        const made = [move(1, 2, 10, "commit: [tag] first")];
        expect(writtenCommits(made, commits, at("ambiguous"))).toBeNull();
        expect(writtenCommits(made, commits, at("outside"))).toEqual([]);
        // A move that holds no written message is placed by no clock.
        const picked = [move(1, 2, 10, "rebase (pick): [tag] first")];
        expect(writtenCommits(picked, commits, at("ambiguous"))).toEqual([]);
    });
});
