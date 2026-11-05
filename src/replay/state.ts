import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { git, gitEnv } from "../git";
import type { Entry } from "../run/journal";
import type { ScenarioEvent } from "../run/scheduler";

export interface Fidelity {
    method: string;
    exact: boolean;
    detail: Record<string, unknown>;
}

export function copyTree(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    const r = spawnSync("cp", ["-a", "--reflink=auto", "--", from, to], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`cp ${from} ${to}: ${r.stderr || r.error}`);
}

interface LooseObject {
    id: string;
    mtimeMs: number;
}

function looseObjects(gitDir: string): LooseObject[] {
    const root = join(gitDir, "objects");
    const out: LooseObject[] = [];
    for (const fan of readdirSync(root)) {
        if (!/^[0-9a-f]{2}$/.test(fan)) continue;
        for (const rest of readdirSync(join(root, fan))) {
            out.push({ id: fan + rest, mtimeMs: statSync(join(root, fan, rest)).mtimeMs });
        }
    }
    return out;
}

function treeChildren(gitDir: string, ids: string[]): Map<string, string[]> {
    const r = spawnSync("git", ["--git-dir", gitDir, "cat-file", "--batch"], {
        input: `${ids.join("\n")}\n`,
        env: gitEnv(),
        maxBuffer: 1 << 30,
    });
    if (r.status !== 0) throw new Error(`git cat-file --batch: ${r.stderr}`);
    const buf = r.stdout as Buffer;
    const trees = new Map<string, string[]>();
    let at = 0;
    while (at < buf.length) {
        const nl = buf.indexOf(10, at);
        const [id, type, size] = buf.toString("utf8", at, nl).split(" ");
        const body = buf.subarray(nl + 1, nl + 1 + Number(size));
        at = nl + 1 + Number(size) + 1;
        if (type !== "tree") continue;
        const subtrees: string[] = [];
        let i = 0;
        while (i < body.length) {
            const nul = body.indexOf(0, i);
            const mode = body.toString("utf8", i, body.indexOf(32, i));
            if (mode === "40000") subtrees.push(body.subarray(nul + 1, nul + 21).toString("hex"));
            i = nul + 21;
        }
        trees.set(id as string, subtrees);
    }
    return trees;
}

function patchApplies(gitDir: string, tree: string, patch: string, scratch: string): boolean {
    if (patch.length === 0) return true;
    const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: scratch };
    rmSync(scratch, { force: true });
    git(dirname(gitDir), ["read-tree", tree], env);
    const r = spawnSync("git", ["apply", "--cached", "--check", "-"], {
        input: patch,
        env: gitEnv(env),
        cwd: dirname(gitDir),
    });
    rmSync(scratch, { force: true });
    return r.status === 0;
}

export function probeTree(o: {
    gitDir: string;
    journal: Entry[];
    events: ScenarioEvent[];
    projectOf: (e: ScenarioEvent) => string | undefined;
    project: string;
    cutoffWall: number;
    patch: string;
    scratch: string;
}): { tree: string; fidelity: Fidelity } {
    const objects = looseObjects(o.gitDir);
    const trees = treeChildren(
        o.gitDir,
        objects.map((x) => x.id),
    );
    const referenced = new Set([...trees.values()].flat());
    const byId = new Map(o.events.map((e) => [e.id, e]));
    const marks = o.journal
        .filter((e) => e.kind === "Event" || e.kind === "EndTurn")
        .sort((a, b) => a.wall_ms - b.wall_ms);
    const projectAt = (wall: number): string | undefined => {
        const next = marks.find((e) => e.wall_ms >= wall);
        const event = next ? byId.get(String(next.event)) : undefined;
        return event ? o.projectOf(event) : undefined;
    };
    const roots = objects
        .filter((x) => trees.has(x.id) && !referenced.has(x.id))
        .filter((x) => projectAt(x.mtimeMs) === o.project)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = roots.find((x) => x.mtimeMs <= o.cutoffWall);
    const detail = {
        roots: roots.length,
        candidate: latest?.id ?? null,
        written_ms: latest ? Math.round(latest.mtimeMs) : null,
        patch_bytes: o.patch.length,
    };
    if (latest && patchApplies(o.gitDir, latest.id, o.patch, o.scratch)) {
        const method = o.patch.length > 0 ? "latest-write+patch-check" : "latest-write";
        return { tree: latest.id, fidelity: { method, exact: o.patch.length > 0, detail } };
    }
    const nearest = [...roots].sort(
        (a, b) => Math.abs(a.mtimeMs - o.cutoffWall) - Math.abs(b.mtimeMs - o.cutoffWall),
    );
    for (const x of nearest) {
        if (x.id === latest?.id) continue;
        if (patchApplies(o.gitDir, x.id, o.patch, o.scratch)) {
            const chosen = { ...detail, chosen: x.id };
            return {
                tree: x.id,
                fidelity: { method: "patch-search", exact: false, detail: chosen },
            };
        }
    }
    throw new Error(
        `no ${o.project} tree in ${o.gitDir} takes the probe's recorded turn diff (${roots.length} roots)`,
    );
}

