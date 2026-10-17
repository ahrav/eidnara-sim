import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
    /** Per project, why the last session left no tree pair; the next session's snapshots carry it. */
    lastGap?: Record<string, string>;
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

const EMPTY: RecorderState = { session: null, ended: null, starts: {}, last: {} };

/**
 * A restored state's index generations are the only values that reach a path: each must be a
 * nonnegative safe integer, so `GIT_INDEX_FILE` stays under the recorder's repository.
 */
function restoredState(raw: unknown): RecorderState {
    const state = raw as RecorderState;
    for (const [project, generation] of Object.entries(state.indexGenerations ?? {})) {
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new Error(
                `snapshot state names index generation ${JSON.stringify(generation)} for ${project}`,
            );
        }
    }
    return state;
}

/** A git run the workspace's own rule files made fail: the probe turn fails and the run goes on. */
export class WorkspaceRefused extends GitBound {}

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
        this.commandsFile = join(armDir, "commands.jsonl");
        this.state = existsSync(this.stateFile)
            ? restoredState(JSON.parse(readFileSync(this.stateFile, "utf8")))
            : structuredClone(EMPTY);
        this.dropCutLine();
        this.dropIndexLocks();
        this.loadCommands();
    }

    /**
     * The open session's tool runs, one appended line each, so a tool-heavy session costs one
     * append per report; a run whose `call` id matches an earlier line replaces that record.
     */
    private readonly commandsFile: string;
    private commands: Command[] = [];
    private readonly commandAt = new Map<string, number>();

    private loadCommands(): void {
        this.commands = [];
        this.commandAt.clear();
        if (!existsSync(this.commandsFile)) return;
        const end = keepCompleteLines(this.commandsFile);
        if (end === 0) return;
        for (const line of readFileSync(this.commandsFile, "utf8").split("\n")) {
            if (line) this.place(JSON.parse(line) as Command);
        }
    }

    private place(run: Command): void {
        const at = run.call ? this.commandAt.get(run.call) : undefined;
        if (at === undefined) {
            if (run.call) this.commandAt.set(run.call, this.commands.length);
            this.commands.push(run);
        } else {
            this.commands[at] = run;
        }
    }

    /** The open session's tool runs so far, in report order. */
    sessionCommands(): Command[] {
        return [...this.commands];
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

    /**
     * `dropCutLine` truncates `snapshots.jsonl` to its newline-terminated prefix: a line cut by
     * a kill mid-append is discarded and the next record starts at a line boundary.
     */
    private dropCutLine(): void {
        keepCompleteLines(join(this.armDir, "snapshots.jsonl"));
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

    /** Writes the state through a fresh, exclusively created staging file, so a symlink planted at a fixed staging path is never followed. */
    private save(): void {
        const staging = `${this.stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(staging, JSON.stringify(this.state), { flag: "wx" });
        renameSync(staging, this.stateFile);
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
        this.commands = [];
        this.commandAt.clear();
        rmSync(this.commandsFile, { force: true });
        rmSync(this.stateFile, { force: true });
        rmSync(this.gitDir, { recursive: true, force: true });
        rmSync(join(this.armDir, "snapshots.jsonl"), { force: true });
        rmSync(join(this.armDir, "tools.jsonl"), { force: true });
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
        for (let next = 0; next < pending.length; next++) {
            const at = pending[next] as string;
            if (Date.now() >= deadline) throw new GitBound(`workspace walk of ${dir}: timed out`);
            for (const entry of entriesOf(at)) {
                if (++seen > WORKSPACE_ENTRY_CAP || Date.now() >= deadline) {
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
            if (Date.now() >= deadline)
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
        const excluded = nested.map((path) => `:(exclude,literal)${path}`);
        this.addAll(dir, excluded);
        if (nested.length > 0) {
            const rm = ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...nested];
            this.git(["--literal-pathspecs", ...rm], dir);
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
        if (forced.length > 0)
            this.git(["--literal-pathspecs", "add", "--force", "--", ...forced], dir);
        return this.git(["write-tree"], dir).trim();
    }

    /**
     * Indexes the workspace. The workspace's own attribute rules shape how git reads each file,
     * and a rule the agent wrote can make that read fail; such a failure under changed rule
     * files fails the probe turn, as a changed rule file does, instead of stopping the run.
     */
    private addAll(dir: string, excluded: string[]): void {
        try {
            this.git(["add", "--all", "--", ".", ...excluded], dir);
        } catch (caught) {
            if (caught instanceof GitBound) throw caught;
            const { ignoreFiles } = this.survey(dir);
            const changed = this.ignoreChanges(dir, basename(dir), ignoreFiles);
            if (changed.length === 0) throw caught;
            throw new WorkspaceRefused(
                `git add failed under changed rule files (${changed.join(", ")}): ${String(caught)}`,
            );
        }
    }

    /** `--text` diffs every file as text, so a NUL byte or a `-diff` attribute hides no added line. */
    private diff(from: string, to: string): string {
        for (const id of [from, to]) {
            if (!/^[0-9a-f]{40}$/.test(id)) {
                throw new Error(
                    `snapshot state names ${JSON.stringify(id)} where a tree id belongs`,
                );
            }
        }
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
        this.commands = [];
        this.commandAt.clear();
        writeFileSync(this.commandsFile, "");
        this.save();
    }

    /**
     * Closes a session: its end tree completes the prior-session diff later sessions carry. The
     * workspace's rule files are checked against the reset baseline first, as at a probe turn,
     * since a rule the session added would shape that tree; a changed rule or a bounded git run
     * leaves the project without a tree pair and records why, and the next session's snapshots
     * carry that reason in place of the prior-session diff.
     */
    sessionEnd(session: string, project: string, dir: string): void {
        if (this.state.ended === session) return;
        const from = this.state.starts[project];
        let to: string | null = null;
        let gap: string | null = from ? null : "the session's start tree was not recorded";
        if (from) {
            try {
                const { ignoreFiles } = this.survey(dir);
                const changed = this.ignoreChanges(dir, project, ignoreFiles);
                if (changed.length > 0) gap = `rule files changed: ${changed.join(", ")}`;
                else to = this.tree(dir);
            } catch (caught) {
                if (!(caught instanceof GitBound)) throw caught;
                console.error(`snapshot: ${caught.message}`);
                gap = caught.message;
            }
        }
        if (from && to) {
            this.state.last[project] = { from, to };
            delete this.state.lastGap?.[project];
        } else {
            delete this.state.last[project];
            this.state.lastGap = { ...this.state.lastGap, [project]: gap ?? "unrecorded" };
        }
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
     * Adds tool runs; a run whose `call` id matches an earlier record replaces that record and
     * keeps its recorded start time, the moment the run began.
     */
    addTools(tools: Command[]): void {
        if (tools.length === 0) return;
        const lines: string[] = [];
        for (const run of tools) {
            const at = run.call ? this.commandAt.get(run.call) : undefined;
            const earlier = at === undefined ? undefined : this.commands[at];
            const placed = earlier ? { ...run, scenario_ms: earlier.scenario_ms } : run;
            this.place(placed);
            lines.push(JSON.stringify(placed));
        }
        appendFileSync(this.commandsFile, `${lines.join("\n")}\n`);
    }

    /** Appends a turn's finished tool runs to `tools.jsonl`, each tagged with the turn id (null at a session end). */
    logTurnTools(tools: Command[], turn: string | null): void {
        if (tools.length === 0) return;
        const lines = tools.map((t) => `${JSON.stringify({ turn, ...t })}\n`).join("");
        appendFileSync(join(this.armDir, "tools.jsonl"), lines);
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
        const commands = [...this.commands];
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
        const gap = this.state.lastGap?.[project];
        if (prior) {
            const patch = this.diff(prior.from, prior.to);
            artefacts.push({ id: `${id}:prior-diff`, class: "diff", role: "prior-session", patch });
        } else if (gap) {
            const role = "prior-session";
            artefacts.push({
                id: `${id}:prior-diff`,
                class: "diff",
                role,
                patch: "",
                refused: gap,
            });
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
