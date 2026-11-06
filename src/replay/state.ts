import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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

export function requireInside(path: string, root: string): string {
    const real = realpathSync(path);
    const base = realpathSync(root);
    const rel = relative(base, real);
    if (real !== join(base, relative(root, path)) || rel.startsWith("..")) {
        throw new Error(`${path} resolves to ${real}, outside ${root} or through a link`);
    }
    return real;
}

interface LooseObject {
    id: string;
    mtimeMs: number;
}

const LOOSE = /^[0-9a-f]{38}$/;

function looseObjects(gitDir: string): LooseObject[] {
    const root = join(gitDir, "objects");
    const out: LooseObject[] = [];
    for (const fan of readdirSync(root)) {
        if (!/^[0-9a-f]{2}$/.test(fan)) continue;
        for (const rest of readdirSync(join(root, fan))) {
            if (!LOOSE.test(rest)) continue;
            out.push({ id: fan + rest, mtimeMs: statSync(join(root, fan, rest)).mtimeMs });
        }
    }
    return out;
}

function catFile(gitDir: string, mode: "--batch-check" | "--batch", ids: string[]): Buffer {
    const r = spawnSync("git", ["--git-dir", gitDir, "cat-file", mode], {
        input: `${ids.join("\n")}\n`,
        env: gitEnv(),
        maxBuffer: 1 << 30,
    });
    if (r.status !== 0) throw new Error(`git cat-file ${mode}: ${r.stderr}`);
    return r.stdout as Buffer;
}