const WORKSPACE_GIT = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    TZ: "UTC",
};

export function checkoutTree(o: {
    gitDir: string;
    workspace: string;
    from: string;
    to: string;
    scratch: string;
}): void {
    const env = { GIT_DIR: o.gitDir, GIT_WORK_TREE: o.workspace, GIT_INDEX_FILE: o.scratch };
    rmSync(o.scratch, { force: true });
    git(o.workspace, ["read-tree", o.from], env);
    git(o.workspace, ["update-index", "-q", "--refresh"], env);
    git(o.workspace, ["read-tree", "-m", "-u", o.from, o.to], env);
    rmSync(o.scratch, { force: true });
}

export function rewindHead(workspace: string, cutoffS: number, base: string): Fidelity {
    const run = (args: string[]) =>
        git(workspace, ["-c", "core.hooksPath=/dev/null", ...args], WORKSPACE_GIT).trim();
    const head = run(["rev-parse", "HEAD"]);
    const chain = run(["log", "--first-parent", "--format=%H %ct %ae", "HEAD"])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [id, ct, email] = line.split(" ");
            return { id: id as string, ct: Number(ct), email: email as string };
        });
    const target = chain.find((c) => c.ct <= cutoffS);
    if (!target) throw new Error(`${workspace} has no commit at or before ${cutoffS}`);
    const at = chain.indexOf(target);
    run(["reset", "--mixed", "-q", target.id]);
    const others = run(["for-each-ref", "--format=%(refname)"])
        .split("\n")
        .filter((r) => r && !r.startsWith("refs/heads/"));
    const stop = chain.findIndex((c) => c.id === base);
    const agent = chain
        .slice(at, stop < 0 ? chain.length : stop)
        .filter((c) => !c.email.startsWith("sim-user@"));
    return {
        method: "first-parent-rewind",
        exact: others.length === 0,
        detail: {
            final_head: head,
            head: target.id,
            dropped: at,
            agent_commits_kept: agent.length,
            other_refs: others,
        },
    };
}

export function findSession(agentDir: string, sessionId: string): string {
    const root = join(agentDir, "sessions");
    const hits = existsSync(root)
        ? readdirSync(root).flatMap((dir) =>
              readdirSync(join(root, dir))
                  .filter((f) => f.endsWith(`_${sessionId}.jsonl`))
                  .map((f) => join(root, dir, f)),
          )
        : [];
    if (hits.length !== 1) {
        throw new Error(`${root} holds ${hits.length} session files for ${sessionId}, not one`);
    }
    return hits[0] as string;
}

export function truncateSession(o: {
    fromAgentDir: string;
    toAgentDir: string;
    sessionId: string;
    probeText: string;
    cwd?: string;
}): { path: string; fidelity: Fidelity } {
    const from = findSession(o.fromAgentDir, o.sessionId);
    const lines = readFileSync(from, "utf8").split("\n");
    const cut = lines.findIndex((line) => {
        if (!line) return false;
        const e = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        };
        return (
            e.type === "message" &&
            e.message?.role === "user" &&
            (e.message.content ?? []).some((c) => (c.text ?? "").includes(o.probeText))
        );
    });
    if (cut < 0) throw new Error(`${from} holds no user message with the probe text`);
    const kept = lines.slice(0, cut);
    let to = join(o.toAgentDir, from.slice(o.fromAgentDir.length));
    if (o.cwd !== undefined) {
        const header = JSON.parse(kept[0] as string) as { type?: string; cwd?: string };
        if (header.type !== "session") throw new Error(`${from} opens without a session header`);
        kept[0] = JSON.stringify({ ...header, cwd: o.cwd });
        to = join(o.toAgentDir, "sessions", piSessionDir(o.cwd), basename(from));
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, `${kept.join("\n")}\n`);
    return {
        path: to,
        fidelity: {
            method: "prefix-before-probe-message",
            exact: o.cwd === undefined,
            detail: {
                file: basename(from),
                kept_entries: kept.length,
                dropped_entries: lines.filter(Boolean).length - kept.length,
                ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
            },
        },
    };
}

export const piSessionDir = (cwd: string) =>
    `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const DELETE_ABOVE = new Set([
    "created_commit_seq",
    "commit_seq",
    "served_commit_seq",
    "delete_commit_seq",
]);
const CLAMP = new Set([
    "built_through_commit_seq",
    "checkpoint_commit_seq",
    "required_checkpoint_commit_seq",
    "last_checkpoint_commit_seq",
]);

const tables = (db: Database) =>
    (db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[])
        .map((r) => r.name)
        .filter((n) => n !== "sqlite_sequence");

const columns = (db: Database, table: string) =>
    (db.query(`pragma table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

