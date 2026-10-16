import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { gradeItem } from "../grade/probes";
import { diffPaths } from "../grade/text";
import type { ScenarioEvent } from "../run/scheduler";
import { type FaultType, SEAMS } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import type { DaemonStack, HostContext, PromptResult, SimHost } from "./arms";
import { type DriverOptions, expandTemplate, HostDriver } from "./driver";
import { SnapshotRecorder } from "./snapshot";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "sim-driver-"));
    dirs.push(d);
    return d;
};

class FakeHost {
    opened: string[] = [];
    closed = 0;
    onPrompt: () => void = () => undefined;
    constructor(
        readonly ctx: HostContext,
        private readonly transcripts: string,
    ) {}
    async openSession(cwd: string, session: string) {
        this.opened.push(`${session}@${cwd}`);
    }
    failNext = false;
    async prompt(): Promise<PromptResult> {
        this.onPrompt();
        if (!this.failNext) return {};
        this.failNext = false;
        return { error: "boom" };
    }
    failClose = false;
    async closeSession() {
        this.closed++;
        if (this.failClose) throw new Error("host survived");
    }
    transcriptEnv() {
        return { PI_CODING_AGENT_DIR: this.transcripts };
    }
    hostPid() {
        return null;
    }
    tools: { command: string; exit: number | null; scenario_ms: number }[] = [];
    drainTools() {
        const drained = this.tools.splice(0);
        for (const run of drained) this.ctx.onTool?.(run);
        return drained;
    }
}

function fixture(arm: DriverOptions["arm"], projects: Record<string, string> = {}) {
    const root = tmp();
    const transcripts = join(root, "agent");
    const exits: Record<string, unknown>[] = [];
    const hosts: FakeHost[] = [];
    const o: DriverOptions = {
        config: loadConfig(),
        arm,
        host: "pi",
        armRoot: join(root, arm, "r"),
        launcher: "/bin/false",
        offsetFile: join(root, "offset"),
        keep: [],
        proxyHttp1: "http://127.0.0.1:1",
        proxyHttp2: "http://127.0.0.1:2",
        contextLimit: 200_000,
        projects,
        models: ["model-a", "model-b"],
        turnDeadlineMs: 1_000,
        transcriptPaths: ["$PI_CODING_AGENT_DIR/sessions"],
        loopStore: false,
        hostFactory: (ctx) => {
            const h = new FakeHost(ctx, transcripts);
            hosts.push(h);
            return h as unknown as SimHost;
        },
        onDaemonExit: (d) => void exits.push(d),
    };
    const driver = new HostDriver(o);
    return { driver, root, transcripts, exits, hosts, armDir: join(root, arm) };
}

function fakeDaemon(pid: number | null) {
    const d = {
        current: pid,
        pid: () => d.current,
        restart: async () => {
            d.current = (d.current ?? 0) + 1;
        },
        stop: async () => undefined,
        connectionFile: "/run/conn",
    };
    return d;
}

const episode = (type: FaultType) => ({
    id: `f-${type}`,
    type,
    strategy: "single" as const,
    trigger: { kind: "session_start" as const, session: "s-0000" },
    params: {},
    seam: SEAMS[type],
});

const ev = (kind: ScenarioEvent["kind"], extra: Partial<ScenarioEvent> = {}): ScenarioEvent => ({
    id: `e-${kind}`,
    kind,
    scenario_ms: 0,
    session: "s-0000",
    project: "p",
    ...extra,
});

