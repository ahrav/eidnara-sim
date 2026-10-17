import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    type Dirent,
    existsSync,
    lstatSync,
    mkdirSync,
    opendirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { GitBound, git, gitEnv } from "../git";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";
import { sha256Hex } from "../prereg/canonical";
import { keepCompleteLines } from "../run/journal";

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
    /** Per project, the generation of its index file; a lock a killed git left behind moves the project to the next. */
    indexGenerations?: Record<string, number>;
    /**
     * Per project, the blob ids of the source's `.gitignore` and `.gitattributes` files and the
     * digests of the clone's `.git/info/exclude` and `.git/info/attributes`.
     */
    ignores?: Record<
        string,
        { files: Record<string, string>; exclude: string | null; attributes?: string | null }
    >;
}

const EMPTY: RecorderState = { session: null, ended: null, starts: {}, last: {}, commands: [] };

/** Entries a workspace walk visits at most; a wider forest fails the probe turn. */
const WORKSPACE_ENTRY_CAP = 200_000;
/** Nested repositories a workspace may hold at most; more fail the probe turn before git runs. */
const NESTED_REPO_CAP = 1_000;
/** Bytes an ignore-rule file may hold before it reads as an unreadable, changed rule. */
const RULE_FILE_CAP = 1 << 20;
/** Rule files a workspace may hold at most; more fail the probe turn during the walk. */
const RULE_FILE_COUNT_CAP = 1_000;
/** In-tree files whose rules shape what the snapshot tree holds: ignore rules and attributes (filters, `ident`, eol). */
const RULE_FILES = new Set([".gitignore", ".gitattributes"]);

/**
 * Yields a directory's entries one at a time through `opendirSync`, so a caller's count and
 * deadline checks run before a wide directory is held in memory.
 */
export function* entriesOf(dir: string): Generator<Dirent> {
    const handle = opendirSync(dir);
    try {
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) yield entry;
    } finally {
        handle.closeSync();
    }
}

/**
 * Git's blob id of a regular file under the size cap, computed without git; any other shape
 * reads as `unreadable`, which differs from every recorded baseline.
 */
