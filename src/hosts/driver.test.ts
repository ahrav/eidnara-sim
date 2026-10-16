import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    appendFileSync,
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
import { basename, dirname, join } from "node:path";
import { SEGMENTS_DDL } from "../../tests/segments";
import { loadConfig } from "../config/config";
import type { CallView } from "../grade/artefacts";
import { gradeItem } from "../grade/probes";
import { diffPaths } from "../grade/text";
import { readJournal } from "../run/journal";
import { HarnessFailure, type ScenarioEvent } from "../run/scheduler";
import { type FaultType, SEAMS } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import type { DaemonStack, HostContext, PromptResult, SimHost } from "./arms";
import { type DriverOptions, expandTemplate, HostDriver } from "./driver";
import { SnapshotRecorder } from "./snapshot";
import type { StoreCheck } from "./storecheck";

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
        crash: async () => undefined,
        restart: async () => {
            d.current = (d.current ?? 0) + 1;
        },
        stop: async () => undefined,
        connectionFile: "/run/conn",
    };
    return d;
}

const PASS =
    "[2026-10-16T12:00:00.000Z] [eidnara][s-1] rust pass: decision=SOFT+ reason=none served_from=transform in=3 out=3";
/** Appends one line to the arm's plugin log, as the host's plugin would. */
function pluginLog(driver: HostDriver, line: string): void {
    const path = join((driver as unknown as { o: DriverOptions }).o.armRoot, "eidnara.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
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

    test("apply_diff runs plumbing under a pristine repo config and refuses alternates", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const outside = tmp();
        const ran = join(outside, "ran");
        const hook = join(outside, "hook.sh");
        writeFileSync(hook, `#!/bin/sh\ntouch ${ran}\ncat\n`, { mode: 0o755 });
        const hooks = join(outside, "hooks");
        mkdirSync(hooks);
        writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\ntouch ${ran}\n`, {
            mode: 0o755,
        });
        writeFileSync(join(outside, "more.gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
        const config = join(ws, ".git", "config");
        const before = readFileSync(config, "utf8");
        writeFileSync(
            config,
            `${before}[filter "a=b"]\n\tclean = ${hook}\n\trequired = true\n[include]\n\tpath = ${join(outside, "more.gitconfig")}\n[user]\n\tname = agent\n`,
        );
        writeFileSync(join(ws, ".gitattributes"), "* filter=a=b\n");
        await driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" }));
        expect(existsSync(ran)).toBe(false);
        expect(spawnSync("git", ["show", "HEAD:src/a.txt"], { cwd: ws }).stdout.toString()).toBe(
            "A",
        );
        expect(readFileSync(config, "utf8")).toContain("name = agent");
        mkdirSync(join(ws, ".git", "objects", "info"), { recursive: true });
        writeFileSync(join(ws, ".git", "objects", "info", "alternates"), `${outside}\n`);
        const next = ev("apply_diff", { path: "src/b.txt", content: "B" });
        await expect(driver.event(next)).rejects.toThrow("alternates");
    });

    test("apply_diff keeps the executable bit of the file it updates", async () => {
        const source = gitRepo();
        writeFileSync(join(source, "run.sh"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
        spawnSync("git", ["add", "run.sh"], { cwd: source });
        spawnSync(
            "git",
            ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add the script"],
            {
                cwd: source,
                env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
            },
        );
        const { driver } = fixture("host", { p: source });
        await driver.reset();
        const ws = driver.workspace("p");
        await driver.event(ev("apply_diff", { path: "run.sh", content: "#!/bin/sh\necho 2\n" }));
        const tree = spawnSync("git", ["ls-tree", "HEAD", "run.sh"], { cwd: ws }).stdout.toString();
        expect(tree.startsWith("100755 ")).toBe(true);
        expect(
            spawnSync("git", ["status", "--porcelain"], { cwd: ws }).stdout.toString().trim(),
        ).toBe("");
    });

    test("apply_diff reports a dangling symlink, a missing workspace, and a missing repo config as harness failures", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        symlinkSync(join(tmp(), "absent"), join(ws, "sub"));
        await expect(
            driver.event(ev("apply_diff", { path: "sub/a.txt", content: "A" })),
        ).rejects.toThrow(HarnessFailure);
        rmSync(join(ws, ".git", "config"));
        await expect(
            driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
        ).rejects.toThrow(HarnessFailure);
        rmSync(ws, { recursive: true });
        await expect(
            driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
        ).rejects.toThrow(HarnessFailure);
    });

    test("apply_diff proceeds over a scratch index lock a killed git left behind", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        writeFileSync(join(armDir, "apply-diff.index.lock"), "");
        await driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" }));
        const ws = driver.workspace("p");
        expect(spawnSync("git", ["show", "HEAD:src/a.txt"], { cwd: ws }).stdout.toString()).toBe(
            "A",
        );
    });

    test("apply_diff refuses a workspace replaced by a symlink and creates no directory through one", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const outside = tmp();
        symlinkSync(outside, join(ws, "vendor"));
        const through = ev("apply_diff", { path: "vendor/deep/x.txt", content: "A" });
        await expect(driver.event(through)).rejects.toThrow("leaves");
        expect(readdirSync(outside)).toEqual([]);
        const elsewhere = tmp();
        spawnSync("git", ["init", "-q"], { cwd: elsewhere });
        rmSync(ws, { recursive: true });
        symlinkSync(elsewhere, ws);
        const root = ev("apply_diff", { path: "src/a.txt", content: "A" });
        await expect(driver.event(root)).rejects.toThrow("symlink");
        expect(existsSync(join(elsewhere, "src"))).toBe(false);
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

    test("the state file is replaced whole, with no staged copy left behind", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        writeFileSync(join(armDir, "state.json"), '{"model": 1, "daemon": null, "ho');
        await driver.fault(episode("model_switch"));
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.model).toBe(1);
        expect(readdirSync(armDir).filter((f) => f.startsWith("state.json"))).toEqual([
            "state.json",
        ]);
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

    test("a daemon fault samples the outgoing daemon, restarts through the stack, reports both pids, and samples the new one", async () => {
        const { driver } = fixture("eidnara");
        const seen: number[] = [];
        (driver as unknown as { o: DriverOptions }).o.sampleDaemon = () =>
            void seen.push(driver.daemonPid() ?? -1);
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        expect(await driver.fault(episode("daemon_restart"))).toEqual({
            signal: "SIGKILL",
            pid_before: 10,
            pid_after: 11,
            restarted_by: "harness",
            store: { integrity: "missing", segments: 0, overlaps: [], ranges: [] },
        });
        expect(seen).toEqual([10, 11]);
    });

    test("the store a daemon kill leaves is inspected before the replacement starts", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        const db = new Database(driver.storeDb);
        db.run(SEGMENTS_DDL);
        db.run(
            "insert into history_segments (session_id, sequence, start_message, end_message) values ('s', 1, 0, 9)",
        );
        db.close();
        const phases: string[] = [];
        daemon.crash = async () => {
            phases.push(`crash:${daemon.current}`);
            daemon.current = null;
        };
        daemon.restart = async () => {
            phases.push("start");
            new Database(driver.storeDb).run("delete from history_segments");
            daemon.current = 11;
        };
        driver.daemon = daemon as unknown as DaemonStack;
        const evidence = await driver.fault(episode("daemon_sigkill_mid_fold"));
        expect(phases).toEqual(["crash:10", "start"]);
        expect(evidence.pid_after).toBe(11);
        expect((evidence.store as StoreCheck).ranges.map((r) => r.slice(0, 4))).toEqual([
            ["s", 1, 0, 9],
        ]);
    });

    test("a mid-fold kill's turn carries the store check once the replacement served a pass", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        daemon.restart = async () => {
            await Bun.sleep(100);
            daemon.current = 11;
        };
        driver.daemon = daemon as unknown as DaemonStack;
        const host = new FakeHost({} as HostContext, "/x");
        driver.host = host as unknown as SimHost;
        const kill = driver.fault(episode("daemon_sigkill_mid_fold"));
        host.prompt = async () => {
            await kill;
            pluginLog(driver, PASS);
            return {};
        };
        const outcome = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["f-daemon_sigkill_mid_fold"]);
        expect((await kill).pid_after).toBe(11);
    });

    test("a restart that fails during the interrupted turn fails that turn", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        daemon.restart = async () => {
            await Bun.sleep(50);
            throw new Error("fixture did not start");
        };
        driver.daemon = daemon as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        const kill = driver.fault(episode("daemon_sigkill_mid_fold"));
        kill.catch(() => undefined);
        await expect(driver.event(ev("user_turn", { id: "e-1", text: "go" }))).rejects.toThrow(
            "fixture did not start",
        );
        await expect(kill).rejects.toThrow("fixture did not start");
    });

    test("a store check owed by a daemon restart survives a harness restart", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        await driver.fault(episode("daemon_restart"));
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(Object.keys(state.store_faults)).toEqual(["f-daemon_restart"]);
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        fresh.daemon = fakeDaemon(12) as unknown as DaemonStack;
        pluginLog(fresh, PASS);
        const outcome = await fresh.event(ev("user_turn", { id: "e-1", text: "go", project: "p" }));
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
        const recorded = () => JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(Object.keys(recorded().store_faults)).toEqual(["f-daemon_restart"]);
        await fresh.event(ev("user_turn", { id: "e-2", text: "go", project: "p" }));
        expect(recorded().store_faults).toEqual({});
    });

    test("the turn ending after daemon restarts carries a store check for each of them", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        await driver.fault(episode("daemon_sigkill_mid_fold"));
        pluginLog(driver, PASS);
        const first = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        const second = await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
        const store = { integrity: "missing", segments: 0, overlaps: [], ranges: [] };
        expect(first.stores).toEqual([
            { fault: "f-daemon_restart", store },
            { fault: "f-daemon_sigkill_mid_fold", store },
        ]);
        expect(second.stores).toBeUndefined();
    });

    test("a pass the replacement serves while its start is still settling counts", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        daemon.restart = async () => {
            daemon.current = 11;
            pluginLog(driver, PASS);
        };
        driver.daemon = daemon as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        const outcome = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
    });

    test("a pass a background call serves after the last turn is checked at session end or finish", async () => {
        const { driver, transcripts } = fixture("host", { p: gitRepo() });
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        await driver.reset();
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        await driver.event(ev("session_start"));
        await driver.fault(episode("daemon_restart"));
        const turn = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(turn.stores).toBeUndefined();
        pluginLog(driver, PASS);
        const end = await driver.event(ev("session_end", { id: "e-2" }));
        expect(end.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
        // The recorded obligation outlives the session end until the scheduler has journaled it.
        const recorded = () => JSON.parse(readFileSync(join(driver.armDir, "state.json"), "utf8"));
        expect(Object.keys(recorded().store_faults)).toEqual(["f-daemon_restart"]);
        await driver.event(ev("session_start", { id: "e-3", session: "s-0001" }));
        await driver.fault(episode("daemon_sigkill_mid_fold"));
        await driver.event(ev("user_turn", { id: "e-4", text: "go", session: "s-0001" }));
        pluginLog(driver, PASS);
        const last = await driver.finish();
        expect(last.stores?.map((s) => s.fault)).toEqual(["f-daemon_sigkill_mid_fold"]);
    });

    test("a restart settles the check an earlier restart's served pass earned, before it kills the daemon", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        pluginLog(driver, PASS);
        const second = await driver.fault(episode("daemon_sigkill_mid_fold"));
        expect((second.stores as { fault: string }[]).map((s) => s.fault)).toEqual([
            "f-daemon_restart",
        ]);
        const turn = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(turn.stores).toBeUndefined();
    });

    test("the store check waits for the first pass the replacement daemon serves", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        pluginLog(driver, PASS);
        await driver.fault(episode("daemon_restart"));
        pluginLog(
            driver,
            "[2026-10-16T12:00:01.000Z] [eidnara][s-1] rust pass: decision=error reason=none served_from=raw",
        );
        const raw = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(raw.stores).toBeUndefined();
        pluginLog(
            driver,
            "[2026-10-16T12:00:02.000Z] [eidnara][s-1] rust pass: decision=declined:invocation_budget reason=none served_from=raw",
        );
        const declined = await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
        expect(declined.stores).toBeUndefined();
        pluginLog(driver, PASS);
        const folded = await driver.event(ev("user_turn", { id: "e-3", text: "go" }));
        expect(folded.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
        const after = await driver.event(ev("user_turn", { id: "e-4", text: "go" }));
        expect(after.stores).toBeUndefined();
    });

    test("finish stops the daemon and writes the final store check", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        let stopped = false;
        daemon.stop = async () => {
            stopped = true;
        };
        driver.daemon = daemon as unknown as DaemonStack;
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        new Database(driver.storeDb).run(SEGMENTS_DDL);
        await driver.finish();
        expect(stopped).toBe(true);
        const check = JSON.parse(readFileSync(join(driver.armDir, "store-check.json"), "utf8"));
        expect(check).toEqual({ integrity: "ok", segments: 0, overlaps: [], ranges: [] });
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

    test("tools.jsonl attributes each run to the turn in progress, and to no turn at session end", async () => {
        const { driver, hosts, armDir, transcripts } = fixture("host", { p: gitRepo() });
        await driver.reset();
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        const host = hosts.at(-1) as FakeHost;
        await driver.event(ev("session_start", { session: "s-0" }));
        const mid = { command: "cargo build", exit: 0, scenario_ms: 3 };
        const drained = { command: "cargo test", exit: null, scenario_ms: 5 };
        host.onPrompt = () => {
            host.ctx.onTool?.(mid);
            host.tools.push(drained);
        };
        await driver.event(ev("user_turn", { id: "e-1", session: "s-0", text: "go" }));
        host.onPrompt = () => {};
        host.tools.push({ command: "ls", exit: null, scenario_ms: 9 });
        await driver.event(ev("session_end", { session: "s-0" }));
        const lines = readFileSync(join(armDir, "tools.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        expect(lines).toEqual([
            { turn: "e-1", ...mid },
            { turn: "e-1", ...drained },
            { turn: null, command: "ls", exit: null, scenario_ms: 9 },
        ]);
    });

    test("an embedded repository inside an already-indexed directory, or empty, is found; an ignored one is not", () => {
        const repo = gitRepo();
        mkdirSync(join(repo, "src"));
        writeFileSync(join(repo, "src", "lib.rs"), "fn lib() {}\n");
        writeFileSync(join(repo, ".gitignore"), "target/\n");
        const armDir = tmp();
        const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
        recorder.sessionStart("s-1", "p", repo);
        recorder.tree(repo);
        spawnSync("git", ["init", "-q"], { cwd: join(repo, "src") });
        mkdirSync(join(repo, "empty"));
        spawnSync("git", ["init", "-q"], { cwd: join(repo, "empty") });
        mkdirSync(join(repo, "target"));
        spawnSync("git", ["init", "-q"], { cwd: join(repo, "target") });
        expect(recorder.embedded(repo)).toEqual(["empty", "src"]);
        expect(recorder.tree(repo)).toMatch(/^[0-9a-f]{40}$/);
    });

    test("a probe turn that changes the ignore rules ends failed, naming the rule file", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => {
            writeFileSync(join(ws, "cache.rs"), "static STORE: Mutex<u8>;\n");
            writeFileSync(join(ws, ".gitignore"), "cache.rs\n");
        };
        const hidden = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(hidden.failed).toBe("ignore rules changed: .gitignore (added)");
        host.onPrompt = () => appendFileSync(join(ws, ".git", "info", "exclude"), "cache.rs\n");
        const excluded = await fresh.event(
            ev("user_turn", { id: "e-2", session: "s-0", text: "go", probe: "q-2" }),
        );
        expect(excluded.failed).toContain(".git/info/exclude (changed)");
        host.onPrompt = () => writeFileSync(join(ws, "plain.rs"), "fn ok() {}\n");
        rmSync(join(ws, ".gitignore"));
        const stillChanged = await fresh.event(
            ev("user_turn", { id: "e-3", session: "s-0", text: "go", probe: "q-3" }),
        );
        expect(stillChanged.failed).toContain(".git/info/exclude (changed)");
        expect(stillChanged.failed).not.toContain(".gitignore");
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

    test("the snapshot's proxy calls are read after the run has settled its background jobs", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const calls: CallView[] = [];
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.callsFor = () => [...calls];
        o.settle = async () => {
            await Bun.sleep(20);
            calls.push({
                seq: 0,
                component: "history_summarizer",
                turn: "e-1",
                scenario_ms: 5,
                input_tokens: 9,
                output_tokens: 3,
            });
        };
        const fresh = new HostDriver(o);
        await fresh.reset();
        hosts.at(-1);
        await fresh.event(ev("session_start", { session: "s-0" }));
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        const armDir = dirname(o.armRoot);
        const snap = JSON.parse(readFileSync(join(armDir, "snapshots.jsonl"), "utf8").trim());
        const byId = Object.fromEntries(snap.artefacts.map((a: { id: string }) => [a.id, a]));
        expect(outcome.snapshot).toBe("host:q-1:e-1");
        expect(byId["host:q-1:e-1:calls"].calls.map((c: CallView) => c.component)).toEqual([
            "history_summarizer",
        ]);
    });

    test("a tracked-but-ignored path whose parent became a symlink is left out of the tree", () => {
        const repo = gitRepo();
        const armDir = tmp();
        const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
        recorder.trackIgnored(basename(repo), ["sub/limits.cfg"]);
        const outside = tmp();
        writeFileSync(join(outside, "limits.cfg"), "max = 9\n");
        symlinkSync(outside, join(repo, "sub"));
        recorder.sessionStart("s-1", "p", repo);
        expect(recorder.tree(repo)).toMatch(/^[0-9a-f]{40}$/);
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

test("a recorder rebuilt after a harness kill drops a tools.jsonl line the kill cut", () => {
    const armDir = tmp();
    const path = join(armDir, "tools.jsonl");
    writeFileSync(
        path,
        `${JSON.stringify({ turn: "e-1", command: "ls", exit: 0, scenario_ms: 1 })}\n{"turn": "e-2", "comm`,
    );
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => []);
    resumed.addTools([{ command: "cargo build", exit: 0, scenario_ms: 3 }], "e-2");
    expect(readJournal(path).map((e) => e.command)).toEqual(["ls", "cargo build"]);
});

