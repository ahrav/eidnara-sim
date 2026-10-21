import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SEGMENTS_DDL } from "../../tests/segments";
import { loadConfig } from "../config/config";
import type { CallView } from "../grade/artefacts";
import { ArtefactReader } from "../grade/artefacts";
import { gradeItem } from "../grade/probes";
import { diffPaths } from "../grade/text";
import { readJsonl } from "../run/journal";
import { sandboxAvailable, writeLauncher } from "../run/launcher";
import { processStart, running } from "../run/procs";
import { HarnessFailure, type ScenarioEvent } from "../run/scheduler";
import { type FaultType, SEAMS } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import type { DaemonStack, HostContext, PromptResult, SimHost } from "./arms";
import { createNoFollow, type DriverOptions, expandTemplate, HostDriver } from "./driver";
import { SnapshotRecorder } from "./snapshot";
import type { StoreCheck } from "./storecheck";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) {
        const mounted = spawnSync("findmnt", ["-l", "-n", "-o", "TARGET", "-R", d], {
            encoding: "utf8",
        });
        const targets = mounted.stdout.trim().split("\n").filter(Boolean).reverse();
        for (const target of targets) spawnSync("sudo", ["-n", "umount", target]);
        if (targets.length > 0) throw new Error(`test left ${targets.join(", ")} mounted`);
        rmSync(d, { recursive: true, force: true });
    }
});
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "sim-driver-"));
    dirs.push(d);
    return d;
};

