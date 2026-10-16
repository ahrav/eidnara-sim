import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { git } from "../git";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";

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
}

const EMPTY: RecorderState = { session: null, ended: null, starts: {}, last: {}, commands: [] };

export class SnapshotRecorder {
    private readonly gitDir: string;
    private readonly stateFile: string;
    private state: RecorderState;

    constructor(
        private readonly armDir: string,
        private readonly arm: string,
        private readonly callsFor: (session: string) => CallView[],
        /** Bound on each git run against a workspace; a run past it throws `GitTimeout`. */
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
     * The run lease makes this recorder the only writer of its repository, so an
     * `<project>.index.lock` found at construction is one a killed git left behind.
     */
    private dropIndexLocks(): void {
        if (!existsSync(this.gitDir)) return;
        for (const name of readdirSync(this.gitDir)) {
            if (name.endsWith(".index.lock")) rmSync(join(this.gitDir, name), { force: true });
        }
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
        return git(work ?? this.armDir, args, scope, work ? this.gitTimeoutMs : undefined);
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
     * Directories under `dir` that are git repositories of their own. Git lists each as one
     * untracked directory and would index a committed one as a gitlink, so the tree leaves
     * them out.
     */
    embedded(dir: string): string[] {
        const status = this.git(["status", "--porcelain", "-z", "--untracked-files=all"], dir);
        return status
            .split("\0")
            .filter((line) => line.startsWith("?? ") && line.endsWith("/"))
            .map((line) => line.slice(3, -1))
            .sort();
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

    tree(dir: string): string {
        const nested = this.embedded(dir);
        const excluded = nested.map((path) => `:(exclude)${path}`);
        this.git(["add", "--all", "--", ".", ...excluded], dir);
        const forced = (this.state.forced?.[basename(dir)] ?? []).filter(
            (path) =>
                existsSync(join(dir, path)) &&
                !nested.some((repo) => path === repo || path.startsWith(`${repo}/`)),
        );
        if (forced.length > 0) this.git(["add", "--force", "--", ...forced], dir);
        return this.git(["write-tree"], dir).trim();
    }

    private diff(from: string, to: string): string {
        return this.git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, to]);
    }

    sessionStart(session: string, project: string, dir: string): void {
        if (this.state.session === session || this.state.ended === session) return;
        this.state.session = session;
        this.state.starts[project] = this.tree(dir);
        this.state.commands = [];
        this.save();
    }

    sessionEnd(session: string, project: string, dir: string): void {
        if (this.state.ended === session) return;
        const from = this.state.starts[project];
        if (from) this.state.last[project] = { from, to: this.tree(dir) };
        this.state.session = null;
        this.state.ended = session;
        this.save();
    }

    addTools(tools: Command[]): void {
        if (tools.length === 0) return;
        this.state.commands.push(...tools);
        this.save();
    }

    capture(
        e: { probe: string; session: string; id: string },
        project: string,
        dir: string,
        before: string,
        turnTools: Command[],
        failed: boolean,
    ): string {
        const id = `${this.arm}:${e.probe}:${e.id}`;
        const commands = [...this.state.commands];
        const artefacts: Artefact[] = [
            {
                id: `${id}:diff`,
                class: "diff",
                role: "turn",
                patch: this.diff(before, this.tree(dir)),
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
            turn: e.id,
            turn_outcome: failed ? "failed" : "ok",
            artefacts,
        };
        appendFileSync(join(this.armDir, "snapshots.jsonl"), `${JSON.stringify(snapshot)}\n`);
        return id;
    }
}
