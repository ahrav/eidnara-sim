import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../run/journal";
import type { ScenarioEvent } from "../run/scheduler";
import {
    checkoutTree,
    piSessionDir,
    probeTree,
    rewindHead,
    rollbackKernel,
    rollbackStore,
    truncateSession,
} from "./state";

const tmp = () => mkdtempSync(join(tmpdir(), "sim-replay-state-"));

function sh(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
    const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        input,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            ...env,
        },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
}

function kernelDb(path: string): Database {
    const db = new Database(path, { create: true });
    db.run("create table commit_log (commit_seq integer primary key, recorded_at integer)");
    db.run(
        "create table object_registry (object_id text, created_commit_seq integer, invalidated_commit_seq integer, superseded_by text)",
    );
    db.run("create table outbox (outbox_position integer primary key, commit_seq integer)");
    db.run(
        "create table alignment_projection_state (singleton integer, built_through_commit_seq integer)",
    );
    db.run("create table domains (domain_id text)");
    db.run(
        "create trigger commit_log_no_delete before delete on commit_log begin select raise(abort, 'commit_log is append-only'); end",
    );
    db.run(
        "create trigger object_registry_append_only_update before update on object_registry begin select raise(abort, 'object_registry is append-only'); end",
    );
    for (const seq of [1, 2, 3, 4]) {
        db.run("insert into commit_log values (?, ?)", [seq, seq * 100]);
    }
    db.run("insert into object_registry values ('a', 1, null, null)");
    db.run("insert into object_registry values ('b', 2, 4, 'c')");
    db.run("insert into object_registry values ('c', 4, null, null)");
    db.run("insert into object_registry values ('d', 1, 2, 'b')");
    db.run("insert into outbox values (1, 1), (2, 3)");
    db.run("insert into alignment_projection_state values (1, 4)");
    db.run("insert into domains values ('memory')");
    return db;
}

function storeDb(path: string): Database {
    const db = new Database(path, { create: true });
    db.run("create table cache_state (session_id text, core_state blob)");
    db.run(
        "create table memory_capture_jobs (job_id integer, session_id text, commit_seq integer, abandoned_at_ms integer, created_at_ms integer)",
    );
    db.run("create table scan_batches (scan_batch_id integer primary key, created_at_ms integer)");
    db.run("create table notes (id integer, session_id text, content text)");
    db.run("insert into cache_state values ('sim-s-1', x'00'), ('sim-s-2', x'00')");
    db.run(
        "insert into memory_capture_jobs values (1, 'sim-s-1', 2, null, 150), (2, 'sim-s-1', 3, null, 190), (3, 'sim-s-1', null, 260, 180), (4, 'sim-s-2', 4, null, 350)",
    );
    db.run("insert into scan_batches values (1, 120), (2, 320)");
    db.run("insert into notes values (1, 'sim-s-1', 'kept'), (2, 'sim-s-2', 'later')");
    db.run("create table cache_totals (n integer)");
    db.run("insert into cache_totals values (2)");
    db.run(
        "create trigger cache_state_total_delete after delete on cache_state begin update cache_totals set n = n - 1; end",
    );
    db.run(
        "create trigger notes_no_delete before delete on notes when old.content = 'kept' begin select raise(abort, 'notes keep'); end",
    );
    db.run(
        "create table field_scans (scan_id integer primary key, scan_batch_id integer references scan_batches(scan_batch_id))",
    );
    db.run("insert into field_scans values (10, 1), (20, 2)");
    return db;
}