function gitRepo(): string {
    const dir = tmp();
    const g = (...args: string[]) =>
        spawnSync("git", args, {
            cwd: dir,
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
    g("init", "-q");
    writeFileSync(join(dir, "README"), "hi\n");
    g("add", "README");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    return dir;
}

describe("expandTemplate", () => {
    test("replaces the leading variable with its value", () => {
        const env = { XDG_DATA_HOME: "/h/data" };
        expect(expandTemplate("$XDG_DATA_HOME/opencode/opencode.db", env)).toBe(
            "/h/data/opencode/opencode.db",
        );
    });

    test("refuses a template whose variable the host leaves unset", () => {
        expect(() => expandTemplate("$PI_CODING_AGENT_DIR/sessions", {})).toThrow(
            "PI_CODING_AGENT_DIR unset",
        );
    });
});

describe("HostDriver lifecycle", () => {
    test("reset replaces the arm root with fresh clones, every time it runs", async () => {
        const source = gitRepo();
        const { driver } = fixture("host", { p: source });
        for (let round = 0; round < 2; round++) {
            await driver.reset();
            const ws = driver.workspace("p");
            expect(readFileSync(join(ws, "README"), "utf8")).toBe("hi\n");
            writeFileSync(join(ws, "stale"), "x");
            await driver.reset();
            expect(existsSync(join(driver.workspace("p"), "stale"))).toBe(false);
            expect(driver.host?.ctx.keep).toEqual([]);
        }
    });

    test("apply_diff commits only its own path and tolerates unchanged content", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        writeFileSync(join(ws, "agent-edit"), "mine");
        const diff = ev("apply_diff", { path: "src/a.txt", content: "A" });
        await driver.event(diff);
        await driver.event(diff);
        const log = spawnSync("git", ["log", "--name-only", "--format=%s"], { cwd: ws });
        expect(log.stdout.toString().trim().split("\n")).toEqual([
            "Add src/a.txt",
            "",
            "src/a.txt",
            "init",
            "",
            "README",
        ]);
        const status = spawnSync("git", ["status", "--porcelain"], { cwd: ws });
        expect(status.stdout.toString().trim()).toBe("?? agent-edit");
        const outside = ev("apply_diff", { path: "../x", content: "A" });
        await expect(driver.event(outside)).rejects.toThrow("leaves");
        symlinkSync(tmp(), join(ws, "link"));
        symlinkSync(join(tmp(), "absent"), join(ws, "dangling"));
        const dangling = ev("apply_diff", { path: "dangling", content: "A" });
        await expect(driver.event(dangling)).rejects.toThrow("leaves");
        const through = ev("apply_diff", { path: "link/x", content: "A" });
        await expect(driver.event(through)).rejects.toThrow("leaves");
    });

    test("apply_diff runs no hook, filter, or monitor that the workspace repo's config names", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const outside = tmp();
        const ran = join(outside, "ran");
        const hook = join(outside, "hook.sh");
        writeFileSync(hook, `#!/bin/sh\ntouch ${ran}\ncat\n`, { mode: 0o755 });
        const hooks = join(outside, "hooks");
        mkdirSync(hooks);
        for (const name of ["post-commit", "prepare-commit-msg", "reference-transaction"]) {
            writeFileSync(join(hooks, name), `#!/bin/sh\ntouch ${ran}\n`, { mode: 0o755 });
        }
        const set = (key: string, value: string) =>
            spawnSync("git", ["config", key, value], { cwd: ws });
        set("core.hooksPath", hooks);
        set("core.fsmonitor", hook);
        set("filter.evil.clean", hook);
        set("filter.evil.required", "true");
        writeFileSync(join(ws, ".gitattributes"), "* filter=evil\n");
        await driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" }));
        expect(existsSync(ran)).toBe(false);
        const shown = spawnSync("git", ["show", "HEAD:src/a.txt"], { cwd: ws });
        expect(shown.stdout.toString()).toBe("A");
        expect(
            spawnSync("git", ["log", "--format=%s", "-1"], { cwd: ws }).stdout.toString().trim(),
        ).toBe("Add src/a.txt");
    });

    test("apply_diff refuses a workspace whose .git internals are symlinks", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const outside = tmp();
        rmSync(join(ws, ".git", "objects"), { recursive: true });
        symlinkSync(outside, join(ws, ".git", "objects"));
        const diff = ev("apply_diff", { path: "src/a.txt", content: "A" });
        await expect(driver.event(diff)).rejects.toThrow("symlink");
        expect(readdirSync(outside)).toEqual([]);
    });

    test("a resumed arm reopens the session the next event belongs to", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.event(ev("user_turn"))).rejects.toThrow("reset or resume first");
        await fresh.resume(ev("session_start"));
        expect(hosts.at(-1)?.opened).toEqual([`s-0000@${fresh.workspace("p")}`]);
        await fresh.resume(null);
        expect(hosts.at(-1)?.opened).toEqual([]);
    });

    test("resume stops the processes the killed harness recorded and restores the model", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.fault(episode("model_switch"));
        const orphan = Bun.spawn(["sleep", "300"]);
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        const start = readFileSync(`/proc/${orphan.pid}/stat`, "utf8")
            .split(") ")[1]
            ?.split(" ")[19];
        state.host = { pid: orphan.pid, start };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
        expect(fresh.host?.ctx.model).toBe("model-b");
    });

    test("stop still stops the daemon when the host refuses to close", async () => {
        const { driver } = fixture("eidnara");
        const host = new FakeHost({} as HostContext, "/x");
        host.failClose = true;
        let stopped = 0;
        driver.host = host as unknown as SimHost;
        driver.daemon = {
            ...fakeDaemon(10),
            stop: async () => void stopped++,
        } as unknown as DaemonStack;
        await expect(driver.stop()).rejects.toThrow("host survived");
        expect(stopped).toBe(1);
    });

    test("the transcript store is checked after the first session and a gap stops the run", async () => {
        const ok = fixture("host", { p: gitRepo() });
        await ok.driver.reset();
        mkdirSync(join(ok.transcripts, "sessions"), { recursive: true });
        await ok.driver.event(ev("session_end"));
        const record = JSON.parse(readFileSync(join(ok.armDir, "transcripts.json"), "utf8"));
        expect(record.missing).toEqual([]);

        const gap = fixture("host", { p: gitRepo() });
        await gap.driver.reset();
        const missing = join(gap.transcripts, "sessions");
        await expect(gap.driver.event(ev("session_end"))).rejects.toThrow(missing);
        const listed = JSON.parse(readFileSync(join(gap.armDir, "transcripts.json"), "utf8"));
        expect(listed.missing).toEqual([missing]);
    });

    test("a daemon gone after a turn is reported once with the turn id", async () => {
        const { driver, hosts, exits } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        const host = new FakeHost({} as HostContext, "/nonexistent");
        host.onPrompt = () => {
            daemon.current = null;
        };
        driver.host = host as unknown as SimHost;
        driver.daemon = daemon as unknown as DaemonStack;
        await driver.event(ev("user_turn", { id: "e-7", text: "go" }));
        expect(exits).toEqual([{ after: "e-7" }]);
        expect(hosts.length).toBe(0);

        const plain = fixture("host");
        plain.driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await plain.driver.event(ev("user_turn", { text: "go" }));
        expect(plain.exits).toEqual([]);
    });
});