test("a recorder rebuilt after a harness kill keeps the open session's start tree and commands", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    first.addTools([{ command: "cargo build", exit: 0, scenario_ms: 1 }], "e-1");
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

test("a recorder rebuilt over a stale index lock waits its bound for the holder, then removes it", async () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    const lock = join(armDir, "snapshot.git", `${basename(repo)}.index.lock`);
    writeFileSync(lock, "");
    const holder = Bun.spawn(["sh", "-c", `sleep 0.2; rm -f '${lock}'`]);
    const started = Date.now();
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => [], 5_000);
    expect(Date.now() - started).toBeLessThan(4_000);
    await holder.exited;
    writeFileSync(join(repo, "new.rs"), "fn x() {}\n");
    expect(resumed.tree(repo)).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(lock, "");
    const bounded = Date.now();
    new SnapshotRecorder(armDir, "eidnara", () => [], 200);
    expect(Date.now() - bounded).toBeGreaterThanOrEqual(200);
    expect(existsSync(lock)).toBe(false);
});

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

test("a snapshot diff shows added lines of a file git would call binary", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.sessionStart("s-1", "p", repo);
    const before = recorder.tree(repo);
    writeFileSync(join(repo, ".gitattributes"), "*.ts -diff\n");
    writeFileSync(join(repo, "rule.ts"), "const DROWSY_EGRET_MAX = 1;\n");
    writeFileSync(join(repo, "blob.rs"), "static STORE: Mutex<u8>;\n\0padding\n");
    recorder.capture({ probe: "q", session: "s-1", id: "e-1" }, "p", repo, before, [], false);
    const patch = captured(armDir)["eidnara:q:e-1:diff"]?.patch ?? "";
    expect(patch).toContain("+const DROWSY_EGRET_MAX = 1;");
    expect(patch).toContain("+static STORE: Mutex<u8>;");
    expect(patch).not.toContain("Binary files");
});