function treeChildren(gitDir: string, ids: string[]): Map<string, string[]> {
    const trees = catFile(gitDir, "--batch-check", ids)
        .toString("utf8")
        .split("\n")
        .map((line) => line.split(" "))
        .filter(([, type]) => type === "tree")
        .map(([id]) => id as string);
    const children = new Map<string, string[]>();
    if (trees.length === 0) return children;
    const buf = catFile(gitDir, "--batch", trees);
    let at = 0;
    while (at < buf.length) {
        const nl = buf.indexOf(10, at);
        const [id, type, size] = buf.toString("utf8", at, nl).split(" ");
        if (type !== "tree") throw new Error(`git cat-file --batch: ${id} is ${type}`);
        const body = buf.subarray(nl + 1, nl + 1 + Number(size));
        at = nl + 1 + Number(size) + 1;
        const subtrees: string[] = [];
        let i = 0;
        while (i < body.length) {
            const nul = body.indexOf(0, i);
            const mode = body.toString("utf8", i, body.indexOf(32, i));
            if (mode === "40000") subtrees.push(body.subarray(nul + 1, nul + 21).toString("hex"));
            i = nul + 21;
        }
        children.set(id as string, subtrees);
    }
    return children;
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

const PATCH_SEARCH_LIMIT = 200;

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
        return { tree: latest.id, fidelity: { method, exact: false, detail } };
    }
    const nearest = roots
        .filter((x) => x.id !== latest?.id)
        .sort((a, b) => Math.abs(a.mtimeMs - o.cutoffWall) - Math.abs(b.mtimeMs - o.cutoffWall))
        .slice(0, PATCH_SEARCH_LIMIT);
    for (const x of nearest) {
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

export interface Commit {
    id: string;
    ct: number;
    email: string;
    subject: string;
}

export function rewindHead(o: {
    workspace: string;
    gitconfig: string;
    keep: (c: Commit) => boolean;
    base: string;
}): Fidelity {
    const dotGit = join(o.workspace, ".git");
    const stat = lstatSync(dotGit, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw new Error(`${dotGit} is not a real directory`);
    for (const redirect of ["commondir", "gitdir", "objects/info/alternates"]) {
        if (existsSync(join(dotGit, redirect))) {
            throw new Error(`${dotGit} carries ${redirect}`);
        }
    }
    const env = {
        GIT_DIR: dotGit,
        GIT_WORK_TREE: o.workspace,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
    };
    const flags = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
    const run = (args: string[]) => git(o.workspace, [...flags, ...args], env).trim();
    const configPath = join(dotGit, "config");
    const configStat = lstatSync(configPath, { throwIfNoEntry: false });
    if (!configStat?.isFile()) throw new Error(`${configPath} is not a regular file`);
    const config = readFileSync(configPath);
    writeFileSync(configPath, readFileSync(o.gitconfig));
    try {
        const head = run(["rev-parse", "HEAD"]);
        const chain = run(["log", "--first-parent", "--format=%H%x00%ct%x00%ae%x00%s", "HEAD"])
            .split("\n")
            .filter(Boolean)
            .map((line): Commit => {
                const [id, ct, email, subject] = line.split("\0");
                return {
                    id: id as string,
                    ct: Number(ct),
                    email: String(email),
                    subject: String(subject),
                };
            });
        const target = chain.find(o.keep);
        if (!target) throw new Error(`${o.workspace} has no commit from before the probe`);
        const at = chain.indexOf(target);
        run(["reset", "--mixed", "-q", target.id]);
        rmSync(join(dotGit, "logs"), { recursive: true, force: true });
        rmSync(join(dotGit, "ORIG_HEAD"), { force: true });
        let current = "";
        try {
            current = run(["symbolic-ref", "-q", "HEAD"]);
        } catch {
            current = "";
        }
        const refs = run(["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
        const reaches = (ref: string) => {
            try {
                run(["merge-base", "--is-ancestor", ref, target.id]);
                return false;
            } catch {
                return true;
            }
        };
        const others = refs.filter(
            (r) =>
                r !== current &&
                !r.startsWith("refs/remotes/") &&
                (!r.startsWith("refs/heads/") || reaches(r)),
        );
        const baseline = readFileSync(o.gitconfig);
        const hooks = existsSync(join(dotGit, "hooks"))
            ? readdirSync(join(dotGit, "hooks")).filter((h) => !h.endsWith(".sample"))
            : [];
        const metadata = {
            config_matches_baseline: config.equals(baseline),
            hooks,
        };
        const stop = chain.findIndex((c) => c.id === o.base);
        const agent = chain
            .slice(at, stop < 0 ? chain.length : stop)
            .filter((c) => !c.email.startsWith("sim-user@"));
        return {
            method: "first-parent-rewind",
            exact: others.length === 0 && metadata.config_matches_baseline && hooks.length === 0,
            detail: {
                final_head: head,
                head: target.id,
                dropped: at,
                agent_commits_kept: agent.length,
                other_refs: others,
                ...metadata,
                reflogs: "cleared",
            },
        };
    } finally {
        writeFileSync(configPath, config);
    }
}

export function findSession(agentDir: string, sessionId: string): string {
    const root = join(agentDir, "sessions");
    const real = (p: string, dir: boolean) => {
        const s = lstatSync(p, { throwIfNoEntry: false });
        return dir ? !!s?.isDirectory() : !!s?.isFile();
    };
    const hits = real(root, true)
        ? readdirSync(root)
              .filter((dir) => real(join(root, dir), true))
              .flatMap((dir) =>
                  readdirSync(join(root, dir))
                      .filter((f) => f.endsWith(`_${sessionId}.jsonl`))
                      .map((f) => join(root, dir, f))
                      .filter((f) => real(f, false)),
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
    sentFrom?: number;
    cwd?: string;
}): { path: string; fidelity: Fidelity } {
    const from = findSession(o.fromAgentDir, o.sessionId);
    const lines = readFileSync(from, "utf8").split("\n");
    const cut = lines.findIndex((line) => {
        if (!line) return false;
        const e = JSON.parse(line) as {
            type?: string;
            message?: {
                role?: string;
                timestamp?: unknown;
                content?: Array<{ type?: string; text?: string }>;
            };
        };
        const sent = e.message?.timestamp;
        return (
            e.type === "message" &&
            e.message?.role === "user" &&
            (typeof sent !== "number" || o.sentFrom === undefined || sent >= o.sentFrom) &&
            (e.message.content ?? []).some((c) => (c.text ?? "").includes(o.probeText))
        );
    });
    if (cut < 0) throw new Error(`${from} holds no user message with the probe text`);
    const timed =
        typeof (JSON.parse(lines[cut] as string) as { message?: { timestamp?: unknown } }).message
            ?.timestamp === "number" && o.sentFrom !== undefined;
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
            exact: o.cwd === undefined && timed,
            detail: {
                file: basename(from),
                kept_entries: kept.length,
                dropped_entries: lines.filter(Boolean).length - kept.length,
                timed,
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

type Counts = Record<string, number>;
const counter = (counts: Counts) => (table: string, n: number) => {
    if (n > 0) counts[table] = (counts[table] ?? 0) + n;
};

function withoutGuards<T>(db: Database, edit: () => T): T {
    const guards = (
        db
            .query("select name, sql from sqlite_master where type = 'trigger' and sql is not null")
            .all() as { name: string; sql: string }[]
    ).filter((t) => /\bBEFORE\b/i.test(t.sql) && /\bRAISE\s*\(/i.test(t.sql));
    return db.transaction(() => {
        for (const t of guards) db.run(`drop trigger "${t.name}"`);
        const result = edit();
        for (const t of guards) db.run(t.sql);
        return result;
    })();
}

export function dropOrphans(db: Database): Counts {
    const dropped: Counts = {};
    const note = counter(dropped);
    for (let pass = 0; pass < 64; pass++) {
        const orphans = db.query("pragma foreign_key_check").all() as {
            table: string;
            parent: string;
            fkid: number;
        }[];
        if (orphans.length === 0) return dropped;
        const keys = new Map(orphans.map((r) => [`${r.table}\0${r.fkid}`, r]));
        for (const r of keys.values()) {
            const links = (
                db.query(`pragma foreign_key_list("${r.table}")`).all() as {
                    id: number;
                    from: string;
                    to: string | null;
                }[]
            ).filter((l) => l.id === r.fkid);
            const pk = (
                db.query(`pragma table_info("${r.parent}")`).all() as {
                    name: string;
                    pk: number;
                }[]
            )
                .filter((c) => c.pk > 0)
                .sort((a, b) => a.pk - b.pk)
                .map((c) => c.name);
            const pairs = links.map((l, i) => [l.from, l.to ?? pk[i]] as const);
            const set = pairs.map(([from]) => `"${r.table}"."${from}" is not null`).join(" and ");
            const match = pairs
                .map(([from, to]) => `p."${to}" = "${r.table}"."${from}"`)
                .join(" and ");
            const sql = `delete from "${r.table}" where ${set} and not exists (select 1 from "${r.parent}" p where ${match})`;
            note(r.table, db.run(sql).changes);
        }
    }
    throw new Error("foreign-key orphans remain after 64 passes");
}

export function rollbackKernel(db: Database, cut: number): Counts {
    const changed: Counts = {};
    const note = counter(changed);
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
): { changed: Counts; committedAfter: number } {
    const changed: Counts = {};
    const note = counter(changed);
    const marks = o.sessions.map(() => "?").join(", ");
    const names = tables(db);
    for (const t of names) {
        const cols = columns(db, t);
        const commit = cols.filter((c) => c.endsWith("commit_seq"));
        if (commit.length > 0 && !(t === "memory_capture_jobs" && commit.join() === "commit_seq")) {
            throw new Error(`memory store table ${t} has commit column ${commit.join(", ")}`);
        }
        if (cols.includes("session_id") && o.sessions.length > 0) {
            const terminal =
                t === "memory_capture_jobs"
                    ? " and not (commit_seq > ? and created_at_ms <= ?)"
                    : "";
            const sql = `delete from "${t}" where session_id in (${marks})${terminal}`;
            const args = terminal ? [...o.sessions, o.commit, o.cutoffMs] : o.sessions;
            note(t, db.run(sql, args).changes);
        }
        if (cols.includes("created_at_ms")) {
            note(t, db.run(`delete from "${t}" where created_at_ms > ?`, [o.cutoffMs]).changes);
        }
    }
    const committedAfter = names.includes("memory_capture_jobs")
        ? (
              db
                  .query("select count(*) as n from memory_capture_jobs where commit_seq > ?")
                  .get(o.commit) as { n: number }
          ).n
        : 0;
    return { changed, committedAfter };
}

function sqliteFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && /\.(sqlite|db)$/.test(d.name))
        .map((d) => join(d.parentPath, d.name));
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
        requireInside(path, o.dataDir);
    }
    const kernel = new Database(kernelPath);
    let commit = 0;
    let latest = 0;
    let kernelChanged: Counts = {};
    let kernelOrphans: Counts = {};
    try {
        const cutRow = kernel
            .query("select max(commit_seq) as seq from commit_log where recorded_at <= ?")
            .get(o.cutoffMs) as { seq: number | null };
        commit = cutRow.seq ?? 0;
        const top = kernel.query("select max(commit_seq) as seq from commit_log").get() as {
            seq: number | null;
        };
        latest = top.seq ?? 0;
        withoutGuards(kernel, () => {
            kernelChanged = rollbackKernel(kernel, commit);
            kernelOrphans = dropOrphans(kernel);
        });
        kernel.run("pragma wal_checkpoint(truncate)");
    } finally {
        kernel.close();
    }
    const store = new Database(storePath);
    let storeChanged: Counts = {};
    let storeOrphans: Counts = {};
    let committedAfter = 0;
    try {
        withoutGuards(store, () => {
            ({ changed: storeChanged, committedAfter } = rollbackMemoryStore(store, {
                ...o,
                commit,
            }));
            storeOrphans = dropOrphans(store);
        });
        store.run("pragma wal_checkpoint(truncate)");
    } finally {
        store.close();
    }
    const untouched = sqliteFiles(o.dataDir)
        .filter((f) => f !== kernelPath && f !== storePath)
        .map((f) => relative(o.dataDir, f));
    return {
        method: "kernel-commit-rollback+session-drop",
        exact: false,
        detail: {
            cutoff_ms: o.cutoffMs,
            commit,
            final_commit: latest,
            dropped_sessions: o.sessions,
            kernel: kernelChanged,
            kernel_orphans: kernelOrphans,
            memory_store: storeChanged,
            memory_store_orphans: storeOrphans,
            capture_jobs_committed_after_probe: committedAfter,
            untouched,
        },
    };
}