function blobId(path: string): string {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > RULE_FILE_CAP) return "unreadable";
    const content = readFileSync(path);
    return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

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
     * A git child the killed harness left running may still hold a workspace index lock, and
     * from this process nothing proves it has exited. Each index is therefore versioned: a lock
     * found at construction moves that workspace to a fresh index file, which costs one full
     * rehash, and the orphan's lock and index stay untouched on their old path.
     */
    private dropIndexLocks(): void {
        if (!existsSync(this.gitDir)) return;
        const generations = { ...this.state.indexGenerations };
        let bumped = false;
        for (const name of readdirSync(this.gitDir)) {
            const match = /^(.+?)(?:\.(\d+))?\.index\.lock$/.exec(name);
            if (!match) continue;
            const project = match[1] as string;
            const held = Number(match[2] ?? 0);
            if (held >= (generations[project] ?? 0)) {
                generations[project] = held + 1;
                bumped = true;
            }
        }
        if (bumped) {
            this.state.indexGenerations = generations;
            this.save();
        }
    }

    private indexFile(work: string): string {
        const project = basename(work);
        const generation = this.state.indexGenerations?.[project] ?? 0;
        const suffix = generation === 0 ? "" : `.${generation}`;
        return join(this.gitDir, `${project}${suffix}.index`);
    }

    /** Drops a line a kill cut from `snapshots.jsonl` and `tools.jsonl`, and creates `tools.jsonl` so a run with no tool runs still has its ledger. */
    private dropCutLine(): void {
        keepCompleteLines(join(this.armDir, "snapshots.jsonl"));
        const tools = join(this.armDir, "tools.jsonl");
        keepCompleteLines(tools);
        if (!existsSync(tools)) appendFileSync(tools, "");
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
        const scope: Record<string, string> = { GIT_DIR: this.gitDir, GIT_NO_REPLACE_OBJECTS: "1" };
        if (work) {
            scope.GIT_WORK_TREE = work;
            scope.GIT_INDEX_FILE = this.indexFile(work);
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
        writeFileSync(join(this.armDir, "tools.jsonl"), "");
    }

    /**
     * Directories under `dir` that hold a `.git` entry of their own and that the workspace's
     * ignore rules keep: git would index a committed one as a gitlink and refuse an
     * uncommitted one, so the tree leaves them out. An ignored one is outside the evidence
     * either way.
     */
    embedded(dir: string): string[] {
        return this.survey(dir).nested;
    }

    /**
     * Walks the workspace once, under the recorder bound and an entry cap, for the two things
     * the ignore rules must not hide: directories holding a `.git` of their own (kept when the
     * workspace's ignore rules leave them alone) and every `.gitignore` file, found by name on
     * disk so that a rule which ignores its own file still surfaces it.
     */
    survey(dir: string): { nested: string[]; ignoreFiles: string[] } {
        this.requireRealDir(dir);
        const found: string[] = [];
        const ignoreFiles: string[] = [];
        const deadline = Date.now() + (this.gitTimeoutMs ?? Number.POSITIVE_INFINITY);
        let seen = 0;
        const pending = [dir];
        for (let at = pending.shift(); at !== undefined; at = pending.shift()) {
            for (const entry of entriesOf(at)) {
                if (++seen > WORKSPACE_ENTRY_CAP || Date.now() > deadline) {
                    const why =
                        seen > WORKSPACE_ENTRY_CAP
                            ? `more than ${WORKSPACE_ENTRY_CAP} entries`
                            : "timed out";
                    throw new GitBound(`workspace walk of ${dir}: ${why}`);
                }
                const rel =
                    at === dir
                        ? entry.name
                        : `${relative(dir, at).split(sep).join("/")}/${entry.name}`;
                if (entry.name === ".git") {
                    if (at !== dir) found.push(relative(dir, at).split(sep).join("/"));
                    continue;
                }
                if (RULE_FILES.has(entry.name)) {
                    ignoreFiles.push(rel);
                    if (ignoreFiles.length > RULE_FILE_COUNT_CAP) {
                        throw new GitBound(
                            `workspace walk of ${dir}: more than ${RULE_FILE_COUNT_CAP} rule files`,
                        );
                    }
                }
                if (entry.isDirectory()) pending.push(join(at, entry.name));
            }
        }
        if (found.length > NESTED_REPO_CAP) {
            throw new GitBound(
                `workspace walk of ${dir}: more than ${NESTED_REPO_CAP} nested repositories`,
            );
        }
        if (found.length === 0) return { nested: [], ignoreFiles: ignoreFiles.sort() };
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
        return {
            nested: found.filter((path) => !skipped.has(path)).sort(),
            ignoreFiles: ignoreFiles.sort(),
        };
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
    trackIgnoreRules(
        project: string,
        files: Record<string, string>,
        exclude: string | null,
        attributes: string | null,
    ): void {
        this.state.ignores = { ...this.state.ignores, [project]: { files, exclude, attributes } };
        this.save();
    }

    /**
     * The ignore rules in `dir` that differ from the project's baseline, after `tree` has
     * indexed the workspace: a `.gitignore` the agent added, changed, or removed, or an edited
     * `.git/info/exclude`. A rule added in a turn would hide that turn's files from the diff.
     */
    ignoreChanges(
        dir: string,
        project: string,
        ignoreFiles = this.survey(dir).ignoreFiles,
    ): string[] {
        const baseline = this.state.ignores?.[project];
        if (!baseline) return [];
        const now: Record<string, string> = {};
        const deadline = Date.now() + (this.gitTimeoutMs ?? Number.POSITIVE_INFINITY);
        for (const path of ignoreFiles) {
            if (Date.now() > deadline)
                throw new GitBound(`rule files of ${dir}: hashing timed out`);
            now[path] = blobId(join(dir, path));
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
        if (this.excludeDigest(dir) !== baseline.exclude)
            changes.push(".git/info/exclude (changed)");
        if (this.excludeDigest(dir, "attributes") !== (baseline.attributes ?? null)) {
            changes.push(".git/info/attributes (changed)");
        }
        return changes.sort();
    }

    /**
     * The digest of `.git/info/exclude` when `.git`, `.git/info`, and the file are each a real
     * directory or regular file; a missing file reads as null, and any other shape (a symlink,
     * a FIFO, a directory in the file's place) reads as a changed rule.
     */
    excludeDigest(dir: string, name: "exclude" | "attributes" = "exclude"): string | null {
        const gitDir = join(dir, ".git");
        const info = join(gitDir, "info");
        const exclude = join(info, name);
        for (const at of [gitDir, info]) {
            const stat = lstatSync(at, { throwIfNoEntry: false });
            if (stat === undefined) return at === gitDir ? "unreadable" : null;
            if (!stat.isDirectory()) return "unreadable";
        }
        const stat = lstatSync(exclude, { throwIfNoEntry: false });
        if (stat === undefined) return null;
        if (!stat.isFile() || stat.size > RULE_FILE_CAP) return "unreadable";
        return sha256Hex(readFileSync(exclude, "utf8"));
    }

    tree(dir: string, nested = this.embedded(dir)): string {
        const excluded = nested.map((path) => `:(exclude)${path}`);
        this.git(["add", "--all", "--", ".", ...excluded], dir);
        if (nested.length > 0) {
            this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...nested], dir);
        }
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

    /**
     * Adds tool runs: each is appended to `tools.jsonl` with the turn it belongs to, and a run
     * whose `call` id matches an earlier record replaces that record in the session's commands
     * and keeps its recorded start time, the moment the run began.
     */
    addTools(tools: Command[], turn: string | null): void {
        if (tools.length === 0) return;
        const lines = tools.map((t) => `${JSON.stringify({ turn, ...t })}\n`).join("");
        appendFileSync(join(this.armDir, "tools.jsonl"), lines);
        for (const run of tools) {
            const at = run.call ? this.state.commands.findIndex((c) => c.call === run.call) : -1;
            if (at === -1) this.state.commands.push(run);
            else {
                const earlier = this.state.commands[at] as Command;
                this.state.commands[at] = { ...run, scenario_ms: earlier.scenario_ms };
            }
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