describe("HostDriver faults", () => {
    test("daemon faults on the host arm are skipped for the missing daemon", async () => {
        const { driver } = fixture("host");
        await driver.reset();
        for (const type of ["daemon_sigkill_mid_fold", "daemon_restart"] as const) {
            expect(await driver.fault(episode(type))).toEqual({ skipped: "arm runs no daemon" });
        }
    });

    test("store_full without a loop-mounted store is skipped for the missing store", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        expect(await driver.fault(episode("store_full"))).toEqual({
            skipped: "arm runs no loop-mounted store",
        });
    });

    test("a daemon fault restarts through the stack and reports both pids", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        expect(await driver.fault(episode("daemon_restart"))).toEqual({
            signal: "SIGKILL",
            pid_before: 10,
            pid_after: 11,
            restarted_by: "harness",
        });
    });

    test("a model switch moves later sessions to the next model and keeps the daemon", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10) as unknown as DaemonStack;
        driver.daemon = daemon;
        expect(await driver.fault(episode("model_switch"))).toEqual({ model: "model-b" });
        expect(driver.host?.ctx.model).toBe("model-b");
        expect(driver.host?.ctx.keep).toEqual([driver.storeRoot]);
        expect(driver.daemon).toBe(daemon);
        expect(await driver.fault(episode("model_switch"))).toEqual({ model: "model-a" });
    });

    test("a between-session fault inside a session and a fault with no mechanism are refused", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.event(ev("session_start"));
        await expect(driver.fault(episode("model_switch"))).rejects.toThrow("between sessions");
        await expect(driver.fault(episode("host_upgrade"))).rejects.toThrow("no mechanism");
    });
});

