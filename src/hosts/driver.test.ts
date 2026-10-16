import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    linkSync,
    lstatSync,
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
import { sandboxAvailable, writeLauncher } from "../run/launcher";
import type { ScenarioEvent } from "../run/scheduler";
import { type FaultType, SEAMS } from "../scenario/faults";
import type { DaemonStack, HostContext, PromptResult, SimHost } from "./arms";
import { type DriverOptions, expandTemplate, HostDriver } from "./driver";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "sim-driver-"));
    dirs.push(d);
    return d;
};

const BASE_MS = Date.UTC(2031, 0, 1);
const sandbox = sandboxAvailable();

class FakeHost {
    opened: string[] = [];
    closed = 0;
    pid: number | null = null;
    onPrompt: () => void = () => undefined;
    onSpawn: () => void = () => undefined;
    constructor(
        readonly ctx: HostContext,
        private readonly transcripts: string,
    ) {}
    async openSession(cwd: string, session: string) {
        this.opened.push(`${session}@${cwd}`);
        this.onSpawn();
    }
    async prompt(): Promise<PromptResult> {
        this.onPrompt();
        return {};
    }
    failClose = false;
    onClose: () => void = () => undefined;
    async closeSession() {
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
}

function fixture(
    arm: DriverOptions["arm"],
    projects: Record<string, string> = {},
    extra: Partial<DriverOptions> = {},
) {
    const root = tmp();
    const transcripts = join(root, "agent");
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
        ...extra,
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
            ...fakeDaemon(10),
            stop: async () => void stopped++,
        } as unknown as DaemonStack;
        await expect(driver.stop()).rejects.toThrow("host survived");
        expect(stopped).toBe(1);
    });

    test("the transcript store is checked after the first session and a gap stops the run", async () => {
        const ok = fixture("host");
        await ok.driver.reset();
        mkdirSync(join(ok.transcripts, "sessions"), { recursive: true });
        await ok.driver.event(ev("session_end"));
        const record = JSON.parse(readFileSync(join(ok.armDir, "transcripts.json"), "utf8"));
        expect(record.missing).toEqual([]);

        const gap = fixture("host");
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
        await expect(driver.event(diff)).rejects.toThrow("leaves");
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
        const daemon = fakeDaemon(10);
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

    test("a resume refuses a daemon runtime or data directory the host replaced with a symlink", async () => {
        const daemonFactory = () =>
            ({ ...fakeDaemon(null), start: async () => undefined }) as unknown as DaemonStack;
        const { driver, root } = fixture("eidnara", {}, { daemonFactory });
        await driver.reset();
        const runtime = join(root, "eidnara", "r", "runtime");
        rmSync(runtime, { recursive: true, force: true });
        symlinkSync(tmp(), runtime);
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await expect(fresh.resume(null)).rejects.toThrow("leaves");
    });

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

    test.skipIf(!sandbox)("a hook that hangs is cut off at the turn deadline", async () => {
        const { driver } = fixture("host", { p: gitRepo() });
        await driver.reset();
        const ws = driver.workspace("p");
        writeFileSync(join(ws, ".git/hooks/post-commit"), "#!/bin/sh\nexec sleep 300\n", {
            mode: 0o755,
        });
        const started = Date.now();
        await expect(
            driver.event(ev("apply_diff", { path: "a.txt", content: "A" })),
        ).rejects.toThrow(/git commit/);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

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

    test("a resumed daemon keeps the arm's first model after a model switch", async () => {
        const models: string[] = [];
        const daemonFactory = (ctx: { model: string }) =>
            ({
                ...fakeDaemon(null),
                start: async () => void models.push(ctx.model),
            }) as unknown as DaemonStack;
        const { driver } = fixture("eidnara", {}, { daemonFactory });
        await driver.reset();
        await driver.fault(episode("model_switch"));
        const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
        await fresh.resume(null);
        expect(models).toEqual(["model-a", "model-a"]);
        expect(fresh.host?.ctx.model).toBe("model-b");
    });

    test.skipIf(!sandbox)(
        "a git run the killed harness left behind is recorded and reaped",
        async () => {
            const { driver, armDir } = fixture(
                "host",
                { p: gitRepo() },
                { turnDeadlineMs: 60_000 },
            );
            await driver.reset();
            const ws = driver.workspace("p");
            writeFileSync(join(ws, ".gitattributes"), "* filter=slow\n");
            spawnSync("git", ["config", "filter.slow.clean", "sleep 300"], { cwd: ws });
            const applying = driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
            applying.catch(() => undefined);
            let recorded: { pid: number } | null = null;
            for (let i = 0; i < 100 && !recorded; i++) {
                await Bun.sleep(50);
                recorded = JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).git ?? null;
            }
            expect(recorded).not.toBeNull();
            const fresh = new HostDriver((driver as unknown as { o: DriverOptions }).o);
            await fresh.reap();
            await expect(applying).rejects.toThrow(/git add/);
            expect(existsSync(join(ws, ".git/index.lock"))).toBe(false);
            expect(JSON.parse(readFileSync(join(armDir, "state.json"), "utf8")).git).toBeNull();
        },
    );

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

    test.skipIf(!sandbox)("a hook sees none of the harness's environment", async () => {
        process.env.SIM_TEST_SECRET = "leaked";
        try {
            const { driver } = fixture("host", { p: gitRepo() });
            await driver.reset();
            const ws = driver.workspace("p");
            writeFileSync(
                join(ws, ".git/hooks/post-commit"),
                '#!/bin/sh\nprintf %s "$SIM_TEST_SECRET" > seen\n',
                { mode: 0o755 },
            );
            await driver.event(ev("apply_diff", { path: "a.txt", content: "A" }));
            expect(readFileSync(join(ws, "seen"), "utf8")).toBe("");
        } finally {
            delete process.env.SIM_TEST_SECRET;
        }
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

    const sudo = spawnSync("sudo", ["-n", "true"]).status === 0;
    test.skipIf(!sudo)(
        "store_full fills the loop store and leaves its image sparse once the ballast goes",
        async () => {
            const { driver, armDir } = fixture("eidnara");
            driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
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
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
        await expect(driver.fault(episode("daemon_restart"))).rejects.toThrow("between sessions");
        await expect(driver.fault(episode("host_upgrade"))).rejects.toThrow("no mechanism");
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
        driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
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
            driver.daemon = fakeDaemon(10) as unknown as DaemonStack;
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