test("snapshot git refuses a workspace path that an agent replaced with a symlink", () => {
    const armDir = tmp();
    const workspaces = join(armDir, "r", "workspaces");
    mkdirSync(workspaces, { recursive: true });
    const outside = tmp();
    writeFileSync(join(outside, "credentials"), "aws_secret_access_key = leaked\n");
    mkdirSync(join(outside, "vendor", ".git"), { recursive: true });
    symlinkSync(outside, join(workspaces, "p"));
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    expect(() => recorder.embedded(join(workspaces, "p"))).toThrow("symlink");
    expect(() => recorder.tree(join(workspaces, "p"))).toThrow("symlink");
    expect(existsSync(join(armDir, "snapshot.git"))).toBe(false);
});

test("the workspace walk is bounded by the recorder deadline", () => {
    const repo = gitRepo();
    const armDir = tmp();
    for (let i = 0; i < 3_000; i++) {
        mkdirSync(join(repo, "wide", `d${i}`, "deeper"), { recursive: true });
        writeFileSync(join(repo, "wide", `d${i}`, "f.rs"), "");
    }
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => [], 1);
    expect(() => recorder.embedded(repo)).toThrow("timed out");
    const roomy = new SnapshotRecorder(armDir, "eidnara", () => [], 10_000);
    expect(roomy.embedded(repo)).toEqual([]);
});

