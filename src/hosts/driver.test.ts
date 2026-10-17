import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/config";
import { gradeItem } from "../grade/probes";
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
    connections: (string | null)[] = [];
    closed = 0;
    onPrompt: () => void = () => undefined;
    constructor(
        readonly ctx: HostContext,
        private readonly transcripts: string,
    ) {}
    async openSession(cwd: string, session: string, connection: string | null = null) {
        this.opening = true;
        await this.gate;
        this.opening = false;
        this.opened.push(`${session}@${cwd}`);
        this.connections.push(connection);
    }
    gate: Promise<void> = Promise.resolve();
    opening = false;
    closedWhileOpening = 0;
    failNext = false;
    interrupts: (number | undefined)[] = [];
    async prompt(_text: string, _timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        this.onPrompt();
        this.interrupts.push(interruptMs);
        if (interruptMs !== undefined) return { interrupted: true };
        if (!this.failNext) return {};
        this.failNext = false;
        return { error: "boom" };
    }
    failClose = false;
    async closeSession() {
        if (this.opening) this.closedWhileOpening++;
        this.closed++;
        if (this.failClose) throw new Error("host survived");
    }
    transcriptEnv() {
        return { PI_CODING_AGENT_DIR: this.transcripts };
    }
    hostPid() {
        return this.pid;
    }
    pid: number | null = null;
    tools: { command: string; exit: number | null; scenario_ms: number }[] = [];
    drainTools() {
        return this.tools.splice(0);
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
        gate: Promise.resolve() as Promise<void>,
        restarting: false,
        stoppedWhileRestarting: 0,
        stops: 0,
        restart: async () => {
            d.restarting = true;
            await d.gate;
            d.restarting = false;
            d.current = (d.current ?? 0) + 1;
        },
        stop: async () => {
            if (d.restarting) d.stoppedWhileRestarting++;
            if (d.starting) d.stoppedWhileStarting++;
            d.stops++;
        },
        connectionFile: "/run/conn",
        starting: false,
        stoppedWhileStarting: 0,
        start: async () => {
            d.starting = true;
            await d.gate;
            d.starting = false;
            d.current = d.current ?? 10;
        },
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

    test("a scheduled interrupt reaches the host's prompt and the turn reports it", async () => {
        const { driver } = fixture("host");
        const host = new FakeHost({} as HostContext, "/x");
        driver.host = host as unknown as SimHost;
        const cut = await driver.event(
            ev("user_turn", { id: "e-1", text: "go", interrupt_ms: 7_000 }),
        );
        const plain = await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
        expect(host.interrupts).toEqual([7_000, undefined]);
        expect([cut.user, cut.failed, plain.user]).toEqual([
            { interrupted: true },
            undefined,
            undefined,
        ]);
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
            store: { integrity: "missing", segments: 0, overlaps: [], ranges: [] },
        });
    });

    test("the turn ending after daemon restarts carries a store check for each of them", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        await driver.fault(episode("daemon_sigkill_mid_fold"));
        const first = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        const second = await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
        const store = { integrity: "missing", segments: 0, overlaps: [], ranges: [] };
        expect(first.stores).toEqual([
            { fault: "f-daemon_restart", store },
            { fault: "f-daemon_sigkill_mid_fold", store },
        ]);
        expect(second.stores).toBeUndefined();
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
        new Database(driver.storeDb).run(
            "create table history_segments (session_id text, sequence integer, start_message integer, end_message integer)",
        );
        await driver.finish();
        expect(stopped).toBe(true);
        const check = JSON.parse(readFileSync(join(driver.armDir, "store-check.json"), "utf8"));
        expect(check).toEqual({ integrity: "ok", segments: 0, overlaps: [], ranges: [] });
    });

    test("an A/A control label runs as its arm: the host sees the base arm and no store", async () => {
        const { driver } = fixture("eidnara~aa");
        await driver.fault(episode("model_switch"));
        expect(driver.host?.ctx.arm).toBe("eidnara");
        expect(driver.host?.ctx.keep).toContain(driver.storeRoot);
        const plain = fixture("host~aa").driver;
        await plain.fault(episode("model_switch"));
        expect(plain.host?.ctx.arm).toBe("host");
        expect(plain.host?.ctx.keep).not.toContain(plain.storeRoot);
    });

    test("a host upgrade moves later sessions to the configured next version, or is skipped", async () => {
        const { driver } = fixture("host");
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.hostVersions = { from: "0.80.2", to: "0.87.1" };
        o.config = { ...o.config, upgrade: undefined };
        expect(await driver.fault(episode("host_upgrade"))).toEqual({
            skipped: "no next pi version is configured (config.upgrade.pi_install)",
        });
        o.config = { ...o.config, upgrade: { pi_install: "/next/pi" } };
        expect(await driver.fault(episode("host_upgrade"))).toEqual({
            host: "pi",
            from: o.config.pi_install,
            to: "/next/pi",
            from_version: "0.80.2",
            to_version: "0.87.1",
            takes_effect: "next session_start",
        });
        expect(driver.host?.ctx.config.pi_install).toBe("/next/pi");
        await driver.fault(episode("model_switch"));
        expect(driver.host?.ctx.config.pi_install).toBe("/next/pi");
        const resumed = new HostDriver(o);
        await resumed.resume(null);
        expect(resumed.host?.ctx.config.pi_install).toBe("/next/pi");
        await resumed.stop();
    });

    test("a second host client runs one turn on the arm's daemon at the session's start", async () => {
        const { driver, hosts } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        const evidence = await driver.fault(episode("two_hosts_one_daemon"), at);
        expect(evidence).toMatchObject({
            second_session: "s-0000-b",
            daemon_pid: 10,
            outcome: "ok",
        });
        const second = hosts.at(-1) as FakeHost;
        second.pid = process.pid;
        expect(second.opened).toEqual([`s-0000-b@${driver.workspace("p")}`]);
        expect(second.connections).toEqual([driver.daemon.connectionFile]);
        expect(second.closed).toBe(0);
        const inner = driver as unknown as Record<string, unknown> & { newHost(): SimHost };
        driver.host = inner.newHost();
        const noop = () => undefined;
        inner.snapshots = { sessionStart: noop, sessionEnd: noop, addTools: noop };
        inner.transcriptsChecked = true;
        await driver.event(at);
        expect(second.closed).toBe(0);
        await driver.event(ev("session_end", { project: "p" }));
        expect(second.closed).toBe(1);
        await expect(driver.fault(episode("two_hosts_one_daemon"))).rejects.toThrow(
            "session_start",
        );
        const plain = fixture("host").driver;
        expect(await plain.fault(episode("two_hosts_one_daemon"), at)).toEqual({
            skipped: "arm runs no daemon",
        });
    });

    test("a second client that exits before the primary's session_end fails the arm", async () => {
        const { driver, hosts } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        await driver.fault(episode("two_hosts_one_daemon"), at);
        const second = hosts.at(-1) as FakeHost;
        const inner = driver as unknown as Record<string, unknown> & { newHost(): SimHost };
        driver.host = inner.newHost();
        const noop = () => undefined;
        inner.snapshots = { sessionStart: noop, sessionEnd: noop, addTools: noop };
        inner.transcriptsChecked = true;
        await driver.event(at);
        second.pid = Bun.spawnSync(["true"]).pid;
        await expect(driver.event(ev("session_end", { project: "p" }))).rejects.toThrow(
            "second client exited before the primary session's session_end",
        );
    });

    test("stopping while the second client opens waits for the open, then closes it", async () => {
        const { driver, hosts } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const o = (driver as unknown as { o: DriverOptions }).o;
        const factory = o.hostFactory as (ctx: HostContext) => SimHost;
        o.hostFactory = (ctx) => {
            const h = factory(ctx) as unknown as FakeHost;
            h.gate = gate;
            h.pid = process.pid;
            return h as unknown as SimHost;
        };
        const fault = driver.fault(
            episode("two_hosts_one_daemon"),
            ev("session_start", { project: "p" }),
        );
        fault.catch(() => undefined);
        await Bun.sleep(5);
        const second = hosts.at(-1) as FakeHost;
        expect(second.opening).toBe(true);
        let stopped = false;
        const stop = driver.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(20);
        expect([stopped, second.closedWhileOpening]).toEqual([false, 0]);
        release();
        await stop;
        await expect(fault).rejects.toThrow("the arm stopped while the second client opened");
        expect(second.closed).toBeGreaterThanOrEqual(1);
        expect(second.closedWhileOpening).toBe(0);
    });

    test("the second client's tool runs are recorded under its session", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        const o = (driver as unknown as { o: DriverOptions }).o;
        const factory = o.hostFactory as (ctx: HostContext) => SimHost;
        o.hostFactory = (ctx) => {
            const h = factory(ctx) as unknown as FakeHost;
            h.onPrompt = () => h.tools.push({ command: "ls -la", exit: 0, scenario_ms: 7 });
            return h as unknown as SimHost;
        };
        await driver.fault(episode("two_hosts_one_daemon"), at);
        expect(hosts.at(-1)?.tools).toEqual([]);
        const lines = readFileSync(join(armDir, "tools.jsonl"), "utf8").trim().split("\n");
        expect(lines.map((l) => JSON.parse(l))).toEqual([
            { turn: "s-0000-b", command: "ls -la", exit: 0, scenario_ms: 7 },
        ]);
    });

    test("stopping while the daemon restarts waits for the restart, then stops it", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(10);
        let release: () => void = () => undefined;
        daemon.gate = new Promise<void>((r) => {
            release = r;
        });
        driver.daemon = daemon as unknown as DaemonStack;
        const fault = driver.fault(episode("daemon_restart"));
        fault.catch(() => undefined);
        await Bun.sleep(5);
        expect(daemon.restarting).toBe(true);
        let stopped = false;
        const stop = driver.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(20);
        expect([stopped, daemon.stoppedWhileRestarting]).toEqual([false, 0]);
        release();
        await stop;
        await fault;
        expect([daemon.stops, daemon.stoppedWhileRestarting]).toEqual([1, 0]);
    });

    test("stopping while the daemon starts waits for the start, then stops it", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(null);
        let release: () => void = () => undefined;
        daemon.gate = new Promise<void>((r) => {
            release = r;
        });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.daemonFactory = () => daemon as unknown as DaemonStack;
        const reset = driver.reset();
        reset.catch(() => undefined);
        await Bun.sleep(20);
        expect(daemon.starting).toBe(true);
        let stopped = false;
        const stop = driver.stop().then(() => {
            stopped = true;
        });
        await Bun.sleep(20);
        expect([stopped, daemon.stoppedWhileStarting]).toEqual([false, 0]);
        release();
        await stop;
        await reset;
        expect([daemon.stops, daemon.stoppedWhileStarting]).toEqual([1, 0]);
    });

    test("the store checks a daemon restart owes survive a resume through the arm state", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        await driver.fault(episode("daemon_restart"));
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.store_faults).toEqual(["f-daemon_restart"]);
        const plain = fixture("host", { p: gitRepo() });
        await plain.driver.reset();
        const written = JSON.parse(readFileSync(join(plain.armDir, "state.json"), "utf8"));
        writeFileSync(
            join(plain.armDir, "state.json"),
            JSON.stringify({ ...written, store_faults: ["f-daemon_restart"] }),
        );
        const fresh = new HostDriver((plain.driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        expect((fresh as unknown as { storeFaults: string[] }).storeFaults).toEqual([
            "f-daemon_restart",
        ]);
        await fresh.stop();
    });

    test("a second client whose close fails keeps its pid in the arm state", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        await driver.fault(episode("two_hosts_one_daemon"), at);
        const second = hosts.at(-1) as FakeHost;
        second.pid = process.pid;
        second.failClose = true;
        const inner = driver as unknown as Record<string, unknown> & { newHost(): SimHost };
        driver.host = inner.newHost();
        const noop = () => undefined;
        inner.snapshots = { sessionStart: noop, sessionEnd: noop, addTools: noop };
        inner.transcriptsChecked = true;
        await driver.event(at);
        await expect(driver.event(ev("session_end", { project: "p" }))).rejects.toThrow(
            "host survived",
        );
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.second?.pid).toBe(process.pid);
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
        await expect(driver.fault(episode("provider_429"))).rejects.toThrow("no mechanism");
    });
});

describe("probe snapshots", () => {
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
    resumed.sessionEnd("p", repo);
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