describe("probe snapshots", () => {
    test("a tool run reported mid-turn is in the recorder's state before the turn returns", async () => {
        const { driver, hosts, armDir } = fixture("host", { p: gitRepo() });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        await fresh.event(ev("session_start", { session: "s-0" }));
        const run = { command: "cargo build", exit: 0, scenario_ms: 3 };
        host.onPrompt = () => {
            host.ctx.onTool?.(run);
            throw new Error("harness killed");
        };
        await expect(
            fresh.event(ev("user_turn", { id: "e-1", session: "s-0", text: "go" })),
        ).rejects.toThrow("harness killed");
        const state = JSON.parse(readFileSync(join(armDir, "snapshot-state.json"), "utf8"));
        expect(state.commands).toEqual([run]);
    });

    test("a probe turn that leaves an embedded repository in the workspace ends failed, naming it", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => {
            const vendor = join(ws, "vendor");
            mkdirSync(vendor);
            spawnSync("git", ["init", "-q"], { cwd: vendor });
            writeFileSync(join(vendor, "cache.rs"), "static CACHE: Mutex<u8>\n");
        };
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(outcome.failed).toBe("embedded repository at vendor");
        expect(outcome.snapshot).toBe("host:q-1:e-1");
    });

    test("a change to a file the source tracks despite its ignore rules is in the snapshot diff", async () => {
        const source = gitRepo();
        const g = (...args: string[]) =>
            spawnSync("git", args, {
                cwd: source,
                env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
            });
        writeFileSync(join(source, ".gitignore"), "*.cfg\n");
        writeFileSync(join(source, "limits.cfg"), "max = 1\n");
        g("add", ".gitignore");
        g("add", "--force", "limits.cfg");
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "track the ignored config");
        const { driver, hosts, armDir } = fixture("host", { p: source });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => writeFileSync(join(ws, "limits.cfg"), "max = 2\n");
        await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "raise it", probe: "q-1" }),
        );
        expect(captured(armDir)["host:q-1:e-1:diff"]?.patch).toContain("+max = 2");
    });

    test("a probe turn's snapshot carries its diff, commands, prior session, and calls, and grades", async () => {
        const { driver, hosts, armDir, transcripts } = fixture("host", { p: gitRepo() });
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        const calls = [
            {
                seq: 0,
                component: "agent",
                turn: "e-9",
                scenario_ms: 0,
                input_tokens: 5,
                output_tokens: 2,
                response_text: "done",
            },
        ];
        (driver as unknown as { o: DriverOptions }).o.callsFor = () => calls;
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => writeFileSync(join(ws, "earlier.rs"), "fn earlier() {}\n");
        await fresh.event(ev("user_turn", { id: "e-1", session: "s-0", text: "go" }));
        await fresh.event(ev("session_end", { session: "s-0" }));
        await fresh.event(ev("session_start", { session: "s-1" }));
        host.onPrompt = () => {
            writeFileSync(join(ws, "limits.rs"), "pub const DROWSY_EGRET_MAX: u32 = 1;\n");
            host.tools.push({ command: "cargo test", exit: 0, scenario_ms: 7 });
        };
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-9", session: "s-1", text: "cap it", probe: "q-1" }),
        );
        expect(outcome.snapshot).toBe("host:q-1:e-9");
        const [snap] = readFileSync(join(armDir, "snapshots.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        const byId = Object.fromEntries(snap.artefacts.map((a: { id: string }) => [a.id, a]));
        expect(byId["host:q-1:e-9:diff"].patch).toContain("+pub const DROWSY_EGRET_MAX");
        expect(byId["host:q-1:e-9:diff"].patch).not.toContain("earlier");
        expect(byId["host:q-1:e-9:prior-diff"].patch).toContain("+fn earlier()");
        expect(byId["host:q-1:e-9:turn-commands"].commands).toEqual([
            { command: "cargo test", exit: 0, scenario_ms: 7 },
        ]);
        expect(byId["host:q-1:e-9:session-commands"].commands).toEqual([
            { command: "cargo test", exit: 0, scenario_ms: 7 },
        ]);
        expect(byId["host:q-1:e-9:calls"].calls).toEqual(calls);
        expect(snap.turn_outcome).toBe("ok");
        host.onPrompt = () => undefined;
        host.failNext = true;
        const failed = await fresh.event(
            ev("user_turn", { id: "e-10", session: "s-1", text: "again", probe: "q-2" }),
        );
        expect(failed).toMatchObject({ failed: "boom", snapshot: "host:q-2:e-10" });
        const probe = {
            id: "q-1",
            type: "P1",
            fact: "f-1",
            project: "p",
            session: "s-1",
            text: "cap it",
            check: { must: ["DROWSY_EGRET_[A-Z0-9_]+"] },
        };
        const grade = gradeItem(probe, [snap], loadPrereg("S").grading);
        expect(grade?.verdict).toBe("pass");
        expect(grade?.inputs).toEqual(["host:q-1:e-9:diff"]);
    });

    test("a session_end replayed on resume keeps that session's diff as the next one's prior session", async () => {
        const { driver, hosts, armDir, transcripts } = fixture("host", { p: gitRepo() });
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        await driver.reset();
        const ws = driver.workspace("p");
        const start = ev("session_start", { id: "e-0", session: "s-0" });
        await driver.event(start);
        const host = hosts.at(-1) as FakeHost;
        host.onPrompt = () => writeFileSync(join(ws, "earlier.rs"), "fn earlier() {}\n");
        await driver.event(ev("user_turn", { id: "e-1", session: "s-0", text: "go" }));
        host.failClose = true;
        const end = ev("session_end", { id: "e-2", session: "s-0" });
        await expect(driver.event(end)).rejects.toThrow("host survived");

        const resumed = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await resumed.resume(start);
        await resumed.event(end);
        await resumed.event(ev("session_start", { id: "e-3", session: "s-1" }));
        await resumed.event(
            ev("user_turn", { id: "e-4", session: "s-1", text: "next", probe: "q-1" }),
        );
        expect(captured(armDir)["host:q-1:e-4:prior-diff"]?.patch).toContain("+fn earlier()");
    });
});

