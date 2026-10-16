import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";

function git(dir: string, args: string[], index: string): string {
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: "/dev/null" };
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
}

interface RecorderState {
    session: string | null;
    starts: Record<string, string>;
    last: Record<string, { from: string; to: string }>;
    commands: Command[];
}

const EMPTY: RecorderState = { session: null, starts: {}, last: {}, commands: [] };

export class SnapshotRecorder {
    private readonly index: string;
    private readonly stateFile: string;
    private state: RecorderState;

    constructor(
        private readonly armDir: string,
        private readonly arm: string,
        private readonly callsFor: (session: string) => CallView[],
    ) {
        mkdirSync(armDir, { recursive: true });
        this.index = join(armDir, "snapshot.index");
        this.stateFile = join(armDir, "snapshot-state.json");
        this.state = existsSync(this.stateFile)
            ? (JSON.parse(readFileSync(this.stateFile, "utf8")) as RecorderState)
            : structuredClone(EMPTY);
    }

    private save(): void {
        writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state));
        renameSync(`${this.stateFile}.tmp`, this.stateFile);
    }

    clear(): void {
        this.state = structuredClone(EMPTY);
        rmSync(this.stateFile, { force: true });
        rmSync(join(this.armDir, "snapshots.jsonl"), { force: true });
    }

    tree(dir: string): string {
        rmSync(this.index, { force: true });
        git(dir, ["read-tree", "HEAD"], this.index);
        git(dir, ["add", "-A"], this.index);
        return git(dir, ["write-tree"], this.index).trim();
    }

    private diff(dir: string, from: string, to: string): string {
        return git(dir, ["diff", "--no-color", from, to], this.index);
    }

    sessionStart(session: string, project: string, dir: string): void {
        if (this.state.session === session) return;
        this.state.session = session;
        this.state.starts[project] = this.tree(dir);
        this.state.commands = [];
        this.save();
    }

    sessionEnd(project: string, dir: string): void {
        const from = this.state.starts[project];
        if (from) this.state.last[project] = { from, to: this.tree(dir) };
        this.state.session = null;
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
                patch: this.diff(dir, before, this.tree(dir)),
            },
            { id: `${id}:turn-commands`, class: "command-log", role: "turn", commands: turnTools },
            { id: `${id}:session-commands`, class: "command-log", role: "session", commands },
            { id: `${id}:calls`, class: "proxy-call", calls: this.callsFor(e.session) },
        ];
        const prior = this.state.last[project];
        if (prior) {
            const patch = this.diff(dir, prior.from, prior.to);
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