const BASE_MS = Date.UTC(2031, 0, 1);
const sandbox = sandboxAvailable();
/** The mount tests need a real mount, which some containers deny even with a passwordless sudo. */
const sudo = (() => {
    if (spawnSync("sudo", ["-n", "true"]).status !== 0) return false;
    const probe = mkdtempSync(join(tmpdir(), "sim-mount-probe-"));
    try {
        if (spawnSync("sudo", ["-n", "mount", "--bind", probe, probe]).status !== 0) return false;
        spawnSync("sudo", ["-n", "umount", probe]);
        return true;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

class FakeHost {
    opened: string[] = [];
    connections: (string | null)[] = [];
    closed = 0;
    pid: number | null = null;
    onPrompt: () => void = () => undefined;
    onSpawn: () => void = () => undefined;
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
        this.onSpawn();
    }
    gate: Promise<void> = Promise.resolve();
    opening = false;
    closedWhileOpening = 0;
    failNext = false;
    interrupts: (number | undefined)[] = [];
    deadlines: number[] = [];
    async prompt(_text: string, timeoutMs: number, interruptMs?: number): Promise<PromptResult> {
        this.onPrompt();
        this.interrupts.push(interruptMs);
        this.deadlines.push(timeoutMs);
        if (interruptMs !== undefined) return { interrupted: true };
        if (!this.failNext) return {};
        this.failNext = false;
        return { error: "boom" };
    }
    failClose = false;
    onClose: () => void = () => undefined;
    async closeSession() {
        if (this.opening) this.closedWhileOpening++;
        this.closed++;
        this.onClose();
        if (this.failClose) throw new Error("host survived");
    }
    transcriptEnv() {
        return { PI_CODING_AGENT_DIR: this.transcripts };
    }
    hostPid() {
        return this.pid;
    }
    hostIdentity() {
        return this.pid === null ? null : { pid: this.pid, start: processStart(this.pid) };
    }
    tools: { command: string; exit: number | null; scenario_ms: number }[] = [];
    drainTools() {
        const drained = this.tools.splice(0);
        for (const run of drained) this.ctx.onTool?.(run);
        return drained;
    }
}

/**
 * Fake daemon pids start at Linux's PID_MAX_LIMIT (2^22), which no process can hold, so the
 * reaper's liveness checks and signals for a recorded fake pid find nothing on any machine.
 */
const PID = 4_194_304;

/** The driver sees a fake daemon pid as a live process with a fixed start; real pids read /proc. */
const procStart = (pid: number) => (pid >= PID ? "fake" : processStart(pid));

function fixture(
    arm: DriverOptions["arm"],
    projects: Record<string, string> = {},
    extra: Partial<DriverOptions> = {},
) {
    const root = tmp();
    const transcripts = join(root, arm, "r", "home", "agent");
    const exits: Record<string, unknown>[] = [];
    const hosts: FakeHost[] = [];
    const o: DriverOptions = {
        config: loadConfig(),
        arm,
        host: "pi",
        armRoot: join(root, arm, "r"),
        launcher: sandbox ? writeLauncher(root) : "/bin/false",
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
        baseMs: BASE_MS,
        hostFactory: (ctx) => {
            const h = new FakeHost(ctx, transcripts);
            hosts.push(h);
            return h as unknown as SimHost;
        },
        onDaemonExit: (d) => void exits.push(d),
        procStart,
        ...extra,
    };
    const driver = new HostDriver(o);
    return { driver, root, transcripts, exits, hosts, armDir: join(root, arm) };
}

function fakeDaemon(pid: number | null) {
    const d = {
        current: pid,
        pid: () => d.current,
        crash: async () => undefined,
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
            d.current = d.current ?? PID + 10;
        },
    };
    return d;
}

const PASS =
    "[2026-10-16T12:00:00.000Z] [eidnara][s-1] rust pass: decision=SOFT+ reason=none served_from=transform in=3 out=3";
function statSize(driver: HostDriver): number {
    const path = join((driver as unknown as { o: DriverOptions }).o.armRoot, "eidnara.log");
    return existsSync(path) ? statSync(path).size : 0;
}

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

    test.skipIf(!sandbox)(
        "apply_diff commits only its own path and tolerates unchanged content",
        async () => {
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
        },
    );

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

    test("apply_diff refuses a commondir redirect and ignores replacement refs", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const other = tmp();
        writeFileSync(join(ws, ".git", "commondir"), `${other}\n`);
        await expect(
            driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
        ).rejects.toThrow("commondir");
        rmSync(join(ws, ".git", "commondir"));
        const g = (...args: string[]) =>
            spawnSync("git", args, { cwd: ws, encoding: "utf8" }).stdout.trim();
        const head = g("rev-parse", "HEAD");
        const emptyTree = g("hash-object", "-t", "tree", "/dev/null");
        const replacement = spawnSync("git", ["commit-tree", emptyTree, "-m", "replacement"], {
            cwd: ws,
            encoding: "utf8",
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@t",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@t",
            },
        }).stdout.trim();
        g("update-ref", `refs/replace/${head}`, replacement);
        await driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" }));
        const files = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
            cwd: ws,
            encoding: "utf8",
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
        })
            .stdout.trim()
            .split("\n")
            .sort();
        expect(files).toEqual(["README", "src/a.txt"]);
    });

    test("apply_diff refuses a target that is a FIFO or directory before writing", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        mkdirSync(join(ws, "src"));
        spawnSync("mkfifo", [join(ws, "src", "a.txt")]);
        const started = Date.now();
        await expect(
            driver.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
        ).rejects.toThrow("not a regular file");
        expect(Date.now() - started).toBeLessThan(2_000);
        mkdirSync(join(ws, "src", "b.txt"));
        await expect(
            driver.event(ev("apply_diff", { path: "src/b.txt", content: "B" })),
        ).rejects.toThrow("not a regular file");
    });

    test("apply_diff bounds its walk of the workspace .git by entry count", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        const o = { ...(driver as unknown as { o: DriverOptions }).o, gitDirEntryCap: 50 };
        const bounded = new HostDriver(o);
        await bounded.reset();
        const ws = bounded.workspace("p");
        for (let i = 0; i < 60; i++) writeFileSync(join(ws, ".git", `junk-${i}`), "");
        await expect(
            bounded.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
        ).rejects.toThrow("walk: too many entries or timed out");
    });

    test("apply_diff removes the real index lock when its update times out", async () => {
        const shim = tmp();
        const real = spawnSync("sh", ["-c", "command -v git"]).stdout.toString().trim();
        writeFileSync(
            join(shim, "git"),
            `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "update-index" ] && [ -z "$GIT_INDEX_FILE" ]; then touch "$GIT_DIR/index.lock"; sleep 30; fi; done\nexec ${real} "$@"\n`,
            { mode: 0o755 },
        );
        const { driver } = fixture("host", { p: gitRepo() });
        const o = { ...(driver as unknown as { o: DriverOptions }).o, turnDeadlineMs: 500 };
        const fresh = new HostDriver(o);
        await fresh.reset();
        const ws = fresh.workspace("p");
        const path = process.env.PATH;
        process.env.PATH = `${shim}:${path}`;
        try {
            await expect(
                fresh.event(ev("apply_diff", { path: "src/a.txt", content: "A" })),
            ).rejects.toThrow("timed out");
        } finally {
            process.env.PATH = path;
        }
        expect(existsSync(join(ws, ".git", "index.lock"))).toBe(false);
        await fresh.event(ev("apply_diff", { path: "src/a.txt", content: "A" }));
        expect(spawnSync("git", ["show", "HEAD:src/a.txt"], { cwd: ws }).stdout.toString()).toBe(
            "A",
        );
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

    test("the host pid is on record before the session's start tree is taken", async () => {
        const { driver, armDir, hosts } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const host = hosts.at(-1) as FakeHost;
        host.pid = process.pid;
        const recorder = (driver as unknown as { snapshots: SnapshotRecorder }).snapshots;
        const original = recorder.sessionStart.bind(recorder);
        let seen: unknown = null;
        recorder.sessionStart = (...a) => {
            seen = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).host;
            return original(...a);
        };
        await driver.event(ev("session_start", { id: "e-0", session: "s-0" }));
        expect(seen).toMatchObject({ pid: process.pid });
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
        const recycled = Bun.spawn(["sleep", "300"]);
        state.daemon = { pid: recycled.pid, start: "1" };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
        expect(fresh.host?.ctx.model).toBe("model-b");
        expect(recycled.exitCode).toBeNull();
        expect(recycled.signalCode).toBeNull();
        recycled.kill();
    });

    test("a reset after an open session starts between sessions, with the transcript check pending", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        mkdirSync(join(driver.workspace("p"), "..", "..", "agent", "sessions"), {
            recursive: true,
        });
        await driver.event(ev("session_start"));
        await driver.reset();
        expect(await driver.fault(episode("model_switch"))).toEqual({ model: "model-b" });
        expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).host).toBeNull();
    });

    test("transcripts.json is replaced whole, with no staged sibling left behind", async () => {
        const { driver, armDir, transcripts } = fixture("host");
        await driver.reset();
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        await driver.event(ev("session_end"));
        const files = readdirSync(armDir).filter((f) => f.startsWith("transcripts.json"));
        expect(files).toEqual(["transcripts.json"]);
    });

    test("stop still stops the daemon when the host refuses to close", async () => {
        const { driver } = fixture("eidnara");
        const host = new FakeHost({} as HostContext, "/x");
        host.failClose = true;
        let stopped = 0;
        driver.host = host as unknown as SimHost;
        driver.daemon = {
            ...fakeDaemon(PID + 10),
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

    test("a turn's remaining deadline bounds the host prompt under the pre-registered one", async () => {
        const { driver } = fixture("host");
        const host = new FakeHost({} as HostContext, "/x");
        driver.host = host as unknown as SimHost;
        // The wall clock stands still, so the work before each prompt spends none of its
        // deadline and every bound the host sees is exact; the probe-snapshot test below spends
        // real time against a deadline.
        setSystemTime(new Date());
        let spent: Awaited<ReturnType<HostDriver["event"]>>;
        try {
            await driver.event(ev("user_turn", { id: "e-1", text: "go", deadline_ms: 400 }));
            await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
            await driver.event(ev("user_turn", { id: "e-3", text: "go", deadline_ms: 5_000 }));
            await driver.event(ev("user_turn", { id: "e-4", text: "go", deadline_ms: 30 }));
            spent = await driver.event(ev("user_turn", { id: "e-5", text: "go", deadline_ms: 0 }));
        } finally {
            setSystemTime();
        }
        expect(host.deadlines).toEqual([400, 1_000, 1_000, 30]);
        expect(spent.failed).toContain("turn deadline");
        expect(spent.undelivered).toBe(true);
    });

    test("a probe's pre-turn snapshot spends the turn's shared deadline", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const host = new FakeHost({} as HostContext, "/x");
        driver.host = host as unknown as SimHost;
        const snapshots = (driver as unknown as { snapshots: { tree: (d: string) => string } })
            .snapshots;
        const tree = snapshots.tree.bind(snapshots);
        snapshots.tree = (d: string) => {
            const until = Date.now() + 300;
            while (Date.now() < until) {}
            return tree(d);
        };
        await driver.event(ev("session_start", { session: "s-0" }));
        await driver.event(
            ev("user_turn", {
                id: "e-8",
                session: "s-0",
                text: "go",
                probe: "q-1",
                deadline_ms: 900,
            }),
        );
        expect(host.deadlines[0]).toBeLessThan(700);
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
        const daemon = fakeDaemon(PID + 10);
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

    test("a daemon gone while a probe turn settles and snapshots is reported with that turn", async () => {
        const { driver, exits } = fixture("host", { p: gitRepo() });
        const daemon = fakeDaemon(PID + 10);
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.settle = async () => {
            daemon.current = null;
        };
        const fresh = new HostDriver(o);
        await fresh.reset();
        fresh.daemon = daemon as unknown as DaemonStack;
        await fresh.event(ev("session_start", { session: "s-0" }));
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-8", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(exits).toEqual([{ after: "e-8" }]);
        expect(outcome.snapshot).toBe("host:q-1:e-8");
    });

    test.skipIf(!sandbox)(
        "apply_diff commits carry the scenario instant, so paired arms get one hash",
        async () => {
            const { driver } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const ws = driver.workspace("p");
            await driver.event(
                ev("apply_diff", { path: "a.txt", content: "A", scenario_ms: 90_000 }),
            );
            const dates = spawnSync("git", ["log", "-1", "--format=%at %ct"], { cwd: ws });
            const at = String(Math.floor((BASE_MS + 90_000) / 1000));
            expect(dates.stdout.toString().trim()).toBe(`${at} ${at}`);
        },
    );

    test.skipIf(!sandbox)(
        "apply_diff rejects an escaping path before creating any directory",
        async () => {
            const { driver, root } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const ws = driver.workspace("p");
            const outside = tmp();
            symlinkSync(outside, join(ws, "link"));
            const viaLink = ev("apply_diff", { path: "link/new/x", content: "A" });
            await expect(driver.event(viaLink)).rejects.toThrow("leaves");
            expect(existsSync(join(outside, "new"))).toBe(false);
            const up = ev("apply_diff", { path: "../made/x", content: "A" });
            await expect(driver.event(up)).rejects.toThrow("leaves");
            expect(existsSync(join(root, "host/r/workspaces/made"))).toBe(false);
        },
    );

    test("apply_diff refuses a workspace whose directory the host replaced with a symlink", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const elsewhere = gitRepo();
        rmSync(ws, { recursive: true, force: true });
        symlinkSync(elsewhere, ws);
        const diff = ev("apply_diff", { path: "planted.txt", content: "A" });
        await expect(driver.event(diff)).rejects.toThrow(/leaves|symlink/);
        expect(existsSync(join(elsewhere, "planted.txt"))).toBe(false);
    });

    test("a session_start refuses a workspace the host replaced with a symlink", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        rmSync(ws, { recursive: true, force: true });
        symlinkSync(gitRepo(), ws);
        await expect(driver.event(ev("session_start"))).rejects.toThrow("leaves");
        expect(hosts.at(-1)?.opened).toEqual([]);
    });

    test.skipIf(!sandbox)(
        "apply_diff replaces a hard-linked target instead of writing through it",
        async () => {
            const { driver } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const shared = join(tmp(), "shared");
            writeFileSync(shared, "theirs");
            linkSync(shared, join(driver.workspace("p"), "x"));
            await driver.event(ev("apply_diff", { path: "x", content: "mine" }));
            expect(readFileSync(shared, "utf8")).toBe("theirs");
            expect(readFileSync(join(driver.workspace("p"), "x"), "utf8")).toBe("mine");
        },
    );

    test.skipIf(!sandbox)(
        "a hook the agent planted runs inside the sandbox, so it cannot reach the host",
        async () => {
            const { driver, root } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const ws = driver.workspace("p");
            const escaped = join(root, "escaped");
            writeFileSync(
                join(ws, ".git/hooks/post-commit"),
                `#!/bin/sh
touch ${escaped}
`,
                {
                    mode: 0o755,
                },
            );
            await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
            const log = spawnSync("git", ["log", "--format=%s", "-1"], {
                cwd: ws,
                encoding: "utf8",
            });
            expect(log.stdout.trim()).toBe("Add a.txt");
            expect(existsSync(escaped)).toBe(false);
        },
    );

    test("a daemon gone by session_end is reported with the session_end id", async () => {
        const { driver, exits, transcripts } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
        const host = new FakeHost({} as HostContext, transcripts);
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        host.onClose = () => {
            daemon.current = null;
        };
        driver.host = host as unknown as SimHost;
        driver.daemon = daemon as unknown as DaemonStack;
        await driver.event(ev("session_end", { id: "e-9" }));
        expect(exits).toEqual([{ after: "e-9" }]);
    });

    test.skipIf(!sudo)(
        "a daemon restart refuses a runtime directory the host replaced with a symlink",
        async () => {
            const daemonFactory = () =>
                ({
                    ...fakeDaemon(PID + 10),
                    start: async () => undefined,
                }) as unknown as DaemonStack;
            const { driver, root } = fixture("eidnara", {}, { daemonFactory });
            try {
                await driver.reset();
                const runtime = join(root, "eidnara", "runtime");
                rmSync(runtime, { recursive: true, force: true });
                symlinkSync(tmp(), runtime);
                await expect(driver.fault(episode("daemon_restart"))).rejects.toThrow("leaves");
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "the daemon's data directory is a mount point the host cannot rename",
        async () => {
            const daemonFactory = () =>
                ({ ...fakeDaemon(null), start: async () => undefined }) as unknown as DaemonStack;
            const { driver } = fixture("eidnara", {}, { daemonFactory });
            try {
                await driver.reset();
                expect(spawnSync("findmnt", ["-n", "-M", driver.dataDir]).status).toBe(0);
                const moved = spawnSync(
                    "mv",
                    [driver.dataDir, join(driver.storeRoot, "elsewhere")],
                    {
                        encoding: "utf8",
                    },
                );
                expect(moved.status).not.toBe(0);
            } finally {
                await driver.stop().catch(() => undefined);
            }
            expect(spawnSync("findmnt", ["-n", "-M", driver.dataDir]).status).not.toBe(0);
        },
    );

    test.skipIf(!sudo)(
        "a resume refuses a daemon runtime or data directory the host replaced with a symlink",
        async () => {
            const daemonFactory = () =>
                ({ ...fakeDaemon(null), start: async () => undefined }) as unknown as DaemonStack;
            const { driver, root } = fixture("eidnara", {}, { daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                await driver.stop();
                const runtime = join(root, "eidnara", "runtime");
                rmSync(runtime, { recursive: true, force: true });
                symlinkSync(tmp(), runtime);
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await expect(fresh.resume(null)).rejects.toThrow("leaves");
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sandbox)(
        "apply_diff refuses a staged sibling the host planted as a symlink",
        async () => {
            const { driver } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const elsewhere = join(tmp(), "victim");
            writeFileSync(elsewhere, "theirs");
            symlinkSync(elsewhere, join(driver.workspace("p"), `x.${process.pid}`));
            await driver.event(ev("apply_diff", { path: "x", content: "mine" }));
            expect(readFileSync(elsewhere, "utf8")).toBe("theirs");
            expect(readFileSync(join(driver.workspace("p"), "x"), "utf8")).toBe("mine");
        },
    );

    test("finish on a fresh harness reaps what the killed one recorded", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.stop();
        const orphan = Bun.spawn(["sleep", "300"]);
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        const start = readFileSync(`/proc/${orphan.pid}/stat`, "utf8")
            .split(") ")[1]
            ?.split(" ")[19];
        state.host = { pid: orphan.pid, start };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reap();
        await fresh.finish();
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
    });

    test("reset clears the logs of an abandoned attempt", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        mkdirSync(armDir, { recursive: true });
        writeFileSync(join(armDir, "daemon.log"), "from the attempt before\n");
        writeFileSync(join(armDir, "transcripts.json"), "{}");
        await driver.reset();
        expect(existsSync(join(armDir, "daemon.log"))).toBe(false);
        expect(existsSync(join(armDir, "transcripts.json"))).toBe(false);
    });

    test("a resume refuses to retry a transcript-store check that already recorded a gap", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const record = { checked_after: "first session_end", paths: ["/x"], missing: ["/x"] };
        writeFileSync(join(armDir, "transcripts.json"), JSON.stringify(record));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.resume(null)).rejects.toThrow("transcript store missing");
    });

    test("reap on an arm with no recorded state stops, since it cannot know what to stop", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        rmSync(join(armDir, "state.json"));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.reap()).rejects.toThrow("state.json");
    });

    test.skipIf(!sudo)(
        "a resumed daemon keeps the arm's first model after a model switch",
        async () => {
            const models: string[] = [];
            const daemonFactory = (ctx: { model: string }) =>
                ({
                    ...fakeDaemon(null),
                    start: async () => void models.push(ctx.model),
                }) as unknown as DaemonStack;
            const { driver } = fixture("eidnara", {}, { daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                await driver.fault(episode("model_switch"));
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await fresh.resume(null);
                expect(models).toEqual(["model-a", "model-a"]);
                expect(fresh.host?.ctx.model).toBe("model-b");
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sandbox)("a failed git run leaves a symlinked .git's target alone", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const elsewhere = join(tmp(), "victim.git");
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, "index.lock"), "");
        rmSync(join(ws, ".git"), { recursive: true, force: true });
        symlinkSync(elsewhere, join(ws, ".git"));
        await expect(
            driver.event(ev("apply_diff", { path: "a.txt", content: "A" })),
        ).rejects.toThrow();
        expect(existsSync(join(elsewhere, "index.lock"))).toBe(true);
    });

    test.skipIf(!sudo)(
        "reset reaps the recorded daemon before it unmounts the data directory it holds busy",
        async () => {
            const daemonFactory = () =>
                ({ ...fakeDaemon(null), start: async () => undefined }) as unknown as DaemonStack;
            const { driver, armDir } = fixture("eidnara", {}, { daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                const squatter = Bun.spawn(["sleep", "300"], { cwd: driver.dataDir });
                const start = readFileSync(`/proc/${squatter.pid}/stat`, "utf8")
                    .split(") ")[1]
                    ?.split(" ")[19];
                const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
                state.daemon = { pid: squatter.pid, start };
                writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await fresh.reset();
                await squatter.exited;
                expect(squatter.signalCode).toBe("SIGTERM");
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test("a host that survives its close keeps its recorded identity for the next reap", async () => {
        const { driver, hosts, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const host = hosts.at(-1) as FakeHost;
        host.pid = process.pid;
        await driver.event(ev("session_start"));
        host.failClose = true;
        await expect(driver.finish()).rejects.toThrow("host survived");
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.host).toMatchObject({ pid: process.pid });
        expect(state.failed).toContain("host survived");
    });

    test.skipIf(!sudo)(
        "a link the host left at the arm root's runtime name does not block a restart",
        async () => {
            const daemonFactory = () =>
                ({
                    ...fakeDaemon(PID + 10),
                    start: async () => undefined,
                }) as unknown as DaemonStack;
            const { driver, root } = fixture("eidnara", {}, { daemonFactory });
            try {
                await driver.reset();
                symlinkSync(tmp(), join(root, "eidnara", "r", "runtime"));
                expect(await driver.fault(episode("daemon_restart"))).toMatchObject({
                    restarted_by: "harness",
                });
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)("a second reset of a loop-store arm succeeds", async () => {
        const daemonFactory = (ctx: { dataDir: string }) =>
            ({
                ...fakeDaemon(null),
                start: async () => void mkdirSync(ctx.dataDir, { recursive: true }),
            }) as unknown as DaemonStack;
        const { driver } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
        try {
            await driver.reset();
            await driver.reset();
            expect(spawnSync("findmnt", ["-n", "-M", driver.storeRoot]).status).toBe(0);
        } finally {
            await driver.stop().catch(() => undefined);
        }
    });

    test("a finish on a fresh driver keeps the identities the killed harness recorded", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.stop();
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        state.host = { pid: 4_000_000, start: "1" };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        fresh.daemon = {
            ...fakeDaemon(null),
            stop: async () => {
                throw new Error("umount: target is busy");
            },
        } as unknown as DaemonStack;
        await expect(fresh.finish()).rejects.toThrow("busy");
        const after = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(after.host).toEqual({ pid: 4_000_000, start: "1" });
        expect(after.failed).toContain("busy");
    });

    test("a transcript store reached through a linked ancestor counts as missing", async () => {
        const { driver, transcripts } = fixture("host");
        await driver.reset();
        const elsewhere = tmp();
        mkdirSync(join(elsewhere, "sessions"));
        mkdirSync(join(transcripts, ".."), { recursive: true });
        rmSync(transcripts, { recursive: true, force: true });
        symlinkSync(elsewhere, transcripts);
        await expect(driver.event(ev("session_end"))).rejects.toThrow("transcript store missing");
    });

    test("the state records the daemon identity captured at its start", async () => {
        const starts = new Map<number, string>();
        const procStart = (pid: number) => starts.get(pid) ?? processStart(pid);
        const { driver, armDir } = fixture("eidnara", {}, { procStart });
        starts.set(PID + 10, "first");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        const inner = driver as unknown as { noteDaemon(): void; recordState(): void };
        inner.noteDaemon();
        starts.set(PID + 10, "reused");
        inner.recordState();
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.daemon).toEqual({ pid: PID + 10, start: "first" });
    });

    test("a model switch the journal lost is rolled back on resume", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.fault(episode("model_switch"));
        expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).model).toBe(1);
        await driver.stop();
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null, ["f-model_switch"]);
        expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).model).toBe(0);
        await fresh.event(ev("session_start"));
        expect(fresh.host?.ctx.model).toBe("model-a");
        await fresh.stop();
    });

    test("a daemon gone when the session cannot open is reported before the failure surfaces", async () => {
        const { driver, exits, transcripts } = fixture("eidnara");
        const gone = spawnSync("true").pid as number;
        const host = new FakeHost({} as HostContext, transcripts);
        host.onSpawn = () => {
            throw new Error("readiness failed");
        };
        driver.host = host as unknown as SimHost;
        driver.daemon = fakeDaemon(gone) as unknown as DaemonStack;
        await expect(driver.event(ev("session_start", { id: "e-3" }))).rejects.toThrow(
            "readiness failed",
        );
        expect(exits).toEqual([{ after: "e-3" }]);
    });

    test("a daemon gone when the host's prompt rejects is reported before the rejection surfaces", async () => {
        const { driver, exits, transcripts } = fixture("eidnara");
        const gone = spawnSync("true").pid as number;
        const host = new FakeHost({} as HostContext, transcripts);
        host.onPrompt = () => {
            throw new Error("connection lost");
        };
        driver.host = host as unknown as SimHost;
        driver.daemon = fakeDaemon(gone) as unknown as DaemonStack;
        await expect(driver.event(ev("user_turn", { id: "e-7", text: "hi" }))).rejects.toThrow(
            "connection lost",
        );
        expect(exits).toEqual([{ after: "e-7" }]);
    });

    test.skipIf(!sandbox)(
        "a timeout planted in the workspace is never the one that runs git",
        async () => {
            const { driver } = fixture("host", { p: gitRepo() });
            const path = process.env.PATH;
            try {
                await driver.reset();
                const ws = driver.workspace("p");
                writeFileSync(join(ws, "timeout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
                process.env.PATH = `.:${path}`;
                await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
                const log = spawnSync("git", ["-C", ws, "log", "--oneline"], { encoding: "utf8" });
                expect(log.stdout.trim().split("\n")).toHaveLength(2);
            } finally {
                process.env.PATH = path;
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test("a daemon whose process has exited is reported with the event id", async () => {
        const { driver, exits, transcripts } = fixture("eidnara");
        const gone = spawnSync("true").pid as number;
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
        driver.daemon = fakeDaemon(gone) as unknown as DaemonStack;
        await driver.event(ev("session_end", { id: "e-9" }));
        expect(exits).toEqual([{ after: "e-9" }]);
    });

    test.skipIf(!sandbox)("a hook cannot reach the daemon store", async () => {
        const daemonFactory = () =>
            ({ ...fakeDaemon(null), start: async () => undefined }) as unknown as DaemonStack;
        const { driver } = fixture("eidnara", { p: gitRepo() }, { daemonFactory });
        try {
            await driver.reset();
            const ws = driver.workspace("p");
            writeFileSync(
                join(ws, ".git/hooks/post-commit"),
                `#!/bin/sh\ntouch ${driver.storeRoot}/planted\n`,
                {
                    mode: 0o755,
                },
            );
            await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
            expect(existsSync(join(driver.storeRoot, "planted"))).toBe(false);
        } finally {
            await driver.stop().catch(() => undefined);
        }
    });

    test("a finish that fails is recorded, so a resume cannot heal the arm", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = {
            ...fakeDaemon(null),
            stop: async () => {
                throw new Error("daemon outlived SIGTERM");
            },
        } as unknown as DaemonStack;
        await expect(driver.finish()).rejects.toThrow("outlived");
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.failed).toContain("outlived");
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.reap()).rejects.toThrow("outlived");
    });

    test("reset's clone ignores ambient GIT_* variables", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        process.env.GIT_DIR = join(tmp(), "ambient.git");
        try {
            await driver.reset();
            expect(existsSync(join(driver.workspace("p"), ".git", "HEAD"))).toBe(true);
            expect(readFileSync(join(driver.workspace("p"), "README"), "utf8")).toBe("hi\n");
        } finally {
            delete process.env.GIT_DIR;
        }
    });

    test("reset starts the fresh arm with no fault or git state carried over", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        const inner = driver as unknown as {
            ballastShape: unknown;
            refilling: boolean;
            gitRun: unknown;
        };
        inner.ballastShape = { bytes: 1, blocks: 1 };
        inner.refilling = true;
        inner.gitRun = { pid: 1, start: "1", project: "p" };
        await driver.reset();
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state).toMatchObject({ ballast: null, refilling: false, git: null });
    });

    test("the driver refuses the fault types it has no mechanism for, before any run starts", () => {
        const { driver } = fixture("host");
        const unknown = { ...episode("model_switch"), type: "bogus_fault" as FaultType };
        expect(driver.supports(unknown)).toBe(false);
        expect(driver.supports(episode("host_upgrade"))).toBe(true);
        expect(driver.supports(episode("two_hosts_one_daemon"))).toBe(true);
        expect(driver.supports(episode("model_switch"))).toBe(true);
        expect(driver.supports(episode("laptop_sleep"))).toBe(true);
        expect(driver.supports(episode("provider_429"))).toBe(true);
        expect(driver.supports(episode("slow_stream"))).toBe(true);
    });

    test.skipIf(!sandbox)("a filter cannot write into a configured toolchain path", async () => {
        const tools = mkdtempSync("/var/tmp/sim-tools-");
        dirs.push(tools);
        const { driver } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.config = { ...o.config, toolchain: { ...o.config.toolchain, keep: [tools] } };
        await driver.reset();
        const ws = driver.workspace("p");
        writeFileSync(join(ws, ".gitattributes"), "* filter=poison\n");
        spawnSync(
            "git",
            ["config", "filter.poison.clean", `sh -c 'touch ${tools}/poisoned; cat'`],
            {
                cwd: ws,
            },
        );
        await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
        expect(existsSync(join(tools, "poisoned"))).toBe(false);
    });

    test("an apply_diff inside an open session is refused, since a host would be running", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.event(ev("session_start"));
        const diff = ev("apply_diff", { path: "a.txt", content: "A" });
        await expect(driver.event(diff)).rejects.toThrow("between sessions");
    });

    test("the reaper stops a daemon the killed harness started against this arm's store", async () => {
        const { driver } = fixture("eidnara");
        const orphan = Bun.spawn([
            "sh",
            "-c",
            "sleep 300; true",
            "sh",
            "--state-root",
            driver.dataDir,
        ]);
        await Bun.sleep(100);
        const sleeper = Number(
            spawnSync("pgrep", ["-P", String(orphan.pid)], { encoding: "utf8" }).stdout.trim(),
        );
        expect(sleeper).toBeGreaterThan(0);
        mkdirSync(join(driver.storeRoot, ".."), { recursive: true });
        writeFileSync(
            join(driver.storeRoot, "..", "state.json"),
            JSON.stringify({
                model: 0,
                daemon: null,
                host: null,
                ballast: null,
                refilling: false,
                git: null,
                failed: null,
            }),
        );
        await driver.reap();
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
        expect(running(sleeper)).toBe(false);
    });

    test("the reaper stops the OpenCode launch the wrapper recorded before the server answered", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.stop();
        const orphan = Bun.spawn(["sleep", "300"]);
        const start = readFileSync(`/proc/${orphan.pid}/stat`, "utf8")
            .split(") ")[1]
            ?.split(" ")[19];
        writeFileSync(join(armDir, "opencode.launch"), `${orphan.pid} ${start}\n`);
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reap();
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
    });

    test.skipIf(!sandbox)("a hook cannot write into the Pi install", async () => {
        const install = mkdtempSync("/var/tmp/sim-pi-install-");
        dirs.push(install);
        const { driver } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.config = { ...o.config, pi_install: install };
        await driver.reset();
        const ws = driver.workspace("p");
        writeFileSync(join(ws, ".git/hooks/post-commit"), `#!/bin/sh\ntouch ${install}/planted\n`, {
            mode: 0o755,
        });
        await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
        expect(existsSync(join(install, "planted"))).toBe(false);
    });

    test("apply_diff refuses a workspace whose .git is a link to another repository", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        const other = gitRepo();
        rmSync(join(ws, ".git"), { recursive: true, force: true });
        symlinkSync(join(other, ".git"), join(ws, ".git"));
        await expect(
            driver.event(ev("apply_diff", { path: "a.txt", content: "A" })),
        ).rejects.toThrow(/\.git/);
        const log = spawnSync("git", ["log", "--format=%s", "-1"], {
            cwd: other,
            encoding: "utf8",
        });
        expect(log.stdout.trim()).toBe("init");
    });

    test("a transcript store of the wrong kind counts as missing", async () => {
        const { driver, transcripts } = fixture("host");
        await driver.reset();
        mkdirSync(transcripts, { recursive: true });
        writeFileSync(join(transcripts, "sessions"), "a file where the directory should be");
        await expect(driver.event(ev("session_end"))).rejects.toThrow("transcript store missing");
    });

    test("a transcript store left as a link counts as missing", async () => {
        const { driver, transcripts } = fixture("host");
        await driver.reset();
        mkdirSync(transcripts, { recursive: true });
        symlinkSync(tmp(), join(transcripts, "sessions"));
        await expect(driver.event(ev("session_end"))).rejects.toThrow("transcript store missing");
    });

    test("a recorded finish failure still reaps what the state names before it stops the resume", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        await driver.stop();
        const orphan = Bun.spawn(["sleep", "300"]);
        const start = readFileSync(`/proc/${orphan.pid}/stat`, "utf8")
            .split(") ")[1]
            ?.split(" ")[19];
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        state.host = { pid: orphan.pid, start };
        state.failed = "umount: target is busy";
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.reap()).rejects.toThrow("target is busy");
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
    });

    test.skipIf(!sandbox)("a hook cannot write into the configured checkout", async () => {
        const checkout = mkdtempSync("/var/tmp/sim-checkout-");
        dirs.push(checkout);
        const { driver } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.config = { ...o.config, eidnara_checkout: checkout };
        await driver.reset();
        const ws = driver.workspace("p");
        writeFileSync(
            join(ws, ".git/hooks/post-commit"),
            `#!/bin/sh\ntouch ${checkout}/planted\n`,
            {
                mode: 0o755,
            },
        );
        await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
        expect(existsSync(join(checkout, "planted"))).toBe(false);
    });

    test("a resume with state.json gone stops instead of guessing the arm's state", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        rmSync(join(armDir, "state.json"));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.resume(null)).rejects.toThrow("state.json");
    });

    test("the host pid is recorded as soon as the host spawns", async () => {
        const { driver, hosts, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const host = hosts.at(-1) as FakeHost;
        let recorded: unknown = null;
        host.onSpawn = () => {
            host.pid = process.pid;
            host.ctx.onSpawn?.();
            recorded = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).host;
            throw new Error("killed while the host came up");
        };
        await expect(driver.event(ev("session_start"))).rejects.toThrow("came up");
        expect(recorded).toMatchObject({ pid: process.pid });
    });

    test("state.json is replaced whole, with no staged sibling left behind", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const files = readdirSync(armDir);
        expect(files.filter((f) => f.startsWith("state.json"))).toEqual(["state.json"]);
        expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).model).toBe(0);
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

    test.skipIf(!sudo)(
        "store_full fills the loop store and leaves its image sparse once the ballast goes",
        async () => {
            const { driver, armDir } = fixture("eidnara");
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            const inner = driver as unknown as {
                mountStore(f: boolean): void;
                clearStoreFill(): void;
            };
            inner.mountStore(true);
            try {
                expect(await driver.fault(episode("store_full"))).toMatchObject({ avail_kb: 0 });
                inner.clearStoreFill();
                const du = spawnSync("du", ["-m", join(armDir, "store.img")], { encoding: "utf8" });
                expect(Number(du.stdout.split("\t")[0])).toBeLessThan(200);
            } finally {
                await driver.stop();
            }
        },
    );

    test("store_full without a loop-mounted store is skipped for the missing store", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        expect(await driver.fault(episode("store_full"))).toEqual({
            skipped: "arm runs no loop-mounted store",
        });
    });

    test("a daemon fault samples the outgoing daemon, restarts through the stack, reports both pids, and samples the new one", async () => {
        const { driver } = fixture("eidnara");
        const seen: number[] = [];
        (driver as unknown as { o: DriverOptions }).o.sampleDaemon = () =>
            void seen.push(driver.daemonPid() ?? -1);
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        expect(await driver.fault(episode("daemon_restart"))).toEqual({
            signal: "SIGKILL",
            pid_before: PID + 10,
            pid_after: PID + 11,
            restarted_by: "harness",
            store: { format: 2, integrity: "missing", segments: 0, overlaps: [], ranges: [] },
        });
        expect(seen).toEqual([PID + 10, PID + 11]);
    });

    test("the store a daemon kill leaves is inspected before the replacement starts", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
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
            daemon.current = PID + 11;
        };
        driver.daemon = daemon as unknown as DaemonStack;
        const evidence = await driver.fault(episode("daemon_sigkill_mid_fold"));
        expect(phases).toEqual([`crash:${PID + 10}`, "start"]);
        expect(evidence.pid_after).toBe(PID + 11);
        expect((evidence.store as StoreCheck).ranges.map((r) => r.slice(0, 4))).toEqual([
            ["s", 1, 0, 9],
        ]);
    });

    test("a mid-fold kill's turn carries the store check once the replacement served a pass", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
        daemon.restart = async () => {
            await Bun.sleep(100);
            daemon.current = PID + 11;
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
        expect((await kill).pid_after).toBe(PID + 11);
    });

    test("a restart that fails during the interrupted turn fails that turn", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
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
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        await driver.fault(episode("daemon_restart"));
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(Object.keys(state.store_faults)).toEqual(["f-daemon_restart"]);
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        fresh.daemon = fakeDaemon(PID + 12) as unknown as DaemonStack;
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
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        await driver.fault(episode("daemon_sigkill_mid_fold"));
        pluginLog(driver, PASS);
        const first = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        const second = await driver.event(ev("user_turn", { id: "e-2", text: "go" }));
        const store = { format: 2, integrity: "missing", segments: 0, overlaps: [], ranges: [] };
        expect(first.stores).toEqual([
            { fault: "f-daemon_restart", store },
            { fault: "f-daemon_sigkill_mid_fold", store },
        ]);
        expect(second.stores).toBeUndefined();
    });

    test("a plugin log the agent replaced with a link is refused, not read through", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        const forged = join(tmp(), "forged.log");
        writeFileSync(forged, `${PASS}\n`);
        const path = join((driver as unknown as { o: DriverOptions }).o.armRoot, "eidnara.log");
        mkdirSync(dirname(path), { recursive: true });
        rmSync(path, { force: true });
        symlinkSync(forged, path);
        await expect(driver.event(ev("user_turn", { id: "e-1", text: "go" }))).rejects.toThrow(
            /plugin log .* is a symlink/,
        );
    });

    test("a pass the replacement serves while its start is still settling counts", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
        daemon.restart = async () => {
            daemon.current = PID + 11;
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
        await driver.reset();
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        await driver.fault(episode("daemon_restart"));
        await driver.event(ev("session_start"));
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
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        pluginLog(driver, PASS);
        const second = await driver.fault(episode("daemon_sigkill_mid_fold"));
        expect((second.stores as { fault: string }[]).map((s) => s.fault)).toEqual([
            "f-daemon_restart",
        ]);
        // The settled check stays recorded until the next event, after the scheduler journaled it.
        const recorded = () =>
            Object.keys(
                JSON.parse(readFileSync(join(driver.armDir, "state.json"), "utf8")).store_faults,
            );
        expect(recorded().sort()).toEqual(["f-daemon_restart", "f-daemon_sigkill_mid_fold"]);
        const turn = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(turn.stores).toBeUndefined();
        expect(recorded()).toEqual(["f-daemon_sigkill_mid_fold"]);
    });

    test("a pass served between turns is checked before the next turn's own passes", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        const host = new FakeHost({} as HostContext, "/x");
        driver.host = host as unknown as SimHost;
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        const db = new Database(driver.storeDb);
        db.run(SEGMENTS_DDL);
        db.run(
            "insert into history_segments (session_id, sequence, start_message, end_message) values ('s', 1, 0, 9)",
        );
        db.close();
        await driver.fault(episode("daemon_restart"));
        pluginLog(driver, PASS);
        // The next turn's own pass compacts the store; the check must predate it.
        host.onPrompt = () => new Database(driver.storeDb).run("delete from history_segments");
        const outcome = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(outcome.stores?.map((s) => [s.fault, s.store.segments])).toEqual([
            ["f-daemon_restart", 1],
        ]);
    });

    test("a probe turn checks the store after its background jobs settle", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.settle = async () => pluginLog(driver, PASS);
        await driver.reset();
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        hosts.at(-1);
        await driver.fault(episode("daemon_restart"));
        await driver.event(ev("session_start", { session: "s-0" }));
        const outcome = await driver.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
    });

    test("a fault whose id is an object prototype key still owes and settles its check", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault({ ...episode("daemon_restart"), id: "__proto__" });
        const state = JSON.parse(readFileSync(join(driver.armDir, "state.json"), "utf8"));
        expect(Object.keys(state.store_faults)).toEqual(["__proto__"]);
        pluginLog(driver, PASS);
        const outcome = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["__proto__"]);
    });

    test("a served pass is found past a long plugin log and across a chunk boundary", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, "/x") as unknown as SimHost;
        await driver.fault(episode("daemon_restart"));
        // Raw passes fill well past one 64 KiB chunk; the served pass straddles a chunk edge.
        const raw =
            "[2026-10-16T12:00:01.000Z] [eidnara][s-1] rust pass: decision=declined:invocation_budget served_from=raw";
        for (let i = 0; i < 700; i++) pluginLog(driver, raw);
        const padding = "x".repeat(
            ((64 * 1024 - (statSize(driver) % (64 * 1024))) % (64 * 1024)) - 40,
        );
        pluginLog(driver, `[2026-10-16T12:00:02.000Z] ${padding}`);
        pluginLog(driver, PASS);
        const outcome = await driver.event(ev("user_turn", { id: "e-1", text: "go" }));
        expect(outcome.stores?.map((s) => s.fault)).toEqual(["f-daemon_restart"]);
    });

    test("the store check waits for the first pass the replacement daemon serves", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
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

    test("the final store check replaces a symlink at its path without writing through it", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        new Database(driver.storeDb).run(SEGMENTS_DDL);
        const target = join(armDir, "elsewhere.json");
        writeFileSync(target, "untouched\n");
        mkdirSync(armDir, { recursive: true });
        symlinkSync(target, join(armDir, "store-check.json"));
        await driver.finish();
        expect(readFileSync(target, "utf8")).toBe("untouched\n");
        expect(lstatSync(join(armDir, "store-check.json")).isSymbolicLink()).toBe(false);
        expect(JSON.parse(readFileSync(join(armDir, "store-check.json"), "utf8")).integrity).toBe(
            "ok",
        );
    });

    test("the final store archive replaces a planted final-store link and copies only the store's own files", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        new Database(driver.storeDb).run(SEGMENTS_DDL);
        const outside = tmp();
        writeFileSync(join(outside, "store.db"), "untouched\n");
        mkdirSync(armDir, { recursive: true });
        symlinkSync(outside, join(armDir, "final-store"));
        await driver.finish();
        expect(readFileSync(join(outside, "store.db"), "utf8")).toBe("untouched\n");
        const kept = join(armDir, "final-store");
        expect(lstatSync(kept).isDirectory()).toBe(true);
        expect(readFileSync(join(kept, "store.db"))).toEqual(readFileSync(driver.storeDb));
    });

    test("a final store file the host replaced with a link is refused, and nothing is copied through it", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        mkdirSync(dirname(driver.storeDb), { recursive: true });
        new Database(driver.storeDb).run(SEGMENTS_DDL);
        const secret = join(tmp(), "secret");
        writeFileSync(secret, "harness only\n");
        symlinkSync(secret, `${driver.storeDb}-shm`);
        await expect(driver.finish()).rejects.toThrow(/is a symlink/);
        expect(existsSync(join(armDir, "final-store", "store.db-shm"))).toBe(false);
    });

    test("finish stops the daemon and writes the final store check", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
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
        expect(check).toEqual({
            format: 2,
            integrity: "ok",
            segments: 0,
            overlaps: [],
            ranges: [],
        });
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

    test("a host upgrade asks for the upgraded version's transcript store at its next session end", async () => {
        const { driver, armDir } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.hostVersions = {
            from: "0.80.2",
            to: "0.87.1",
            upgradeTranscriptPaths: ["$PI_CODING_AGENT_DIR/sessions-next"],
        };
        o.config = { ...o.config, upgrade: { pi_install: "/next/pi" } };
        const inner = driver as unknown as { transcriptsChecked: boolean };
        await driver.reset();
        inner.transcriptsChecked = true;
        await driver.fault(episode("host_upgrade"));
        expect(inner.transcriptsChecked).toBe(false);
        writeFileSync(
            join(armDir, "transcripts.json"),
            JSON.stringify({
                checked_after: "first session_end",
                templates: ["$PI_CODING_AGENT_DIR/sessions"],
                paths: ["/t/sessions"],
                missing: [],
            }),
        );
        const resumed = new HostDriver(o);
        await resumed.resume(null);
        expect((resumed as unknown as { transcriptsChecked: boolean }).transcriptsChecked).toBe(
            false,
        );
        await resumed.stop();
    });

    test("a second host client runs one turn on the arm's daemon at the session's start", async () => {
        const { driver, hosts } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        const evidence = await driver.fault(episode("two_hosts_one_daemon"), at);
        expect(evidence).toMatchObject({
            second_session: "s-0000-b",
            daemon_pid: PID + 10,
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
        inner.snapshots = {
            sessionStart: noop,
            sessionEnd: noop,
            addTools: noop,
            logTurnTools: noop,
        };
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

    test("a daemon fault on a daemon already gone stops the run instead of restarting it", async () => {
        const { driver } = fixture("eidnara");
        const gone = spawnSync("true").pid as number;
        driver.daemon = fakeDaemon(gone) as unknown as DaemonStack;
        await expect(driver.fault(episode("daemon_restart"))).rejects.toThrow("already gone");
        expect(driver.daemonPid()).toBe(gone);
    });

    test("a second client that exits before the primary's session_end fails the arm", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
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
        await driver.stop().catch(() => undefined);
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.daemonFactory = () => fakeDaemon(PID + 10) as unknown as DaemonStack;
        const orphan = Bun.spawn(["sleep", "300"]);
        const start = readFileSync(`/proc/${orphan.pid}/stat`, "utf8")
            .split(") ")[1]
            ?.split(" ")[19];
        const recorded = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        writeFileSync(
            join(armDir, "state.json"),
            JSON.stringify({ ...recorded, daemon: { pid: orphan.pid, start } }),
        );
        await expect(new HostDriver(o).resume(null)).rejects.toThrow(
            "second client exited before the primary session's session_end",
        );
        await orphan.exited;
        expect(orphan.signalCode).toBe("SIGTERM");
    });

    test("stopping while the second client opens waits for the open, then closes it", async () => {
        const { driver, hosts } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
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
        expect([second.closed, second.closedWhileOpening]).toEqual([1, 0]);
    });

    test("stopping while the daemon restarts waits for the restart, then stops it", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
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
        expect(driver.host).toBeNull();
    });

    test("a stop whose daemon refuses to die keeps the replacement daemon's pid in the arm state", async () => {
        const { driver, armDir } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10);
        let release: () => void = () => undefined;
        daemon.gate = new Promise<void>((r) => {
            release = r;
        });
        daemon.stop = async () => {
            throw new Error("daemon survived SIGKILL");
        };
        driver.daemon = daemon as unknown as DaemonStack;
        const fault = driver.fault(episode("daemon_restart"));
        fault.catch(() => undefined);
        await Bun.sleep(5);
        const stop = driver.stop();
        stop.catch(() => undefined);
        release();
        await expect(stop).rejects.toThrow("daemon survived SIGKILL");
        await fault.catch(() => undefined);
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.daemon?.pid).toBe(PID + 11);
    });

    test("a fresh driver's stop leaves a recorded arm state for reapStale to read", async () => {
        const { driver, armDir } = fixture("host");
        mkdirSync(armDir, { recursive: true });
        const recorded = { model: 0, daemon: { pid: 4242, start: "7" }, host: null, second: null };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(recorded));
        await driver.stop();
        expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"))).toEqual(recorded);
    });

    test("a second client that lost its process still leaves its session owed after a stop", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        const at = ev("session_start", { project: "p" });
        await driver.fault(episode("two_hosts_one_daemon"), at);
        const second = hosts.at(-1) as FakeHost;
        second.pid = null;
        await driver.stop();
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.second_owed).toBe("s-0000");
    });

    test("a resume into a session whose second client was recorded reattaches one", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        const o = (driver as unknown as { o: DriverOptions }).o;
        const dead = Bun.spawnSync(["true"]).pid;
        // A daemon pid no live process holds, so each resume's reap has nothing to stop.
        o.daemonFactory = () => fakeDaemon(dead) as unknown as DaemonStack;
        const factory = o.hostFactory as (ctx: HostContext) => SimHost;
        // Each host runs as a live child of its own, so the arm records its launch identity and
        // a resume's reap stops it.
        const live: ReturnType<typeof Bun.spawn>[] = [];
        o.hostFactory = (ctx) => {
            const h = factory(ctx) as unknown as FakeHost;
            const child = Bun.spawn(["sleep", "300"]);
            live.push(child);
            h.pid = child.pid;
            return h as unknown as SimHost;
        };
        mkdirSync(join(armDir, "r"), { recursive: true });
        writeFileSync(
            join(armDir, "state.json"),
            JSON.stringify({
                model: 0,
                daemon: null,
                host: null,
                second: { pid: dead, start: null, session: "s-0000" },
                ballast: null,
                refilling: false,
                git: null,
                failed: null,
                store_faults: {},
            }),
        );
        const inner = driver as unknown as Record<string, unknown>;
        const noop = () => undefined;
        inner.snapshots = { sessionStart: noop, sessionEnd: noop, addTools: noop };
        await driver.resume(null);
        expect(hosts.map((h) => h.opened[0])).not.toContain(`s-0000-b@${driver.workspace("p")}`);
        await driver.stop();
        const again = new HostDriver(o);
        (again as unknown as Record<string, unknown>).snapshots = inner.snapshots;
        await again.resume(null);
        await again.event(ev("session_start", { project: "p" }));
        expect(hosts.map((h) => h.opened[0])).toContain(`s-0000-b@${driver.workspace("p")}`);
        await again.stop();
        hosts.length = 0;
        await driver.resume(null);
        await driver.event(ev("session_start", { project: "p" }));
        expect(hosts.map((h) => h.opened[0])).toContain(`s-0000-b@${driver.workspace("p")}`);
        expect(inner.second).not.toBeNull();
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(state.second).not.toBeNull();
        await driver.stop();
        for (const child of live) child.kill();
    });

    test("the first session after a host upgrade must leave a new transcript in the store", async () => {
        const { driver, transcripts } = fixture("host", { p: gitRepo() });
        const o = (driver as unknown as { o: DriverOptions }).o;
        o.hostVersions = {
            from: "0.80.2",
            to: "0.87.1",
            upgradeTranscriptPaths: o.transcriptPaths,
        };
        o.config = { ...o.config, upgrade: { pi_install: "/next/pi" } };
        await driver.reset();
        const sessions = join(transcripts, "sessions");
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, "old.jsonl"), "{}");
        await driver.event(ev("session_end"));
        await driver.fault(episode("host_upgrade"));
        const preUpgrade = new HostDriver(o);
        await preUpgrade.resume(null);
        expect((preUpgrade as unknown as { transcriptsChecked: boolean }).transcriptsChecked).toBe(
            false,
        );
        await preUpgrade.stop();
        await driver.event(ev("session_start"));
        await expect(driver.event(ev("session_end"))).rejects.toThrow("no new transcript");
        const resumed = new HostDriver(o);
        await resumed.resume(null);
        expect((resumed as unknown as { transcriptsChecked: boolean }).transcriptsChecked).toBe(
            false,
        );
        await resumed.stop();
        await driver.event(ev("session_start"));
        await Bun.sleep(20);
        writeFileSync(join(sessions, "new.jsonl"), "{}");
        await driver.stop();
        const reopened = new HostDriver(o);
        await reopened.resume(ev("session_start"));
        await reopened.event(ev("session_end"));
        await reopened.stop();
        await driver.resume(null);
        await driver.event(ev("session_start"));
        await Bun.sleep(20);
        writeFileSync(join(sessions, "again.jsonl"), "{}");
        await driver.event(ev("session_end"));
        symlinkSync("/", join(sessions, "escape"));
        await driver.fault(episode("host_upgrade"));
        await driver.event(ev("session_start"));
        await Bun.sleep(20);
        writeFileSync(join(sessions, "newer.jsonl"), "{}");
        await driver.event(ev("session_end"));
    });

    test("the store checks a daemon restart owes survive a resume through the arm state", async () => {
        const { driver, armDir } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        await driver.fault(episode("daemon_restart"));
        const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(Object.keys(state.store_faults)).toEqual(["f-daemon_restart"]);
        const plain = fixture("host", { p: gitRepo() });
        await plain.driver.reset();
        const written = JSON.parse(readFileSync(join(plain.armDir, "state.json"), "utf8"));
        writeFileSync(
            join(plain.armDir, "state.json"),
            JSON.stringify({ ...written, store_faults: { "f-daemon_restart": 0 } }),
        );
        const fresh = new HostDriver((plain.driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        const owed = (fresh as unknown as { storeFaults: Map<string, number> }).storeFaults;
        expect([...owed.keys()]).toEqual(["f-daemon_restart"]);
        await fresh.stop();
    });

    test("a second client whose close fails keeps its pid in the arm state", async () => {
        const { driver, hosts, armDir } = fixture("eidnara", { p: "/repo" });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
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
        await expect(driver.stop()).rejects.toThrow("host survived");
        const after = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
        expect(after.second?.pid).toBe(process.pid);
    });

    test("a model switch moves later sessions to the next model and keeps the daemon", async () => {
        const { driver } = fixture("eidnara");
        const daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
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
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        await expect(driver.fault(episode("daemon_restart"))).rejects.toThrow("between sessions");
        await expect(driver.fault(episode("provider_429"))).rejects.toThrow("no mechanism");
    });

    test("a resume with the store image gone stops instead of formatting a new store", async () => {
        const { driver } = fixture("eidnara");
        const inner = driver as unknown as { mountStore(fresh: boolean): void };
        try {
            expect(() => inner.mountStore(false)).toThrow("store image");
        } finally {
            await driver.stop();
        }
    });

    test.skipIf(!sudo)("store_full replaces a ballast link the host planted", async () => {
        const { driver } = fixture("eidnara");
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        const inner = driver as unknown as { mountStore(f: boolean): void };
        inner.mountStore(true);
        const victim = join(tmp(), "victim");
        writeFileSync(victim, "small");
        try {
            symlinkSync(victim, join(driver.storeRoot, "ballast"));
            expect(await driver.fault(episode("store_full"))).toMatchObject({ avail_kb: 0 });
            expect(readFileSync(victim, "utf8")).toBe("small");
            expect(lstatSync(join(driver.storeRoot, "ballast")).isSymbolicLink()).toBe(false);
        } finally {
            await driver.stop().catch(() => undefined);
        }
    });

    test.skipIf(!sudo)(
        "a ballast replaced by a link to a look-alike stops the run at session_end",
        async () => {
            const { driver, transcripts } = fixture("eidnara");
            mkdirSync(join(transcripts, "sessions"), { recursive: true });
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
            const inner = driver as unknown as { mountStore(f: boolean): void };
            inner.mountStore(true);
            try {
                await driver.fault(episode("store_full"));
                const ballast = join(driver.storeRoot, "ballast");
                const size = statSync(ballast).size;
                const twinDir = mkdtempSync("/var/tmp/sim-twin-");
                dirs.push(twinDir);
                const twin = join(twinDir, "twin");
                spawnSync("fallocate", ["-l", String(size), twin]);
                rmSync(ballast);
                symlinkSync(twin, ballast);
                await expect(driver.event(ev("session_end"))).rejects.toThrow("ballast");
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a directory left at the ballast's name is replaced by the fill",
        async () => {
            const { driver } = fixture("eidnara");
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            const inner = driver as unknown as { mountStore(f: boolean): void };
            inner.mountStore(true);
            try {
                mkdirSync(join(driver.storeRoot, "ballast", "deep"), { recursive: true });
                const evidence = await driver.fault(episode("store_full"));
                expect(evidence).toMatchObject({ avail_kb: 0 });
                expect(statSync(join(driver.storeRoot, "ballast")).isFile()).toBe(true);
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a second name linked to the ballast stops the run at session_end",
        async () => {
            const { driver, transcripts } = fixture("eidnara");
            mkdirSync(join(transcripts, "sessions"), { recursive: true });
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
            const inner = driver as unknown as { mountStore(f: boolean): void };
            inner.mountStore(true);
            try {
                await driver.fault(episode("store_full"));
                linkSync(join(driver.storeRoot, "ballast"), join(driver.storeRoot, "ballast-2"));
                await expect(driver.event(ev("session_end"))).rejects.toThrow(
                    "changed during the episode",
                );
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a fault the journal lost is cleared on resume instead of refilled",
        async () => {
            const daemonFactory = (ctx: { dataDir: string }) =>
                ({
                    ...fakeDaemon(null),
                    start: async () => void mkdirSync(ctx.dataDir, { recursive: true }),
                }) as unknown as DaemonStack;
            const { driver, armDir } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                await driver.fault(episode("store_full"));
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await fresh.resume(null, ["f-store_full"]);
                expect(existsSync(join(fresh.storeRoot, "ballast"))).toBe(false);
                const df = spawnSync("df", ["--output=avail", fresh.storeRoot], {
                    encoding: "utf8",
                });
                expect(Number(df.stdout.trim().split("\n").at(-1))).toBeGreaterThan(0);
                const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
                expect(state.ballast).toBeNull();
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)("space freed during the episode stops the run at session_end", async () => {
        const { driver, transcripts } = fixture("eidnara");
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
        driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
        driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
        const inner = driver as unknown as { mountStore(f: boolean): void };
        inner.mountStore(true);
        try {
            const other = join(driver.storeRoot, "daemon-data");
            spawnSync("fallocate", ["-l", "8M", other]);
            await driver.fault(episode("store_full"));
            rmSync(other);
            await expect(driver.event(ev("session_end"))).rejects.toThrow("free");
        } finally {
            await driver.stop().catch(() => undefined);
        }
    });

    test.skipIf(!sudo)(
        "a ballast recreated sparse by the host stops the run at session_end",
        async () => {
            const { driver, transcripts } = fixture("eidnara");
            mkdirSync(join(transcripts, "sessions"), { recursive: true });
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
            const inner = driver as unknown as { mountStore(f: boolean): void };
            inner.mountStore(true);
            try {
                await driver.fault(episode("store_full"));
                const ballast = join(driver.storeRoot, "ballast");
                const size = statSync(ballast).size;
                rmSync(ballast);
                spawnSync("truncate", ["-s", String(size), ballast]);
                await expect(driver.event(ev("session_end"))).rejects.toThrow("ballast");
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a resume killed between removing and refilling the ballast refills it next time",
        async () => {
            const daemonFactory = (ctx: { dataDir: string }) =>
                ({
                    ...fakeDaemon(null),
                    start: async () => {
                        mkdirSync(ctx.dataDir, { recursive: true });
                        if (process.env.SIM_TEST_KILL_START === "1") throw new Error("killed here");
                    },
                }) as unknown as DaemonStack;
            const { driver, armDir } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
            let fresh: HostDriver | null = null;
            let again: HostDriver | null = null;
            try {
                await driver.reset();
                await driver.fault(episode("store_full"));
                const o = (driver as unknown as { o: DriverOptions }).o;
                fresh = new HostDriver(o);
                process.env.SIM_TEST_KILL_START = "1";
                await expect(fresh.resume(null)).rejects.toThrow("killed here");
                delete process.env.SIM_TEST_KILL_START;
                rmSync(join(fresh.storeRoot, "ballast"), { force: true });
                await fresh.stop().catch(() => undefined);
                const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
                expect(state.ballast).not.toBeNull();
                again = new HostDriver(o);
                await again.resume(null);
                const df = spawnSync("df", ["--output=avail", again.storeRoot], {
                    encoding: "utf8",
                });
                expect(Number(df.stdout.trim().split("\n").at(-1))).toBe(0);
            } finally {
                delete process.env.SIM_TEST_KILL_START;
                await again?.stop().catch(() => undefined);
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)("a ballast left after its fault ended is removed on resume", async () => {
        const daemonFactory = (ctx: { dataDir: string }) =>
            ({
                ...fakeDaemon(null),
                start: async () => void mkdirSync(ctx.dataDir, { recursive: true }),
            }) as unknown as DaemonStack;
        const { driver, armDir } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
        let fresh: HostDriver | null = null;
        try {
            await driver.reset();
            await driver.fault(episode("store_full"));
            const state = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8"));
            writeFileSync(join(armDir, "state.json"), JSON.stringify({ ...state, ballast: null }));
            fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
            await fresh.resume(null);
            expect(existsSync(join(fresh.storeRoot, "ballast"))).toBe(false);
        } finally {
            await fresh?.stop().catch(() => undefined);
            await driver.stop().catch(() => undefined);
        }
    });

    test.skipIf(!sudo)("a ballast that vanished before the kill stops the resume", async () => {
        const daemonFactory = (ctx: { dataDir: string }) =>
            ({
                ...fakeDaemon(null),
                start: async () => void mkdirSync(ctx.dataDir, { recursive: true }),
            }) as unknown as DaemonStack;
        const { driver } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
        let fresh: HostDriver | null = null;
        try {
            await driver.reset();
            await driver.fault(episode("store_full"));
            rmSync(join(driver.storeRoot, "ballast"));
            fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
            await expect(fresh.resume(null)).rejects.toThrow("ballast");
        } finally {
            await fresh?.stop().catch(() => undefined);
            await driver.stop().catch(() => undefined);
        }
    });

    test.skipIf(!sudo)(
        "a ballast that vanished during the episode stops the run at session_end",
        async () => {
            const { driver, transcripts } = fixture("eidnara");
            mkdirSync(join(transcripts, "sessions"), { recursive: true });
            driver.daemon = fakeDaemon(PID + 10) as unknown as DaemonStack;
            driver.host = new FakeHost({} as HostContext, transcripts) as unknown as SimHost;
            const inner = driver as unknown as { mountStore(f: boolean): void };
            inner.mountStore(true);
            try {
                await driver.fault(episode("store_full"));
                rmSync(join(driver.storeRoot, "ballast"));
                await expect(driver.event(ev("session_end"))).rejects.toThrow("ballast");
            } finally {
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a resume whose daemon start fails leaves the ballast in place for the next attempt",
        async () => {
            let starts = 0;
            const daemonFactory = (ctx: { dataDir: string }) =>
                ({
                    pid: () => null,
                    connectionFile: join(ctx.dataDir, "conn"),
                    start: async () => {
                        if (starts++ > 0) throw new Error("daemon refused to start");
                        mkdirSync(ctx.dataDir, { recursive: true });
                    },
                    restart: async () => undefined,
                    stop: async () => undefined,
                }) as unknown as DaemonStack;
            const { driver } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                await driver.fault(episode("store_full"));
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await expect(fresh.resume(null)).rejects.toThrow("refused to start");
                expect(existsSync(join(fresh.storeRoot, "ballast"))).toBe(true);
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );

    test.skipIf(!sudo)(
        "a resume with the ballast still in place starts the daemon, then fills the store again",
        async () => {
            const started: number[] = [];
            const daemonFactory = (ctx: { dataDir: string }) =>
                ({
                    pid: () => null,
                    connectionFile: join(ctx.dataDir, "conn"),
                    start: async () => {
                        mkdirSync(ctx.dataDir, { recursive: true });
                        writeFileSync(join(ctx.dataDir, "conn"), "x".repeat(4096));
                        started.push(
                            Number(
                                spawnSync("df", ["--output=avail", ctx.dataDir], {
                                    encoding: "utf8",
                                })
                                    .stdout.trim()
                                    .split("\n")
                                    .at(-1),
                            ),
                        );
                    },
                    restart: async () => undefined,
                    stop: async () => undefined,
                }) as unknown as DaemonStack;
            const { driver } = fixture("eidnara", {}, { loopStore: true, daemonFactory });
            let fresh: HostDriver | null = null;
            try {
                await driver.reset();
                expect(await driver.fault(episode("store_full"))).toMatchObject({ avail_kb: 0 });
                fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
                await fresh.resume(null);
                expect(started).toHaveLength(2);
                expect(started[1]).toBeGreaterThan(0);
                const df = spawnSync("df", ["--output=avail", fresh.storeRoot], {
                    encoding: "utf8",
                });
                expect(Number(df.stdout.trim().split("\n").at(-1))).toBe(0);
            } finally {
                await fresh?.stop().catch(() => undefined);
                await driver.stop().catch(() => undefined);
            }
        },
    );
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
        const rebuilt = new SnapshotRecorder(armDir, "host", () => []);
        expect(rebuilt.sessionCommands()).toEqual([run]);
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
        expect(hidden.failed).toBe("rule files changed: .gitignore (added)");
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

    test("a .gitignore that ignores itself still fails the probe turn as a rule change", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => {
            writeFileSync(join(ws, "cache.rs"), "static STORE: Mutex<u8>;\n");
            writeFileSync(join(ws, ".gitignore"), "*\n");
            mkdirSync(join(ws, "deep", "er"), { recursive: true });
            writeFileSync(join(ws, "deep", "er", ".gitignore"), "*\n");
        };
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(outcome.failed).toBe(
            "rule files changed: .gitignore (added), deep/er/.gitignore (added)",
        );
    });

    test("an exclude or ignore file past the size cap reads as a changed rule", () => {
        const repo = gitRepo();
        const armDir = tmp();
        const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
        const info = join(repo, ".git", "info");
        mkdirSync(info, { recursive: true });
        const fd = openSync(join(info, "exclude"), "w");
        writeSync(fd, "x", 2 << 20);
        closeSync(fd);
        expect(recorder.excludeDigest(repo)).toBe("unreadable");
    });

    test("an exclude file that is a directory, symlink, or FIFO reads as a changed rule without blocking", () => {
        const repo = gitRepo();
        const armDir = tmp();
        const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
        const info = join(repo, ".git", "info");
        mkdirSync(info, { recursive: true });
        const exclude = join(info, "exclude");
        rmSync(exclude, { force: true });
        expect(recorder.excludeDigest(repo)).toBeNull();
        mkdirSync(exclude);
        expect(recorder.excludeDigest(repo)).toBe("unreadable");
        rmSync(exclude, { recursive: true });
        symlinkSync(join(tmp(), "secret"), exclude);
        expect(recorder.excludeDigest(repo)).toBe("unreadable");
        rmSync(exclude);
        spawnSync("mkfifo", [exclude]);
        const started = Date.now();
        expect(recorder.excludeDigest(repo)).toBe("unreadable");
        expect(Date.now() - started).toBeLessThan(1_000);
        rmSync(exclude);
        rmSync(info, { recursive: true });
        symlinkSync(tmp(), info);
        expect(recorder.excludeDigest(repo)).toBe("unreadable");
    });

    test("a probe turn that adds a .gitattributes rule ends failed, since attributes rewrite indexed content", async () => {
        const { driver, hosts } = fixture("host", { p: gitRepo() });
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.reset();
        const host = hosts.at(-1) as FakeHost;
        const ws = fresh.workspace("p");
        await fresh.event(ev("session_start", { session: "s-0" }));
        host.onPrompt = () => {
            writeFileSync(join(ws, "note.txt"), "before $Id: FORBIDDEN_VALUE $ after\n");
            writeFileSync(join(ws, ".gitattributes"), "*.txt ident\n");
        };
        const outcome = await fresh.event(
            ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
        );
        expect(outcome.failed).toBe("rule files changed: .gitattributes (added)");
        host.onPrompt = () =>
            writeFileSync(join(ws, ".git", "info", "attributes"), "*.txt ident\n");
        rmSync(join(ws, ".gitattributes"));
        mkdirSync(join(ws, ".git", "info"), { recursive: true });
        const info = await fresh.event(
            ev("user_turn", { id: "e-2", session: "s-0", text: "go", probe: "q-2" }),
        );
        expect(info.failed).toBe("rule files changed: .git/info/attributes (changed)");
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
                arm: "host",
                session: "s-0",
                status: 200,
                error: null,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
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
        const calls = [
            {
                seq: 0,
                arm: "host",
                session: "s-1",
                status: 200,
                error: null,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
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
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
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
        await driver.reset();
        mkdirSync(join(transcripts, "sessions"), { recursive: true });
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
    expect(readJsonl<{ command: string }>(path).map((e) => e.command)).toEqual([
        "ls",
        "cargo build",
    ]);
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

test("a recorder rebuilt over an index lock moves the workspace to a fresh index and leaves the lock alone", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    const gitDir = join(armDir, "snapshot.git");
    const lock = join(gitDir, `${basename(repo)}.index.lock`);
    writeFileSync(lock, "");
    const started = Date.now();
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => [], 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    writeFileSync(join(repo, "new.rs"), "fn x() {}\n");
    expect(resumed.tree(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(gitDir, `${basename(repo)}.1.index`))).toBe(true);
    writeFileSync(join(gitDir, `${basename(repo)}.1.index.lock`), "");
    const again = new SnapshotRecorder(armDir, "eidnara", () => [], 5_000);
    expect(again.tree(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(gitDir, `${basename(repo)}.2.index`))).toBe(true);
});

test("a session that changed a rule file leaves the next session a refused prior-session diff", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.trackIgnoreRules(basename(repo), {}, null, null);
    recorder.sessionStart("s-1", basename(repo), repo);
    writeFileSync(join(repo, ".gitignore"), "secret.txt\n");
    writeFileSync(join(repo, "secret.txt"), "hidden");
    recorder.sessionEnd("s-1", basename(repo), repo);
    rmSync(join(repo, ".gitignore"));
    recorder.sessionStart("s-2", basename(repo), repo);
    const before = recorder.tree(repo);
    recorder.capture(
        { probe: "q", session: "s-2", id: "e-5" },
        basename(repo),
        repo,
        before,
        [],
        false,
    );
    const snap = JSON.parse(readFileSync(join(armDir, "snapshots.jsonl"), "utf8"));
    const prior = snap.artefacts.find((a: { role?: string }) => a.role === "prior-session");
    expect(prior.patch).toBe("");
    expect(prior.refused).toContain(".gitignore (added)");
    expect(() => new ArtefactReader(snap).diff("prior-session")).toThrow(
        "prior-session diff unrecorded",
    );
});

test("the workspace walk checks its deadline once per directory, so a forest of empty directories ends in time", () => {
    const repo = gitRepo();
    for (let i = 0; i < 3_000; i++) mkdirSync(join(repo, "empties", `d${i}`), { recursive: true });
    const recorder = new SnapshotRecorder(tmp(), "eidnara", () => [], 0);
    const started = Date.now();
    expect(() => recorder.survey(repo)).toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
});

test("a tool run reported at its start is on record, and its end report replaces it", () => {
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.addTools([{ command: "cargo build", exit: null, scenario_ms: 1, call: "t1" }], "e-1");
    recorder.addTools([{ command: "ls", exit: 0, scenario_ms: 2 }], "e-1");
    const killed = new SnapshotRecorder(armDir, "eidnara", () => []);
    expect(killed.sessionCommands()).toEqual([
        { command: "cargo build", exit: null, scenario_ms: 1, call: "t1" },
        { command: "ls", exit: 0, scenario_ms: 2 },
    ]);
    recorder.addTools([{ command: "cargo build", exit: 1, scenario_ms: 9, call: "t1" }], "e-1");
    const ended = new SnapshotRecorder(armDir, "eidnara", () => []);
    expect(ended.sessionCommands()).toEqual([
        { command: "cargo build", exit: 1, scenario_ms: 1, call: "t1" },
        { command: "ls", exit: 0, scenario_ms: 2 },
    ]);
});

test("a symlink planted at the saved git-config path is never written through on reset", async () => {
    const { driver, armDir } = fixture("host", { p: gitRepo() });
    const victim = join(tmp(), "victim");
    writeFileSync(victim, "keep");
    mkdirSync(armDir, { recursive: true });
    symlinkSync(victim, join(armDir, "p.gitconfig"));
    await driver.reset();
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(join(armDir, "p.gitconfig")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(armDir, "p.gitconfig"), "utf8")).toContain("[core]");
});

test("a probe that writes an attribute rule git cannot apply fails the turn instead of the run", async () => {
    const source = gitRepo();
    const { driver, hosts } = fixture("host", { p: source });
    await driver.reset();
    await driver.event(ev("session_start", { id: "e-0", session: "s-0" }));
    const ws = driver.workspace("p");
    const host = hosts.at(-1) as FakeHost;
    host.onPrompt = () => {
        writeFileSync(join(ws, ".gitattributes"), "*.txt working-tree-encoding=NO-SUCH-ENCODING\n");
        writeFileSync(join(ws, "note.txt"), "hello");
    };
    const outcome = await driver.event(
        ev("user_turn", { id: "e-1", session: "s-0", text: "go", probe: "q-1" }),
    );
    expect(outcome.failed).toContain("rule files changed");
    expect(outcome.snapshot).toBeDefined();
    const again = await driver.event(
        ev("user_turn", { id: "e-2", session: "s-0", text: "again", probe: "q-2" }),
    );
    expect(again.failed).toContain("git add failed under changed rule files");
});

test("a restored state whose index generation is not a nonnegative integer is refused", () => {
    const armDir = tmp();
    writeFileSync(
        join(armDir, "snapshot-state.json"),
        JSON.stringify({
            session: null,
            ended: null,
            starts: {},
            last: {},
            indexGenerations: { p: "/../../../../escape" },
        }),
    );
    expect(() => new SnapshotRecorder(armDir, "eidnara", () => [])).toThrow(
        "names index generation",
    );
});

test("an embedded repository whose name is pathspec magic removes only itself from the tree", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "keep.txt"), "k");
    const magic = join(repo, ":(glob)**");
    mkdirSync(magic);
    spawnSync("git", ["init", "-q"], { cwd: magic });
    const recorderDir = tmp();
    const recorder = new SnapshotRecorder(recorderDir, "eidnara", () => []);
    const tree = recorder.tree(repo);
    const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", tree], {
        cwd: repo,
        env: { ...process.env, GIT_DIR: join(recorderDir, "snapshot.git") },
    }).stdout.toString();
    expect(listed).toContain("keep.txt");
    expect(listed).toContain("README");
});

test("tool reports append to the command log instead of rewriting the recorder state", () => {
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.addTools([{ command: "a", exit: 0, scenario_ms: 1 }], null);
    const stateBefore = statSync(join(armDir, "snapshot-state.json"), { throwIfNoEntry: false });
    recorder.addTools([{ command: "b", exit: 0, scenario_ms: 2 }], null);
    const stateAfter = statSync(join(armDir, "snapshot-state.json"), { throwIfNoEntry: false });
    expect(stateAfter?.mtimeMs ?? null).toBe(stateBefore?.mtimeMs ?? null);
    const lines = readFileSync(join(armDir, "commands.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
});

test("a symlink planted at the recorder's staging path is never written through", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const victim = join(tmp(), "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(armDir, "snapshot-state.json.tmp"));
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.sessionStart("s-1", "p", repo);
    recorder.sessionEnd("s-1", "p", repo);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(existsSync(join(armDir, "snapshot-state.json"))).toBe(true);
});

test("a recorder state naming a non-tree value where a tree id belongs is refused before git runs", () => {
    const repo = gitRepo();
    const armDir = tmp();
    const first = new SnapshotRecorder(armDir, "eidnara", () => []);
    first.sessionStart("s-1", "p", repo);
    first.sessionEnd("s-1", "p", repo);
    const statePath = join(armDir, "snapshot-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const victim = join(tmp(), "victim");
    state.last.p.from = `--output=${victim}`;
    writeFileSync(statePath, JSON.stringify(state));
    const resumed = new SnapshotRecorder(armDir, "eidnara", () => []);
    resumed.sessionStart("s-2", "p", repo);
    expect(() =>
        resumed.capture(
            { probe: "q", session: "s-2", id: "e-2" },
            "p",
            repo,
            resumed.tree(repo),
            [],
            false,
        ),
    ).toThrow("where a tree id belongs");
    expect(existsSync(victim)).toBe(false);
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
    for (let i = 0; i < 1_500; i++) {
        mkdirSync(join(repo, "wide", `d${i}`, "deeper"), { recursive: true });
        writeFileSync(join(repo, "wide", `d${i}`, "f.rs"), "");
    }
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => [], 1);
    expect(() => recorder.embedded(repo)).toThrow("timed out");
    const roomy = new SnapshotRecorder(armDir, "eidnara", () => [], 120_000);
    expect(roomy.embedded(repo)).toEqual([]);
}, 120_000);

test("a session end that leaves a nested repository where indexed files were drops them from the tree", () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "vendor"));
    writeFileSync(join(repo, "vendor", "old.rs"), "fn old() {}\n");
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.sessionStart("s-1", "p", repo);
    rmSync(join(repo, "vendor"), { recursive: true });
    mkdirSync(join(repo, "vendor"));
    spawnSync("git", ["init", "-q"], { cwd: join(repo, "vendor") });
    writeFileSync(join(repo, "vendor", "new.rs"), "fn fresh() {}\n");
    recorder.sessionEnd("s-1", "p", repo);
    recorder.sessionStart("s-2", "p", repo);
    const id = recorder.capture(
        { probe: "q", session: "s-2", id: "e-2" },
        "p",
        repo,
        recorder.tree(repo),
        [],
        false,
    );
    const prior = captured(armDir)[`${id}:prior-diff`]?.patch ?? "";
    expect(prior).toContain("-fn old() {}");
    expect(prior).not.toContain("fresh");
});

test("rule-file hashing is bounded by count and by the recorder deadline", () => {
    const repo = gitRepo();
    const armDir = tmp();
    for (let i = 0; i < 1_100; i++) {
        mkdirSync(join(repo, "many", `d${i}`), { recursive: true });
        writeFileSync(join(repo, "many", `d${i}`, ".gitignore"), "x\n");
    }
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => [], 60_000);
    expect(() => recorder.survey(repo)).toThrow("more than 1000 rule files");
    const few = gitRepo();
    for (let i = 0; i < 50; i++) {
        mkdirSync(join(few, "some", `d${i}`), { recursive: true });
        writeFileSync(join(few, "some", `d${i}`, ".gitignore"), "x\n");
    }
    const slow = new SnapshotRecorder(tmp(), "eidnara", () => [], 0);
    slow.trackIgnoreRules(basename(few), {}, null, null);
    const files = Array.from({ length: 50 }, (_, i) => `some/d${i}/.gitignore`);
    expect(() => slow.ignoreChanges(few, basename(few), files)).toThrow("hashing timed out");
}, 60_000);

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
    mkdirSync(join(transcripts, "sessions"), { recursive: true });
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

test("a fresh recorder creates an empty tools.jsonl, so a run with no tool runs still has the ledger", () => {
    const armDir = tmp();
    new SnapshotRecorder(armDir, "eidnara", () => []);
    expect(readFileSync(join(armDir, "tools.jsonl"), "utf8")).toBe("");
});

test("clearing a recorder leaves an empty tools.jsonl in place", () => {
    const armDir = tmp();
    const recorder = new SnapshotRecorder(armDir, "eidnara", () => []);
    recorder.addTools([{ command: "ls", exit: 0, scenario_ms: 1 }], "e-1");
    recorder.clear();
    expect(readFileSync(join(armDir, "tools.jsonl"), "utf8")).toBe("");
});

test("a tool run recovered from an earlier turn is logged with no turn, whatever turn is in progress", async () => {
    const { driver, hosts, armDir, transcripts } = fixture("host", { p: gitRepo() });
    await driver.reset();
    mkdirSync(join(transcripts, "sessions"), { recursive: true });
    const host = hosts.at(-1) as FakeHost;
    await driver.event(ev("session_start", { session: "s-0" }));
    host.onPrompt = () => {
        host.ctx.onTool?.({ command: "cargo build", exit: 0, scenario_ms: 3, recovered: true });
        host.ctx.onTool?.({ command: "ls", exit: 0, scenario_ms: 4 });
    };
    await driver.event(ev("user_turn", { id: "e-1", session: "s-0", text: "go" }));
    const lines = readFileSync(join(armDir, "tools.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.command, l.turn])).toEqual([
        ["cargo build", null],
        ["ls", "e-1"],
    ]);
});

test("the plugin log is created without following a symlink the agent left at its path", () => {
    const dir = tmp();
    const target = join(dir, "elsewhere", "eidnara.log");
    symlinkSync(target, join(dir, "eidnara.log"));
    expect(() => createNoFollow(join(dir, "eidnara.log"))).toThrow(/eidnara\.log is a symlink/);
    expect(existsSync(target)).toBe(false);
    createNoFollow(join(dir, "plain.log"));
    expect(lstatSync(join(dir, "plain.log")).isFile()).toBe(true);
    createNoFollow(join(dir, "plain.log"));
});
