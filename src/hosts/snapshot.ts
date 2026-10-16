import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { GitBound, git, gitEnv } from "../git";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";
import { sha256Hex } from "../prereg/canonical";

interface RecorderState {
    session: string | null;
    /**
     * The last session whose end was recorded. A resume replays a `session_start` and
     * `session_end` the journal has not closed; matching this id leaves both trees as recorded.
     */
    ended?: string | null;
    starts: Record<string, string>;
    last: Record<string, { from: string; to: string }>;
    commands: Command[];
    /** Per project, the paths the source repository tracks although its ignore rules match them. */
    forced?: Record<string, string[]>;
    /** Per project, the blob ids of the source's `.gitignore` files and the digest of `.git/info/exclude`. */
    ignores?: Record<string, { files: Record<string, string>; exclude: string | null }>;
}

const EMPTY: RecorderState = { session: null, ended: null, starts: {}, last: {}, commands: [] };

/** Entries a workspace walk visits at most; a wider forest fails the probe turn. */
const WORKSPACE_ENTRY_CAP = 200_000;

export class SnapshotRecorder {
    private readonly gitDir: string;
    private readonly stateFile: string;
    private state: RecorderState;

    constructor(
        private readonly armDir: string,
        private readonly arm: string,
        private readonly callsFor: (session: string) => CallView[],
        /** Bound on each git run against a workspace; a run past it throws `GitBound`. */
        private readonly gitTimeoutMs?: number,
    ) {
        mkdirSync(armDir, { recursive: true });
        this.gitDir = join(armDir, "snapshot.git");
        this.stateFile = join(armDir, "snapshot-state.json");
        this.state = existsSync(this.stateFile)
            ? (JSON.parse(readFileSync(this.stateFile, "utf8")) as RecorderState)
            : structuredClone(EMPTY);
        this.dropCutLine();
        this.dropIndexLocks();
    }

    /**
     * The run lease makes this recorder the only writer of its repository. A git child the
     * killed harness left running may still hold an `<project>.index.lock`; it runs at most
     * the recorder's bound, so a lock that outlives that bound after construction is stale and
     * is removed.
     */
    private dropIndexLocks(): void {
        if (!existsSync(this.gitDir)) return;
        const locks = readdirSync(this.gitDir).filter((name) => name.endsWith(".index.lock"));
        if (locks.length === 0) return;
        const deadline = Date.now() + (this.gitTimeoutMs ?? 0);
        while (Date.now() < deadline && locks.some((name) => existsSync(join(this.gitDir, name)))) {
            Bun.sleepSync(50);
        }
        for (const name of locks) rmSync(join(this.gitDir, name), { force: true });
    }

    /**
     * `dropCutLine` truncates `snapshots.jsonl` to its newline-terminated prefix: a line cut by
     * a kill mid-append is discarded and the next record starts at a line boundary.
     */
    private dropCutLine(): void {
        const path = join(this.armDir, "snapshots.jsonl");
        if (!existsSync(path)) return;
        const text = readFileSync(path, "utf8");
        const complete = text.slice(0, text.lastIndexOf("\n") + 1);
        if (complete.length < text.length) truncateSync(path, Buffer.byteLength(complete));
    }

    /**
     * Runs git against the recorder's own bare repository under the arm directory, outside
     * the sandbox. The agent can write the workspace's `.git`, so its config (filters,
     * fsmonitor, external diff, textconv, `core.worktree`) never applies: `GIT_DIR` names the
     * recorder's repository and `GIT_WORK_TREE` the workspace. Each workspace keeps its own
     * index there, so a later tree rehashes only the files whose stat data changed.
     */
    private git(args: string[], work?: string): string {
        if (work) this.requireRealDir(work);
        if (!existsSync(this.gitDir)) git(this.armDir, ["init", "--quiet", "--bare", this.gitDir]);
        const scope: Record<string, string> = { GIT_DIR: this.gitDir };
        if (work) {
            scope.GIT_WORK_TREE = work;
            scope.GIT_INDEX_FILE = join(this.gitDir, `${basename(work)}.index`);
        }
        try {
            return git(work ?? this.armDir, args, scope, this.gitTimeoutMs);
        } catch (caught) {
            if (caught instanceof GitBound && scope.GIT_INDEX_FILE) {
                rmSync(`${scope.GIT_INDEX_FILE}.lock`, { force: true });
            }
            throw caught;
        }
    }