test("a recorder rebuilt after a harness kill keeps the open session's start tree and commands", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    first.addTools([{ command: "cargo build", exit: 0, scenario_ms: 1 }]);
    writeFileSync(join(repo, "new.rs"), "fn x() {}\n");
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => []);
    resumed.sessionStart("s-1", "p", repo);
    const before = resumed.tree(repo);
    const id = resumed.capture(
        { probe: "q", session: "s-1", id: "e-2" },
        "p",
        repo,
        before,
        [],
        false,
    );
    const snap = JSON.parse(readFileSync(join(armDir, "snapshots.jsonl"), "utf8"));
    expect(id).toBe("eidnara:q:e-2");
    const session = snap.artefacts.find((a: { id: string }) => a.id.endsWith("session-commands"));
    expect(session.commands).toEqual([{ command: "cargo build", exit: 0, scenario_ms: 1 }]);
    resumed.sessionEnd("s-1", "p", repo);
    const later = new SnapshotRecorder(armDir, "eidnara", () => []);
    later.sessionStart("s-2", "p", repo);
    const next = later.capture(
        { probe: "r", session: "s-2", id: "e-3" },
        "p",
        repo,
        later.tree(repo),
        [],
        false,
    );
    const lines = readFileSync(join(armDir, "snapshots.jsonl"), "utf8").trim().split("\n");
    const prior = JSON.parse(lines[1] as string).artefacts.find(
        (a: { id: string }) => a.id === `${next}:prior-diff`,
    );
    expect(prior.patch).toContain("+fn x() {}");
});

function captured(armDir: string): Record<string, { patch?: string }> {
    const lines = readFileSync(join(armDir, "snapshots.jsonl"), "utf8").trim().split("\n");
    const snap = JSON.parse(lines.at(-1) as string);
    return Object.fromEntries(snap.artefacts.map((a: { id: string }) => [a.id, a]));
}

