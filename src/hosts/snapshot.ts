import { randomBytes } from "node:crypto";
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
import { basename, dirname, join, relative, sep } from "node:path";
import { GitBound, git, gitBytes } from "../git";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";
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
     * Per project, the blob ids of the `.gitignore` and `.gitattributes` files of its fresh
     * clone: the baseline rules every tree of that project is built under. The blobs are in
     * the recorder's repository.
     */
    ignores?: Record<string, { files: Record<string, string> }>;
    /**
     * Per project, the tree of its fresh clone, taken before any agent turn. A directory this
     * tree holds is the project's own, whatever rule file a turn writes into it.
     */
    baseTrees?: Record<string, string>;
}

const EMPTY: RecorderState = { session: null, ended: null, starts: {}, last: {} };

/**
 * A restored state's index generations and baseline rule paths reach a path. Each generation
 * must be a nonnegative safe integer, so `GIT_INDEX_FILE` stays under the recorder's repository;
 * each rule path must be a relative path to a rule file, and its id a blob id, so the baseline
 * mirror stays under the recorder's repository.
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
    for (const [project, baseline] of Object.entries(state.ignores ?? {})) {
        for (const [path, id] of Object.entries(baseline?.files ?? {})) {
            const parts = path.split("/");
            const plain = parts.every((part) => part !== "" && part !== "." && part !== "..");
            if (!plain || !RULE_FILES.has(parts.at(-1) as string) || !OBJECT_ID.test(String(id))) {
                throw new Error(
                    `snapshot state names rule file ${JSON.stringify(path)} at ${JSON.stringify(id)} for ${project}`,
                );
            }
        }
    }
    for (const [project, id] of Object.entries(state.baseTrees ?? {})) {
        if (!OBJECT_ID.test(String(id))) {
            throw new Error(`snapshot state names base tree ${JSON.stringify(id)} for ${project}`);
        }
    }
    return state;
}

/** Entries a workspace walk visits at most; a wider forest fails the probe turn. */
const WORKSPACE_ENTRY_CAP = 200_000;
/** Nested repositories a workspace may hold at most; more fail the probe turn before git runs. */
const NESTED_REPO_CAP = 1_000;
/** In-tree files whose rules shape what a git tree holds: ignore rules and attributes (filters, `ident`, eol). */
const RULE_FILES = new Set([".gitignore", ".gitattributes"]);
const OBJECT_ID = /^[0-9a-f]{40}$/;
/** Git's blob id of the two bytes `a\n`: what `a\r\n` is stored as under `* text eol=lf`. */
const LF_BLOB = "78981922613b2afb6025042ff6bd878ac1994e85";
/** Whether this process has seen its git read attributes from `GIT_ATTR_SOURCE`. */
let attributeSourceHonored = false;

/** The ignore patterns that match every path below the rule file's directory. */
const EVERY_PATH = new Set(["*", "**", "/*", "/**", "**/*", "/**/*"]);

/**
 * Whether a `.gitignore` body ignores every path of its directory: one of its patterns matches
 * every path, and all of its patterns ignore (a `!` pattern re-includes a path, so a body with
 * one keeps part of its directory in the project). Lines are read as git reads them: a leading
 * byte-order mark, a trailing carriage return, and unescaped trailing spaces come off, and
 * blank lines and `#` lines are skipped.
 */
export function ignoresEveryPath(rules: string): boolean {
    let every = false;
    for (const raw of rules.replace(/^\uFEFF/, "").split("\n")) {
        const line = raw.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
        if (line === "" || line.startsWith("#")) continue;
        if (line.startsWith("!")) return false;
        if (EVERY_PATH.has(line)) every = true;
    }
    return every;
}

/** The directories above each path, one JS character per byte like the paths. */
function directoriesOf(paths: Iterable<string>): Set<string> {
    const found = new Set<string>();
    for (const path of paths) {
        for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
            found.add(path.slice(0, at));
        }
    }
    return found;
}

/** A turn's or session's change as a diff artefact holds it. */
export interface Change {
    patch: string;
    /**
     * The directories whose own `.gitignore` ignores every path below them, among the ones
     * that hold a path the patch names; present when there is at least one.
     */
    self_ignored?: string[];
}