    private save(): void {
        writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state));
        renameSync(`${this.stateFile}.tmp`, this.stateFile);
    }

    /**
     * The agent can rename a workspace and put a symlink at its path, which `GIT_WORK_TREE`
     * would follow. A work tree is accepted when every path component below the arm
     * directory is a real directory.
     */
    private requireRealDir(work: string): void {
        const expected = join(realpathSync(this.armDir), relative(this.armDir, work));
        if (realpathSync(work) !== expected) {
            throw new Error(`workspace ${work} is a symlink or lies behind one`);
        }
    }

    clear(): void {
        this.state = structuredClone(EMPTY);
        rmSync(this.stateFile, { force: true });
        rmSync(this.gitDir, { recursive: true, force: true });
        rmSync(join(this.armDir, "snapshots.jsonl"), { force: true });
    }

    /**
     * Directories under `dir` that hold a `.git` entry of their own and that the workspace's
     * ignore rules keep: git would index a committed one as a gitlink and refuse an
     * uncommitted one, so the tree leaves them out. An ignored one is outside the evidence
     * either way.
     */
    embedded(dir: string): string[] {
        this.requireRealDir(dir);
        const found: string[] = [];
        const deadline = Date.now() + (this.gitTimeoutMs ?? Number.POSITIVE_INFINITY);
        let seen = 0;
        const pending = [dir];
        for (let at = pending.shift(); at !== undefined; at = pending.shift()) {
            for (const entry of readdirSync(at, { withFileTypes: true })) {
                if (++seen > WORKSPACE_ENTRY_CAP || Date.now() > deadline) {
                    const why =
                        seen > WORKSPACE_ENTRY_CAP
                            ? `more than ${WORKSPACE_ENTRY_CAP} entries`
                            : "timed out";
                    throw new GitBound(`workspace walk of ${dir}: ${why}`);
                }
                if (entry.name === ".git") {
                    if (at !== dir) found.push(relative(dir, at).split(sep).join("/"));
                    continue;
                }
                if (entry.isDirectory()) pending.push(join(at, entry.name));
            }
        }
        if (found.length === 0) return [];
        const ignored = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
            cwd: dir,
            env: gitEnv({ GIT_DIR: this.gitDir, GIT_WORK_TREE: dir }),
            encoding: "utf8",
            input: found.map((path) => `${path}\0`).join(""),
            ...(this.gitTimeoutMs ? { timeout: this.gitTimeoutMs, killSignal: "SIGKILL" } : {}),
        });
        if ((ignored.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
            throw new GitBound(`git check-ignore: timed out after ${this.gitTimeoutMs} ms`);
        }
        const skipped = new Set(ignored.stdout.split("\0").filter(Boolean));
        return found.filter((path) => !skipped.has(path)).sort();
    }

    /**
     * Records the paths a project's source tracks although its ignore rules match them, so
     * `tree` adds them with `--force`; the recorder's own index starts empty and `add --all`
     * alone would treat them as ignored.
     */
    trackIgnored(project: string, paths: string[]): void {
        this.state.forced = { ...this.state.forced, [project]: paths };
        this.save();
    }

    /**
     * Records the project's baseline ignore rules: the blob id of every `.gitignore` the source
     * tracks and the digest of the clone's `.git/info/exclude`.
     */
    trackIgnoreRules(project: string, files: Record<string, string>, exclude: string | null): void {
        this.state.ignores = { ...this.state.ignores, [project]: { files, exclude } };
        this.save();
    }

    /**
     * The ignore rules in `dir` that differ from the project's baseline, after `tree` has
     * indexed the workspace: a `.gitignore` the agent added, changed, or removed, or an edited
     * `.git/info/exclude`. A rule added in a turn would hide that turn's files from the diff.
     */
    ignoreChanges(dir: string, project: string): string[] {
        const baseline = this.state.ignores?.[project];
        if (!baseline) return [];
        const listed = this.git(["ls-files", "-s", "-z", "--", ".gitignore", "**/.gitignore"], dir);
        const now: Record<string, string> = {};
        for (const row of listed.split("\0").filter(Boolean)) {
            const [meta, path] = row.split("\t") as [string, string];
            now[path] = meta.split(" ")[1] as string;
        }
        const changes: string[] = [];
        for (const path of new Set([
            ...Object.keys(baseline.files),
            ...Object.keys(now),
        ]).values()) {
            const was = baseline.files[path];
            const is = now[path];
            if (was === is) continue;
            changes.push(
                `${path} (${was === undefined ? "added" : is === undefined ? "removed" : "changed"})`,
            );
        }
        const digest = this.excludeDigest(dir);
        if (digest !== baseline.exclude) changes.push(".git/info/exclude (changed)");
        return changes.sort();
    }

    /**
     * The digest of `.git/info/exclude` when `.git`, `.git/info`, and the file are each a real
     * directory or regular file; a missing file reads as null, and any other shape (a symlink,
     * a FIFO, a directory in the file's place) reads as a changed rule.
     */
    excludeDigest(dir: string): string | null {
        const gitDir = join(dir, ".git");
        const info = join(gitDir, "info");
        const exclude = join(info, "exclude");
        for (const at of [gitDir, info]) {
            const stat = lstatSync(at, { throwIfNoEntry: false });
            if (stat === undefined) return at === gitDir ? "unreadable" : null;
            if (!stat.isDirectory()) return "unreadable";
        }
        const stat = lstatSync(exclude, { throwIfNoEntry: false });
        if (stat === undefined) return null;
        if (!stat.isFile()) return "unreadable";
        return sha256Hex(readFileSync(exclude, "utf8"));
    }

    tree(dir: string, nested = this.embedded(dir)): string {
        const excluded = nested.map((path) => `:(exclude)${path}`);
        this.git(["add", "--all", "--", ".", ...excluded], dir);
        const root = realpathSync(dir);
        const inPlace = (path: string): boolean => {
            try {
                return realpathSync(join(dir, path)) === join(root, path);
            } catch {
                return false;
            }
        };
        const forced = (this.state.forced?.[basename(dir)] ?? []).filter(
            (path) =>
                inPlace(path) &&
                !nested.some((repo) => path === repo || path.startsWith(`${repo}/`)),
        );
        if (forced.length > 0) this.git(["add", "--force", "--", ...forced], dir);
        return this.git(["write-tree"], dir).trim();
    }

    /** `--text` diffs every file as text, so a NUL byte or a `-diff` attribute hides no added line. */
    private diff(from: string, to: string): string {
        const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "--text"];
        return this.git(["diff", ...flags, from, to]);
    }

    /**
     * Opens a session: its start tree is the base of the prior-session diff later sessions
     * carry. A git run past its bound leaves the session open with no start tree, so that
     * session contributes no prior-session diff.
     */
    sessionStart(session: string, project: string, dir: string): void {
        if (this.state.session === session || this.state.ended === session) return;
        const start = this.boundedTree(dir);
        this.state.session = session;
        if (start) this.state.starts[project] = start;
        else delete this.state.starts[project];
        this.state.commands = [];
        this.save();
    }

    sessionEnd(session: string, project: string, dir: string): void {
        if (this.state.ended === session) return;
        const from = this.state.starts[project];
        const to = from ? this.boundedTree(dir) : null;
        if (from && to) this.state.last[project] = { from, to };
        else delete this.state.last[project];
        this.state.session = null;
        this.state.ended = session;
        this.save();
    }

    private boundedTree(dir: string): string | null {
        try {
            return this.tree(dir);
        } catch (caught) {
            if (!(caught instanceof GitBound)) throw caught;
            console.error(`snapshot: ${caught.message}`);
            return null;
        }
    }

    /** Adds tool runs; a run whose `call` id matches an earlier record replaces that record. */
    addTools(tools: Command[]): void {
        if (tools.length === 0) return;
        for (const run of tools) {
            const at = run.call ? this.state.commands.findIndex((c) => c.call === run.call) : -1;
            if (at === -1) this.state.commands.push(run);
            else this.state.commands[at] = run;
        }
        this.save();
    }

    capture(
        e: { probe: string; session: string; id: string },
        project: string,
        dir: string,
        before: string,
        turnTools: Command[],
        failed: boolean,
        after = this.tree(dir),
    ): string {
        const id = `${this.arm}:${e.probe}:${e.id}`;
        const commands = [...this.state.commands];
        const artefacts: Artefact[] = [
            {
                id: `${id}:diff`,
                class: "diff",
                role: "turn",
                patch: this.diff(before, after),
            },
            { id: `${id}:turn-commands`, class: "command-log", role: "turn", commands: turnTools },
            { id: `${id}:session-commands`, class: "command-log", role: "session", commands },
            { id: `${id}:calls`, class: "proxy-call", calls: this.callsFor(e.session) },
        ];
        const prior = this.state.last[project];
        if (prior) {
            const patch = this.diff(prior.from, prior.to);
            artefacts.push({ id: `${id}:prior-diff`, class: "diff", role: "prior-session", patch });
        }
        const snapshot: Snapshot = {
            id,
            item: e.probe,
            arm: this.arm,
            session: e.session,
            turn: e.id,
            turn_outcome: failed ? "failed" : "ok",
            artefacts,
        };
        appendFileSync(join(this.armDir, "snapshots.jsonl"), `${JSON.stringify(snapshot)}\n`);
        return id;
    }
}