test("a recorder rebuilt over a cut last snapshot line drops the cut and appends whole records", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    first.capture(
        { probe: "q", session: "s-1", id: "e-1" },
        "p",
        repo,
        first.tree(repo),
        [],
        false,
    );
    const path = join(armDir, "snapshots.jsonl");
    const whole = readFileSync(path, "utf8");
    writeFileSync(path, `${whole}{"id":"eidnara:r:e-2","item":"r","arte`);
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => []);
    resumed.sessionStart("s-1", "p", repo);
    resumed.capture(
        { probe: "r", session: "s-1", id: "e-2" },
        "p",
        repo,
        resumed.tree(repo),
        [],
        false,
    );
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["eidnara:q:e-1", "eidnara:r:e-2"]);
});

test("snapshot git refuses a workspace path that an agent replaced with a symlink", () => {
    const armDir = tmp();
    const workspaces = join(armDir, "r", "workspaces");
    mkdirSync(workspaces, { recursive: true });
    const outside = tmp();
    writeFileSync(join(outside, "credentials"), "aws_secret_access_key = leaked\n");
    symlinkSync(outside, join(workspaces, "p"));
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    expect(() => recorder.tree(join(workspaces, "p"))).toThrow("symlink");
    expect(existsSync(join(armDir, "snapshot.git"))).toBe(false);
});

test("snapshot git runs no command and indexes no path that the workspace repo's config names", () => {
    const repo = gitRepo();
    const outside = tmp();
    const ran = join(outside, "ran");
    const hook = join(outside, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${ran}\ncat\n`, { mode: 0o755 });
    writeFileSync(join(outside, "secret"), "aws_secret_access_key = leaked\n");
    const set = (key: string, value: string) =>
        spawnSync("git", ["config", key, value], { cwd: repo });
    set("filter.evil.clean", hook);
    set("diff.external", hook);
    set("diff.evil.textconv", hook);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.sessionStart("s-1", "p", repo);
    const before = recorder.tree(repo);
    writeFileSync(join(repo, "new.rs"), "fn x() {}\n");
    recorder.capture({ probe: "q", session: "s-1", id: "e-1" }, "p", repo, before, [], false);
    expect(existsSync(ran)).toBe(false);
    expect(captured(armDir)["eidnara:q:e-1:diff"]?.patch).toContain("+fn x() {}");

    set("core.worktree", outside);
    const moved = recorder.tree(repo);
    writeFileSync(join(repo, "more.rs"), "fn y() {}\n");
    recorder.capture({ probe: "r", session: "s-1", id: "e-2" }, "p", repo, moved, [], false);
    const patch = captured(armDir)["eidnara:r:e-2:diff"]?.patch;
    expect(patch).toContain("+fn y() {}");
    expect(patch).not.toContain("leaked");
    expect(existsSync(ran)).toBe(false);
});

test("snapshot patches keep their b/ paths under a system git config and inherited git variables", () => {
    const repo = gitRepo();
    const system = join(tmp(), "gitconfig");
    writeFileSync(system, "[diff]\n\tnoprefix = true\n");
    const saved = { system: process.env.GIT_CONFIG_SYSTEM, dir: process.env.GIT_DIR };
    process.env.GIT_CONFIG_SYSTEM = system;
    process.env.GIT_DIR = join(tmp(), "not-a-repo");
    try {
        const armDir = tmp();
        const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
        recorder.sessionStart("s-1", "p", repo);
        const before = recorder.tree(repo);
        writeFileSync(join(repo, "new.rs"), "fn x() {}\n");
        recorder.capture({ probe: "q", session: "s-1", id: "e-1" }, "p", repo, before, [], false);
        const patch = captured(armDir)["eidnara:q:e-1:diff"]?.patch ?? "";
        expect(diffPaths(patch)).toEqual(["new.rs"]);
    } finally {
        for (const [key, value] of [
            ["GIT_CONFIG_SYSTEM", saved.system],
            ["GIT_DIR", saved.dir],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