describe("rollbackStore", () => {
    function dataDir() {
        const root = tmp();
        mkdirSync(join(root, "eidnara", "context", "kernel"), { recursive: true });
        kernelDb(join(root, "eidnara", "context", "kernel", "kernel.sqlite")).close();
        storeDb(join(root, "eidnara", "context", "store.db")).close();
        return root;
    }

    test("moves the Kernel back to the last commit before the cutoff and keeps its guards", () => {
        const root = dataDir();
        const fidelity = rollbackStore({ dataDir: root, cutoffMs: 250, sessions: ["sim-s-2"] });
        expect(fidelity.detail.commit).toBe(2);
        expect(fidelity.detail.final_commit).toBe(4);
        const db = new Database(join(root, "eidnara", "context", "kernel", "kernel.sqlite"));
        const ids = db
            .query(
                "select object_id, invalidated_commit_seq as inv, superseded_by as sup from object_registry order by object_id",
            )
            .all();
        expect(ids).toEqual([
            { object_id: "a", inv: null, sup: null },
            { object_id: "b", inv: null, sup: null },
            { object_id: "d", inv: 2, sup: "b" },
        ]);
        expect(db.query("select commit_seq from commit_log").all()).toEqual([
            { commit_seq: 1 },
            { commit_seq: 2 },
        ]);
        expect(db.query("select outbox_position from outbox").all()).toEqual([
            { outbox_position: 1 },
        ]);
        expect(
            db.query("select built_through_commit_seq as b from alignment_projection_state").get(),
        ).toEqual({ b: 2 });
        expect(() => db.run("delete from commit_log")).toThrow("commit_log is append-only");
        expect(() => db.run("update object_registry set superseded_by = 'x'")).toThrow(
            "object_registry is append-only",
        );
        db.close();
    });

    test("drops the named sessions, keeps committed capture jobs terminal, and keeps derived rows", () => {
        const root = dataDir();
        const fidelity = rollbackStore({ dataDir: root, cutoffMs: 250, sessions: ["sim-s-2"] });
        expect(fidelity.detail).toMatchObject({
            capture_jobs_committed_after_probe: 1,
            memory_store_orphans: { field_scans: 1 },
        });
        const db = new Database(join(root, "eidnara", "context", "store.db"));
        expect(db.query("select session_id from cache_state").all()).toEqual([
            { session_id: "sim-s-1" },
        ]);
        expect(db.query("select n from cache_totals").get()).toEqual({ n: 1 });
        expect(
            db
                .query(
                    "select job_id, commit_seq as c, abandoned_at_ms as a from memory_capture_jobs order by job_id",
                )
                .all(),
        ).toEqual([
            { job_id: 1, c: 2, a: null },
            { job_id: 2, c: 3, a: null },
            { job_id: 3, c: null, a: 260 },
        ]);
        expect(db.query("select scan_batch_id from scan_batches").all()).toEqual([
            { scan_batch_id: 1 },
        ]);
        expect(db.query("select scan_id from field_scans").all()).toEqual([{ scan_id: 10 }]);
        expect(db.query("select content from notes").all()).toEqual([{ content: "kept" }]);
        expect(() => db.run("delete from notes")).toThrow("notes keep");
        db.close();
    });

    test("refuses a commit column it has no rule for", () => {
        const db = new Database(":memory:");
        db.run("create table odd (pinned_commit_seq integer)");
        expect(() => rollbackKernel(db, 1)).toThrow("no rollback rule");
    });
});