/**
 * `withoutTriggers` runs `edit` in one transaction with the database's triggers dropped and then
 * recreated from their recorded SQL, so the append-only and immutability guards stay in the
 * schema and its digest after the rollback.
 */
function withoutTriggers<T>(db: Database, edit: () => T): T {
    const triggers = db
        .query("select name, sql from sqlite_master where type = 'trigger' and sql is not null")
        .all() as { name: string; sql: string }[];
    return db.transaction(() => {
        for (const t of triggers) db.run(`drop trigger "${t.name}"`);
        const result = edit();
        for (const t of triggers) db.run(t.sql);
        return result;
    })();
}

export function rollbackKernel(db: Database, cut: number): Record<string, number> {
    const changed: Record<string, number> = {};
    const note = (table: string, n: number) => {
        if (n > 0) changed[table] = (changed[table] ?? 0) + n;
    };
    for (const t of tables(db)) {
        const cols = columns(db, t);
        for (const c of cols.filter((c) => c.endsWith("commit_seq"))) {
            if (DELETE_ABOVE.has(c)) {
                note(t, db.run(`delete from "${t}" where "${c}" > ?`, [cut]).changes);
            } else if (c === "invalidated_commit_seq") {
                const sets = cols.includes("superseded_by")
                    ? `"${c}" = null, superseded_by = null`
                    : `"${c}" = null`;
                note(t, db.run(`update "${t}" set ${sets} where "${c}" > ?`, [cut]).changes);
            } else if (CLAMP.has(c)) {
                const sql = `update "${t}" set "${c}" = ? where "${c}" > ?`;
                note(t, db.run(sql, [cut, cut]).changes);
            } else {
                throw new Error(`kernel table ${t} has commit column ${c} with no rollback rule`);
            }
        }
    }
    return changed;
}

export function rollbackMemoryStore(
    db: Database,
    o: { cutoffMs: number; commit: number; sessions: string[] },
): Record<string, number> {
    const changed: Record<string, number> = {};
    const note = (table: string, n: number) => {
        if (n > 0) changed[table] = (changed[table] ?? 0) + n;
    };
    const marks = o.sessions.map(() => "?").join(", ");
    const names = tables(db);
    for (const t of names) {
        const cols = columns(db, t);
        if (cols.includes("session_id") && o.sessions.length > 0) {
            const sql = `delete from "${t}" where session_id in (${marks})`;
            note(t, db.run(sql, o.sessions).changes);
        }
        if (cols.includes("created_at_ms")) {
            note(t, db.run(`delete from "${t}" where created_at_ms > ?`, [o.cutoffMs]).changes);
        }
    }
    if (names.includes("memory_capture_jobs")) {
        const jobs = "update memory_capture_jobs set";
        const pending = db.run(`${jobs} commit_seq = null where commit_seq > ?`, [o.commit]);
        const revived = db.run(`${jobs} abandoned_at_ms = null where abandoned_at_ms > ?`, [
            o.cutoffMs,
        ]);
        note("memory_capture_jobs", pending.changes + revived.changes);
    }
    return changed;
}

export function rollbackStore(o: {
    dataDir: string;
    cutoffMs: number;
    sessions: string[];
}): Fidelity {
    const context = join(o.dataDir, "eidnara", "context");
    const kernelPath = join(context, "kernel", "kernel.sqlite");
    const storePath = join(context, "store.db");
    for (const path of [kernelPath, storePath]) {
        if (!existsSync(path)) throw new Error(`daemon data ${o.dataDir} has no ${basename(path)}`);
    }
    const kernel = new Database(kernelPath);
    let commit = 0;
    let latest = 0;
    let kernelChanged: Record<string, number> = {};
    try {
        const cutRow = kernel
            .query("select max(commit_seq) as seq from commit_log where recorded_at <= ?")
            .get(o.cutoffMs) as { seq: number | null };
        commit = cutRow.seq ?? 0;
        const top = kernel.query("select max(commit_seq) as seq from commit_log").get() as {
            seq: number | null;
        };
        latest = top.seq ?? 0;
        kernelChanged = withoutTriggers(kernel, () => rollbackKernel(kernel, commit));
        kernel.run("pragma wal_checkpoint(truncate)");
    } finally {
        kernel.close();
    }
    const store = new Database(storePath);
    let storeChanged: Record<string, number> = {};
    try {
        storeChanged = withoutTriggers(store, () => rollbackMemoryStore(store, { ...o, commit }));
        store.run("pragma wal_checkpoint(truncate)");
    } finally {
        store.close();
    }
    return {
        method: "kernel-commit-rollback+session-drop",
        exact: false,
        detail: {
            cutoff_ms: o.cutoffMs,
            commit,
            final_commit: latest,
            dropped_sessions: o.sessions,
            kernel: kernelChanged,
            memory_store: storeChanged,
        },
    };
}