/** One project's baseline rules as the recorder's git reads them; `SnapshotRecorder.baseline` builds it. */
interface BaselineRules {
    mirror: string;
    attributes: string;
    directories: Set<string>;
}

/** The NUL-terminated fields of a git `-z` listing, one JS character per byte. */
function fields(listing: Buffer): string[] {
    return listing.toString("latin1").split("\0").filter(Boolean);
}

/** The bytes of a path the workspace walk read as UTF-8, one JS character per byte. */
function bytesOf(path: string): string {
    return Buffer.from(path, "utf8").toString("latin1");
}

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
     * recorder's repository and `GIT_WORK_TREE` the workspace. The agent can write the
     * workspace's `.gitattributes` files too, so `GIT_ATTR_SOURCE` names the project's baseline
     * attribute tree and git reads attributes from that tree alone. Each workspace keeps its
     * own index there, so a later tree rehashes only the files whose stat data changed.
     */
    private bytes(args: string[], work?: string, input?: Buffer): Buffer {
        if (work) this.requireRealDir(work);
        this.init();
        const scope: Record<string, string> = { GIT_DIR: this.gitDir, GIT_NO_REPLACE_OBJECTS: "1" };
        if (work) {
            scope.GIT_WORK_TREE = work;
            scope.GIT_INDEX_FILE = this.indexFile(work);
            scope.GIT_ATTR_SOURCE = this.baseline(basename(work)).attributes;
        }
        try {
            return gitBytes(work ?? this.armDir, args, scope, this.gitTimeoutMs, { input });
        } catch (caught) {
            if (caught instanceof GitBound && scope.GIT_INDEX_FILE) {
                rmSync(`${scope.GIT_INDEX_FILE}.lock`, { force: true });
            }
            throw caught;
        }
    }

    private git(args: string[], work?: string): string {
        return this.bytes(args, work).toString("utf8");
    }

    private init(): void {
        if (!existsSync(this.gitDir)) git(this.armDir, ["init", "--quiet", "--bare", this.gitDir]);
    }

    /**
     * The project's baseline rules in the two forms the recorder's git reads. `mirror` is a
     * directory under the recorder's repository that holds the baseline `.gitignore` files at
     * their paths and nothing else, so `check-ignore` run there answers for any workspace path
     * under the baseline ignore rules. `attributes` is a tree of the baseline `.gitattributes`
     * files, the value of `GIT_ATTR_SOURCE`. Both are rebuilt from the recorded blob ids on the
     * first use by each recorder, so a resumed or copied arm directory reads the rules its
     * state names. A project with no recorded rule files has an empty mirror and an empty tree.
     * `directories` lists the mirror's directories, one JS character per byte.
     */
    private baseline(project: string): BaselineRules {
        const built = this.baselines.get(project);
        if (built) return built;
        this.init();
        this.requireAttributeSource();
        const scope = { GIT_DIR: this.gitDir, GIT_NO_REPLACE_OBJECTS: "1" };
        const run = (args: string[], extra: Record<string, string> = {}, input?: Buffer) =>
            gitBytes(this.armDir, args, { ...scope, ...extra }, this.gitTimeoutMs, { input });
        const mirror = join(this.gitDir, "baseline-rules", project);
        rmSync(mirror, { recursive: true, force: true });
        mkdirSync(mirror, { recursive: true });
        const attributeEntries: string[] = [];
        const directories = new Set<string>();
        for (const [path, id] of Object.entries(this.state.ignores?.[project]?.files ?? {})) {
            if (basename(path) === ".gitattributes") {
                attributeEntries.push(`100644 ${id}\t${path}\0`);
                continue;
            }
            const parts = path.split("/").slice(0, -1);
            parts.forEach((_, depth) => {
                directories.add(bytesOf(parts.slice(0, depth + 1).join("/")));
            });
            mkdirSync(dirname(join(mirror, path)), { recursive: true });
            writeFileSync(join(mirror, path), run(["cat-file", "blob", id]));
        }
        const index = join(this.gitDir, "baseline-attributes.staging");
        for (const stale of [index, `${index}.lock`]) rmSync(stale, { force: true });
        const staged = { GIT_INDEX_FILE: index };
        run(["update-index", "-z", "--index-info"], staged, Buffer.from(attributeEntries.join("")));
        const attributes = run(["write-tree"], staged).toString("utf8").trim();
        rmSync(index, { force: true });
        const rules = { mirror, attributes, directories };
        this.baselines.set(project, rules);
        return rules;
    }

    private readonly baselines = new Map<string, BaselineRules>();

    /**
     * Checks once per process that git reads attributes from `GIT_ATTR_SOURCE`: under a tree
     * whose only rule is `* text eol=lf`, `a\r\n` hashes as `a\n`. A git that reads the
     * variable as nothing would index each file under the workspace's own attributes, so the
     * recorder builds no tree with it.
     */
    private requireAttributeSource(): void {
        if (attributeSourceHonored) return;
        const run = (args: string[], input: string, extra: Record<string, string> = {}) =>
            gitBytes(this.armDir, args, { GIT_DIR: this.gitDir, ...extra }, this.gitTimeoutMs, {
                input: Buffer.from(input),
            })
                .toString("utf8")
                .trim();
        const rule = run(["hash-object", "-w", "--stdin"], "* text eol=lf\n");
        const tree = run(["mktree"], `100644 blob ${rule}\t.gitattributes\n`);
        const stored = run(["hash-object", "--stdin", "--path=probe"], "a\r\n", {
            GIT_ATTR_SOURCE: tree,
        });
        if (stored !== LF_BLOB) {
            throw new Error(
                "git reads no attributes from GIT_ATTR_SOURCE; the snapshot recorder needs a git that does",
            );
        }
        attributeSourceHonored = true;
    }

    /**
     * The paths among `paths` that the project's baseline ignore rules match, asked of
     * `check-ignore` in the baseline mirror. A path ending in `/` is matched as a directory.
     * Each path goes in behind `./`, which keeps a name that starts with `:` a plain path
     * instead of pathspec magic. `check-ignore` takes a path's type from the mirror when the
     * mirror holds the path, so a workspace file at the path of a mirror directory is asked
     * with that directory removed: the rule files below it apply to no workspace path while a
     * file stands there. The next call rebuilds the mirror.
     */
    private baselineIgnored(project: string, paths: readonly string[]): Set<string> {
        if (paths.length === 0) return new Set();
        const { mirror, directories } = this.baseline(project);
        const files = paths.filter((path) => directories.has(path));
        for (const path of files) {
            const at = join(mirror, Buffer.from(path, "latin1").toString("utf8"));
            rmSync(at, { recursive: true, force: true });
        }
        if (files.length > 0) this.baselines.delete(project);
        const listing = gitBytes(
            mirror,
            ["check-ignore", "-z", "--no-index", "--stdin"],
            { GIT_DIR: this.gitDir, GIT_WORK_TREE: mirror },
            this.gitTimeoutMs,
            {
                input: Buffer.from(paths.map((path) => `./${path}\0`).join(""), "latin1"),
                accept: [0, 1],
            },
        );
        return new Set(fields(listing).map((path) => path.slice(2)));
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
        this.baselines.clear();
        this.baseDirectories.clear();
        this.commands = [];
        this.commandAt.clear();
        rmSync(this.commandsFile, { force: true });
        rmSync(this.stateFile, { force: true });
        rmSync(this.gitDir, { recursive: true, force: true });
        rmSync(join(this.armDir, "snapshots.jsonl"), { force: true });
        writeFileSync(join(this.armDir, "tools.jsonl"), "");
    }

    /**
     * Directories under `dir` that hold a `.git` entry of their own and that the project's
     * baseline ignore rules keep: git would index a committed one as a gitlink and refuse an
     * uncommitted one, so the tree leaves them out. One the baseline rules ignore is outside
     * the evidence either way. The walk runs under the recorder bound and an entry cap.
     */
    embedded(dir: string): string[] {
        this.requireRealDir(dir);
        const found: string[] = [];
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
                if (entry.name === ".git") {
                    if (at !== dir) found.push(relative(dir, at).split(sep).join("/"));
                    continue;
                }
                if (entry.isDirectory()) pending.push(join(at, entry.name));
            }
        }
        if (found.length > NESTED_REPO_CAP) {
            throw new GitBound(
                `workspace walk of ${dir}: more than ${NESTED_REPO_CAP} nested repositories`,
            );
        }
        const asDirectory = (path: string) => `${bytesOf(path)}/`;
        const skipped = this.baselineIgnored(basename(dir), found.map(asDirectory));
        return found.filter((path) => !skipped.has(asDirectory(path))).sort();
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
     * Records the project's baseline rules from its fresh clone, before any agent turn: every
     * `.gitignore` and `.gitattributes` the clone tracks and holds as a regular file, with the
     * bytes on disk, which are the bytes git reads rules from in that clone. Each is stored as
     * a blob in the recorder's repository and recorded by blob id. Every later tree of the
     * project is built under these rules.
     */
    trackIgnoreRules(project: string, clone: string): void {
        const names = [".gitignore", "**/.gitignore", ".gitattributes", "**/.gitattributes"];
        const files: Record<string, string> = {};
        for (const raw of fields(gitBytes(clone, ["ls-files", "-z", "--", ...names]))) {
            const path = Buffer.from(raw, "latin1").toString("utf8");
            if (bytesOf(path) !== raw) {
                throw new Error(
                    `rule file ${JSON.stringify(path)} of ${clone} has a path outside UTF-8`,
                );
            }
            // Git opens an in-tree rule file without following links, so a symlinked one carries no rules.
            if (!lstatSync(join(clone, path), { throwIfNoEntry: false })?.isFile()) continue;
            const content = readFileSync(join(clone, path));
            const stored = this.bytes(["hash-object", "-w", "--stdin"], undefined, content);
            files[path] = stored.toString("utf8").trim();
        }
        this.state.ignores = { ...this.state.ignores, [project]: { files } };
        this.baselines.delete(project);
        this.save();
    }

    /**
     * Records the tree of the project's fresh clone, before any agent turn. `selfIgnored`
     * reads it: a directory the fresh clone holds stays the project's own. A git run past its
     * bound leaves the project without a base tree, and every file of its diffs then counts as
     * the agent's change.
     */
    trackBaseTree(project: string, clone: string): void {
        const base = this.boundedTree(clone);
        const { [project]: _, ...rest } = this.state.baseTrees ?? {};
        this.state.baseTrees = base ? { ...rest, [project]: base } : rest;
        this.baseDirectories.delete(project);
        this.save();
    }

    private readonly baseDirectories = new Map<string, Set<string>>();

    /** The directories of the project's fresh clone, listed once per recorder from its base tree. */
    private projectDirectories(project: string, base: string): Set<string> {
        const listed = this.baseDirectories.get(project);
        if (listed) return listed;
        const own = directoriesOf(this.filesOf(base).keys());
        this.baseDirectories.set(project, own);
        return own;
    }

    /** The files of a tree this recorder wrote: each path, one JS character per byte, with its mode and blob id. */
    private filesOf(tree: string): Map<string, { mode: string; id: string }> {
        const files = new Map<string, { mode: string; id: string }>();
        for (const entry of fields(this.bytes(["ls-tree", "-r", "-z", tree]))) {
            const tab = entry.indexOf("\t");
            const [mode, , id] = entry.slice(0, tab).split(" ");
            files.set(entry.slice(tab + 1), { mode: mode as string, id: id as string });
        }
        return files;
    }

    /**
     * The directories whose own `.gitignore` ignores every path below them
     * (`ignoresEveryPath`), among the directories that hold a path `from` and `to` differ in:
     * a tool cache (`.pytest_cache`, `.ruff_cache`, a virtualenv) or a scratch directory,
     * which git itself keeps out of the project. The rule file is the one in `to`, a regular
     * file; a directory the change removed is read by the rule file `from` held. The workspace
     * root and every directory of the project's fresh clone stay off the list: git keeps
     * listing the files it tracks there, so an edit under a project directory counts as the
     * agent's change whatever rule file the turn writes beside it. Of nested directories the
     * outermost is named. The trees and the patch keep every file; the list tells a reader of
     * the patch which files git leaves out of the project.
     */
    private selfIgnored(project: string, from: string, to: string): string[] {
        const base = this.state.baseTrees?.[project];
        if (!base) return [];
        const changed = fields(this.bytes(["diff", "--name-only", "--no-renames", "-z", from, to]));
        const candidates = [...directoriesOf(changed)];
        if (candidates.length === 0) return [];
        const after = this.filesOf(to);
        const ruleOf = (files: Map<string, { mode: string; id: string }>, dir: string) => {
            const rule = files.get(`${dir}/.gitignore`);
            return rule && /^100/.test(rule.mode) ? rule.id : undefined;
        };
        const rules = new Map<string, string>();
        for (const dir of candidates) {
            const rule = ruleOf(after, dir);
            if (rule) rules.set(dir, rule);
        }
        if (changed.some((path) => !after.has(path))) {
            const before = this.filesOf(from);
            const kept = directoriesOf(after.keys());
            for (const dir of candidates) {
                const rule = kept.has(dir) ? undefined : ruleOf(before, dir);
                if (rule) rules.set(dir, rule);
            }
        }
        if (rules.size === 0) return [];
        const everyPath = new Map<string, boolean>();
        for (const id of new Set(rules.values())) {
            everyPath.set(id, ignoresEveryPath(this.git(["cat-file", "blob", id])));
        }
        const own = this.projectDirectories(project, base);
        const named = candidates
            .filter((dir) => everyPath.get(rules.get(dir) ?? "") === true && !own.has(dir))
            .sort();
        return named
            .filter((dir) => !named.some((outer) => dir.startsWith(`${outer}/`)))
            .map((dir) => Buffer.from(dir, "latin1").toString("utf8"));
    }

    /** The change between two trees of the workspace `dir` that this recorder wrote, as a diff artefact holds it. */
    changeBetween(dir: string, from: string, to: string): Change {
        const patch = this.diff(from, to);
        const hidden = patch === "" ? [] : this.selfIgnored(basename(dir), from, to);
        return hidden.length > 0 ? { patch, self_ignored: hidden } : { patch };
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
     * Indexes the workspace under the project's baseline rules, so the tree holds what
     * `git add --all` holds in a workspace whose rule files match the fresh clone's, whatever
     * the workspace's rule files say now. Tracked files are refreshed first. Untracked files are
     * listed with no ignore rules in force, which opens no workspace `.gitignore`, and the ones
     * the baseline rules keep are added; a listed path ending in `/` is a nested repository,
     * which `embedded` reports. A `.gitignore` or `.gitattributes` the agent wrote is a file
     * like any other here: it enters the tree and changes nothing else the tree holds.
     */
    private addAll(dir: string, excluded: string[]): void {
        this.git(["add", "--update"], dir);
        const others = fields(
            this.bytes(["ls-files", "--others", "-z", "--", ".", ...excluded], dir),
        );
        const ignored = this.baselineIgnored(basename(dir), others);
        const kept = others.filter((path) => !path.endsWith("/") && !ignored.has(path));
        if (kept.length === 0) return;
        const listing = Buffer.from(kept.map((path) => `${path}\0`).join(""), "latin1");
        this.bytes(["update-index", "--add", "--remove", "-z", "--stdin"], dir, listing);
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
     * Closes a session: its end tree completes the prior-session diff later sessions carry. A
     * bounded git run leaves the project without a tree pair and records why, and the next
     * session's snapshots carry that reason in place of the prior-session diff.
     */
    sessionEnd(session: string, project: string, dir: string): void {
        if (this.state.ended === session) return;
        const from = this.state.starts[project];
        let to: string | null = null;
        let gap: string | null = from ? null : "the session's start tree was not recorded";
        if (from) {
            try {
                to = this.tree(dir);
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
     * Adds tool runs: each is appended to `tools.jsonl` with the turn it belongs to, and a run
     * whose `call` id matches an earlier record replaces that record in the session's commands
     * and keeps its recorded start time, the moment the run began.
     */
    addTools(tools: Command[], turn: string | null): void {
        if (tools.length === 0) return;
        const toolLines = tools.map((t) => `${JSON.stringify({ turn, ...t })}\n`).join("");
        appendFileSync(join(this.armDir, "tools.jsonl"), toolLines);
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
                ...this.changeBetween(dir, before, after),
            },
            { id: `${id}:turn-commands`, class: "command-log", role: "turn", commands: turnTools },
            { id: `${id}:session-commands`, class: "command-log", role: "session", commands },
            { id: `${id}:calls`, class: "proxy-call", calls: this.callsFor(e.session) },
        ];
        const prior = this.state.last[project];
        const gap = this.state.lastGap?.[project];
        if (prior) {
            const change = this.changeBetween(dir, prior.from, prior.to);
            artefacts.push({
                id: `${id}:prior-diff`,
                class: "diff",
                role: "prior-session",
                ...change,
            });
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