describe("probe-time workspace", () => {
    const events: ScenarioEvent[] = [
        { id: "e-0", kind: "session_start", scenario_ms: 0, session: "s-0", project: "p" },
        { id: "e-1", kind: "user_turn", scenario_ms: 1, session: "s-0", index: 0 },
        { id: "e-2", kind: "session_start", scenario_ms: 2, session: "s-1", project: "q" },
        { id: "e-3", kind: "user_turn", scenario_ms: 3, session: "s-1", index: 1 },
    ];
    const projectOf = (e: ScenarioEvent) => (e.session === "s-0" ? "p" : "q");

    function setup() {
        const root = tmp();
        const gitDir = join(root, "snapshot.git");
        sh(root, ["init", "-q", "--bare", gitDir]);
        const work = join(root, "w");
        mkdirSync(work);
        const env = { GIT_DIR: gitDir, GIT_WORK_TREE: work, GIT_INDEX_FILE: join(root, "i") };
        const write = (files: Record<string, string>, at: number) => {
            for (const f of readdirSync(work))
                if (f !== ".gitignore") Bun.spawnSync(["rm", "-rf", join(work, f)]);
            for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c);
            sh(work, ["add", "-A"], env);
            const tree = sh(work, ["write-tree"], env);
            const obj = join(gitDir, "objects", tree.slice(0, 2), tree.slice(2));
            utimesSync(obj, at / 1000, at / 1000);
            return tree;
        };
        return { root, gitDir, work, env, write };
    }

    test("takes the project's tree written last before the probe's first call", () => {
        const { root, gitDir, write } = setup();
        const start = write({ "a.txt": "one\n" }, 1000);
        const mid = write({ "a.txt": "two\n" }, 2000);
        write({ "z.txt": "other project\n" }, 3000);
        write({ "a.txt": "three\n" }, 5000);
        const journal = [
            { kind: "Event", event: "e-0", wall_ms: 1500, seq: 1, scenario_ms: 0 },
            { kind: "EndTurn", event: "e-1", wall_ms: 2500, seq: 2, scenario_ms: 1 },
            { kind: "Event", event: "e-2", wall_ms: 3500, seq: 3, scenario_ms: 2 },
            { kind: "EndTurn", event: "e-1", wall_ms: 5500, seq: 4, scenario_ms: 3 },
        ] as unknown as Entry[];
        const o = { gitDir, journal, events, projectOf, project: "p", scratch: join(root, "s") };
        const found = probeTree({ ...o, cutoffWall: 4000, patch: "" });
        expect(found.tree).toBe(mid);
        expect(found.fidelity.method).toBe("latest-write");
        const patch = [
            "diff --git a/a.txt b/a.txt",
            "--- a/a.txt",
            "+++ b/a.txt",
            "@@ -1 +1 @@",
            "-one",
            "+edited",
            "",
        ].join("\n");
        const searched = probeTree({ ...o, cutoffWall: 4000, patch });
        expect(searched.tree).toBe(start);
        expect(searched.fidelity.method).toBe("patch-search");
        expect(() =>
            probeTree({ ...o, cutoffWall: 4000, patch: patch.replace("-one", "-nine") }),
        ).toThrow("takes the probe's recorded turn diff");
    });

    test("checks out the probe tree over the copied files and leaves ignored files", () => {
        const { root, gitDir, work, write } = setup();
        writeFileSync(join(work, ".gitignore"), "build/\n");
        const target = write({ "a.txt": "probe\n", "gone.txt": "x\n" }, 1000);
        const final = write({ "a.txt": "final\n", "new.txt": "later\n" }, 2000);
        mkdirSync(join(work, "build"));
        writeFileSync(join(work, "build", "cache"), "c");
        checkoutTree({
            gitDir,
            workspace: work,
            from: final,
            to: target,
            scratch: join(root, "x"),
        });
        expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("probe\n");
        expect(readFileSync(join(work, "gone.txt"), "utf8")).toBe("x\n");
        expect(existsSync(join(work, "new.txt"))).toBe(false);
        expect(readFileSync(join(work, "build", "cache"), "utf8")).toBe("c");
    });

    test("rewinds the branch to the last commit at the cutoff and keeps the files", () => {
        const root = tmp();
        sh(root, ["init", "-q", "-b", "main"]);
        const commit = (msg: string, at: number, email: string) => {
            writeFileSync(join(root, "f"), msg);
            sh(root, ["add", "f"]);
            const date = `@${at} +0000`;
            sh(
                root,
                ["-c", `user.email=${email}`, "-c", "user.name=n", "commit", "-q", "-m", msg],
                {
                    GIT_COMMITTER_DATE: date,
                    GIT_AUTHOR_DATE: date,
                },
            );
            return sh(root, ["rev-parse", "HEAD"]);
        };
        const base = commit("upstream", 10, "dev@example.com");
        commit("harness", 20, "sim-user@users.noreply.github.com");
        const agent = commit("agent", 30, "agent@example.com");
        commit("Add late.md", 35, "sim-user@users.noreply.github.com");
        commit("later", 50, "sim-user@users.noreply.github.com");
        const baseline = join(tmp(), "baseline.gitconfig");
        writeFileSync(baseline, "[core]\n\trepositoryformatversion = 0\n");
        writeFileSync(
            join(root, ".git", "config"),
            readFileSync(join(root, ".git", "config"), "utf8") +
                "[core]\n\tfsmonitor = /bin/false\n",
        );
        const before = readFileSync(join(root, ".git", "config"), "utf8");
        const lateHarness = new Set(["35 Add late.md"]);
        const fidelity = rewindHead({
            workspace: root,
            gitconfig: baseline,
            keep: (c) => !lateHarness.has(`${c.ct} ${c.subject}`) && c.ct <= 40,
            base,
        });
        expect(sh(root, ["rev-parse", "HEAD"])).toBe(agent);
        expect(readFileSync(join(root, "f"), "utf8")).toBe("later");
        expect(sh(root, ["-c", "core.fsmonitor=false", "status", "--short"])).toBe("M f");
        expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(before);
        expect(existsSync(join(root, ".git", "logs"))).toBe(false);
        expect(existsSync(join(root, ".git", "ORIG_HEAD"))).toBe(false);
        expect(fidelity.detail).toMatchObject({
            dropped: 2,
            agent_commits_kept: 1,
            other_refs: [],
        });
    });
});