test("the nested-repository check is bounded like the other snapshot git runs", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => [], 300);
    recorder.sessionStart("s-1", "p", repo);
    mkdirSync(join(repo, "vendor"));
    spawnSync("git", ["init", "-q"], { cwd: join(repo, "vendor") });
    rmSync(join(repo, ".gitignore"), { force: true });
    spawnSync("mkfifo", [join(repo, ".gitignore")]);
    const started = Date.now();
    expect(() => recorder.embedded(repo)).toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
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

test("snapshot git that outlives its bound fails the probe turn instead of hanging the harness", async () => {
    const shim = tmp();
    const real = spawnSync("sh", ["-c", "command -v git"]).stdout.toString().trim();
    writeFileSync(
        join(shim, "git"),
        `#!/bin/sh\nif [ "$1" = "add" ]; then sleep 30; fi\nexec ${real} "$@"\n`,
        { mode: 0o755 },
    );
    const { driver, hosts, transcripts } = fixture("host", { p: gitRepo() });
    mkdirSync(join(transcripts, "sessions"), { recursive: true });
    const o = { ...(driver as unknown as { o: DriverOptions }).o, turnDeadlineMs: 300 };
    const fresh = new HostDriver(o);
    await fresh.reset();
    const host = hosts.at(-1) as FakeHost;
    await fresh.event(ev("session_start", { session: "s-0" }));
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
        const started = Date.now();
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(outcome.failed).toContain("timed out");
        expect(outcome.snapshot).toBeUndefined();
        expect(host.closed).toBe(0);
        await fresh.event(ev("session_end", { session: "s-0" }));
        expect(host.closed).toBe(1);
    } finally {
        process.env.PATH = path;
    }
    await fresh.event(ev("session_start", { session: "s-1" }));
    const next = await fresh.event(
        ev("user_turn", { id: "e-2", session: "s-1", text: "again", probe: "q-2" }),
    );
    expect(next.failed).toBeUndefined();
    expect(next.snapshot).toBe("host:q-2:e-2");
});