describe("truncateSession", () => {
    test("cuts at the probe message sent at or after the turn began", () => {
        const from = join(tmp(), "agent");
        const dir = join(from, "sessions", piSessionDir("/w"));
        mkdirSync(dir, { recursive: true });
        const user = (text: string, timestamp: number) => ({
            type: "message",
            message: { role: "user", timestamp, content: [{ type: "text", text }] },
        });
        const lines = [
            { type: "session", id: "sim-s-9", cwd: "/w" },
            user("the probe", 100),
            user("something else", 200),
            user("the probe", 300),
        ];
        writeFileSync(
            join(dir, "t_sim-s-9.jsonl"),
            `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        );
        const to = join(tmp(), "agent");
        const r = truncateSession({
            fromAgentDir: from,
            toAgentDir: to,
            sessionId: "sim-s-9",
            probeText: "probe",
            sentFrom: 250,
        });
        expect(r.fidelity.detail).toMatchObject({ kept_entries: 3, dropped_entries: 1 });
    });

    function session() {
        const from = join(tmp(), "agent");
        const dir = join(from, "sessions", piSessionDir("/old/w"));
        mkdirSync(dir, { recursive: true });
        const lines = [
            { type: "session", id: "sim-s-1", cwd: "/old/w" },
            {
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "first" }] },
            },
            {
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            },
            {
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "the probe" }] },
            },
            {
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            },
        ];
        writeFileSync(
            join(dir, "t_sim-s-1.jsonl"),
            `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        );
        return from;
    }

    test("keeps every entry before the probe message under the same path", () => {
        const from = session();
        const to = join(tmp(), "agent");
        const r = truncateSession({
            fromAgentDir: from,
            toAgentDir: to,
            sessionId: "sim-s-1",
            probeText: "probe",
        });
        expect(r.path).toBe(join(to, "sessions", piSessionDir("/old/w"), "t_sim-s-1.jsonl"));
        const kept = readFileSync(r.path, "utf8").trim().split("\n");
        expect(kept.length).toBe(3);
        expect(kept[0]).toBe(JSON.stringify({ type: "session", id: "sim-s-1", cwd: "/old/w" }));
        expect(r.fidelity).toMatchObject({
            exact: true,
            detail: { kept_entries: 3, dropped_entries: 2 },
        });
    });

    test("moves the session to another workspace path when one is named", () => {
        const from = session();
        const to = join(tmp(), "agent");
        const r = truncateSession({
            fromAgentDir: from,
            toAgentDir: to,
            sessionId: "sim-s-1",
            probeText: "probe",
            cwd: "/new/w",
        });
        expect(r.path).toBe(join(to, "sessions", "--new-w--", "t_sim-s-1.jsonl"));
        expect(JSON.parse(readFileSync(r.path, "utf8").split("\n")[0] as string).cwd).toBe(
            "/new/w",
        );
        expect(r.fidelity.exact).toBe(false);
    });

    test("refuses a session without the probe message", () => {
        const from = session();
        expect(() =>
            truncateSession({
                fromAgentDir: from,
                toAgentDir: tmp(),
                sessionId: "sim-s-1",
                probeText: "absent",
            }),
        ).toThrow("no user message with the probe text");
    });
});
