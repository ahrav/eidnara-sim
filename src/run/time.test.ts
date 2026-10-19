import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/config";
import { Clock } from "./clock";
import {
    assess,
    type BinaryProbe,
    DISTORTIONS,
    type Interception,
    interceptionTest,
    probes,
} from "./interception";
import { Journal } from "./journal";
import { launch, sandboxAvailable, writeLauncher } from "./launcher";
import { procStats, ResourceSampler, treeBytes } from "./sampler";
import { Scheduler } from "./scheduler";
import { FAKETIME_LIB, faketimeEnv, readOffsetSeconds, writeOffset } from "./timeinject";
import { transcriptPaths } from "./transcripts";

const live = existsSync(FAKETIME_LIB) && sandboxAvailable();
const runRoot = () => {
    const base = join(process.cwd(), "runs", "test-sandbox");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, "r-"));
};

describe("time injection", () => {
    test("the offset file puts the process clock at base plus scenario time", () => {
        const file = join(mkdtempSync(join(tmpdir(), "ft-")), "offset");
        const written = writeOffset(file, 10_000_000, 3_600_000, 10_000_000);
        expect(written.offset_s).toBe(3_600);
        // The transition is bounded: the new offset is readable from no earlier than offset_wall_ms
        // and the old one from no later than offset_settled_ms, both taken around the rename.
        expect(written.offset_wall_ms).toBeGreaterThan(0);
        expect(written.offset_settled_ms).toBeGreaterThanOrEqual(written.offset_wall_ms);
        expect(readOffsetSeconds(file)).toBe(3_600);
        writeOffset(file, 0, 0, 5_000);
        expect(readFileSync(file, "utf8")).toBe("-5\n");
        expect(faketimeEnv(file)).toEqual({
            LD_PRELOAD: FAKETIME_LIB,
            FAKETIME_TIMESTAMP_FILE: file,
            FAKETIME_NO_CACHE: "1",
            FAKETIME_DONT_FAKE_MONOTONIC: "1",
        });
    });

    test("the launcher refuses paths and values the shell would split", () => {
        expect(() => launch("/x/sandbox.sh", ["/a b"], {}, ["true"])).toThrow(/must match/);
        expect(() => launch("/x/sandbox.sh", ["/../tmp"], {}, ["true"])).toThrow(/normalized/);
        expect(() => launch("/x/sandbox.sh", ["/a/./b"], {}, ["true"])).toThrow(/normalized/);
        expect(() => launch("/x/sandbox.sh", ["/a//b"], {}, ["true"])).toThrow(/normalized/);
        expect(() => launch("/x/sandbox.sh", [], { A: "x y" }, ["true"])).toThrow(/plain word/);
        expect(launch("/x/sandbox.sh", [], { A: "/runs/host~aa/clock" }, ["true"])).toContain(
            "A=/runs/host~aa/clock",
        );
        expect(launch("/x/sandbox.sh", ["/runs/host~aa/r"], {}, ["true"])).toContain(
            "/runs/host~aa/r",
        );
        expect(() => launch("/x/sandbox.sh", ["/runs/~aa"], {}, ["true"])).toThrow(/must match/);
        for (const value of ["~/clock", "a:~/b", "x=~y"]) {
            expect(() => launch("/x/sandbox.sh", [], { A: value }, ["true"])).toThrow(/plain word/);
        }
        expect(() => launch("/x/sandbox.sh", [], {}, ["true"], [], "/a b")).toThrow(/must match/);
        expect(() => launch("/x/sandbox.sh", ["/a/b"], {}, ["true"], ["/a"])).toThrow(
            "sandbox path /a/b is kept writable under read-only /a",
        );
        const home = realpathSync(homedir());
        expect(() => launch("/x/sandbox.sh", [], {}, ["true"], [home])).toThrow(
            `sandbox path ${home} would restore masked ${home}`,
        );
        expect(() => launch("/x/sandbox.sh", [], {}, ["true"], [dirname(home)])).toThrow(
            /would restore masked/,
        );
        expect(() => launch("/x/sandbox.sh", ["/tmp"], {}, ["true"])).toThrow(
            "sandbox path /tmp would restore masked /tmp",
        );
        const alias = join(realpathSync(mkdtempSync(join(tmpdir(), "sim-alias-"))), "home-link");
        symlinkSync(home, alias);
        expect(() => launch("/x/sandbox.sh", [], {}, ["true"], [alias])).toThrow(
            `sandbox path ${alias} would restore masked ${home}`,
        );
        const run = realpathSync(mkdtempSync(join(tmpdir(), "sim-runroot-")));
        const launcher = join(run, "sandbox.sh");
        expect(() => launch(launcher, [run], {}, ["true"])).toThrow(
            `sandbox path ${run} would restore masked ${run}`,
        );
        expect(launch(launcher, [join(run, "arm")], {}, ["true"])).toContain(join(run, "arm"));
        const aliased = join(run, "alias");
        mkdirSync(join(run, "tools"));
        symlinkSync(join(run, "tools"), aliased);
        expect(() => launch(launcher, [aliased], {}, ["true"], [join(run, "tools")])).toThrow(
            /is kept writable under read-only/,
        );
        expect(() =>
            launch(launcher, [join(aliased, "not-yet")], {}, ["true"], [join(run, "tools")]),
        ).toThrow(/is kept writable under read-only/);
        expect(launch("/x/sandbox.sh", [], {}, ["true"], [join(home, ".cargo")])).toContain(
            join(home, ".cargo"),
        );
        expect(launch("/x/sandbox.sh", ["/k"], { A: "1" }, ["true"], ["/r"])).toEqual([
            "/x/sandbox.sh",
            "/",
            "/k",
            "--ro",
            "/r",
            "--env",
            "A=1",
            "--",
            "true",
        ]);
    });

    test("transcript-store paths come from the per-version table; an unknown version is refused", () => {
        expect(transcriptPaths("pi", "0.80.2")).toEqual(["$PI_CODING_AGENT_DIR/sessions"]);
        expect(transcriptPaths("opencode", "1.19.0")).toEqual([
            "$XDG_DATA_HOME/opencode/opencode.db",
        ]);
        expect(() => transcriptPaths("opencode", "2.0.0")).toThrow(/no transcript-store paths/);
    });

    test.skipIf(!live)(
        "each configured binary reads the jumped clock through the real launcher",
        () => {
            const config = loadConfig();
            const root = runRoot();
            const results = interceptionTest(
                writeLauncher(root),
                root,
                probes({
                    node: realpathSync(Bun.which("node") ?? "node"),
                    opencode: config.opencode_binary,
                    daemon: config.daemon_binary,
                }),
            );
            expect(results.map((r) => [r.name, r.intercepted, r.wall_clock_only])).toEqual([
                ["pi", true, false],
                ["opencode", true, false],
                ["daemon", true, false],
            ]);
            for (const r of results.slice(0, 2))
                expect(r.evidence.timer_ms as number).toBeLessThan(1_000);
        },
        120_000,
    );

    test.skipIf(!live)(
        "a binary that drops the interposer or leaves clock_gettime unbound is recorded wall-clock-only",
        () => {
            const root = runRoot();
            const [pi, , unbound] = probes({
                node: realpathSync(Bun.which("node") ?? "node"),
                opencode: "/bin/true",
                daemon: "/bin/true",
            });
            const stripped: BinaryProbe = {
                ...(pi as BinaryProbe),
                argv: ["/usr/bin/env", "-u", "LD_PRELOAD", ...(pi as BinaryProbe).argv],
            };
            const results = interceptionTest(writeLauncher(root), root, [
                stripped,
                unbound as BinaryProbe,
            ]);
            expect(results.map((r) => [r.name, r.intercepted, r.wall_clock_only])).toEqual([
                ["pi", false, true],
                ["daemon", false, true],
            ]);
            expect(results[1]?.evidence.binding).toBeNull();
        },
        60_000,
    );

    test.skipIf(!live)(
        "a binds-clock binary reached through a symlink is detected",
        () => {
            const root = runRoot();
            const node = realpathSync(Bun.which("node") ?? "node");
            const linkDir = join(root, "bin");
            mkdirSync(linkDir);
            symlinkSync(node, join(linkDir, "daemon"));
            const [, , daemon] = probes({
                node,
                opencode: "/bin/true",
                daemon: join(linkDir, "daemon"),
            });
            const probe = {
                ...(daemon as BinaryProbe),
                argv: [(daemon as BinaryProbe).path, "-e", "1"],
            };
            const [result] = interceptionTest(writeLauncher(root), root, [probe]);
            expect(result?.intercepted).toBe(true);
            expect(result?.path).toBe(node);
        },
        60_000,
    );

    test.skipIf(!live)(
        "a probe that binds the clock but exits with a failure is recorded wall-clock-only",
        () => {
            const root = runRoot();
            const node = realpathSync(Bun.which("node") ?? "node");
            const [, , daemon] = probes({ node, opencode: "/bin/true", daemon: node });
            const probe = { ...(daemon as BinaryProbe), argv: [node, "--bogus-option"] };
            const [result] = interceptionTest(writeLauncher(root), root, [probe]);
            expect(result?.evidence.exit).toBe(9);
            expect(result?.evidence.binding).not.toBeNull();
            expect(result?.intercepted).toBe(false);
            expect(result?.wall_clock_only).toBe(true);
        },
        60_000,
    );

    test.skipIf(!live)(
        "the sandboxed command starts at / and sees nothing of the harness working directory",
        () => {
            const root = runRoot();
            const r = Bun.spawnSync(launch(writeLauncher(root), [], {}, ["/bin/pwd", "-P"]), {
                cwd: process.cwd(),
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(r.exitCode).toBe(0);
            expect(r.stdout.toString()).toBe("/\n");
        },
        60_000,
    );

    test.skipIf(!live)(
        "the privileged part of the launcher resolves its tools from system directories, not the caller's PATH",
        () => {
            const root = runRoot();
            const plant = mkdtempSync("/var/tmp/sim-plant-");
            try {
                writeFileSync(join(plant, "setpriv"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
                const r = Bun.spawnSync(launch(writeLauncher(root), [], {}, ["/bin/true"]), {
                    env: { ...process.env, PATH: `${plant}:${process.env.PATH ?? ""}` },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                expect(r.exitCode).toBe(0);
            } finally {
                rmSync(plant, { recursive: true, force: true });
            }
        },
        60_000,
    );

    test.skipIf(!live)(
        "a probe that outlives its deadline is killed with its namespace and recorded wall-clock-only",
        async () => {
            const root = runRoot();
            const marker = `${process.pid}.${Date.now()}`;
            const alive = () =>
                Bun.spawnSync(["pgrep", "-f", `^/bin/sleep ${marker}$`])
                    .stdout.toString()
                    .trim();
            const [pi] = probes({
                node: realpathSync(Bun.which("node") ?? "node"),
                opencode: "/bin/true",
                daemon: "/bin/true",
            });
            const hung: BinaryProbe = { ...(pi as BinaryProbe), argv: ["/bin/sleep", marker] };
            const started = Date.now();
            const [result] = interceptionTest(writeLauncher(root), root, [hung], 1);
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(result?.intercepted).toBe(false);
            expect(result?.evidence.signal).toBe("SIGKILL");
            for (let i = 0; i < 20 && alive() !== ""; i++) await Bun.sleep(100);
            const leftover = alive();
            if (leftover !== "")
                Bun.spawnSync(["sudo", "-n", "kill", "-9", ...leftover.split("\n")]);
            expect(leftover).toBe("");
        },
        60_000,
    );

    test.skipIf(!live)(
        "a launch that fails while staging leaves nothing in the host's /dev/shm",
        () => {
            const root = runRoot();
            const before = readdirSync("/dev/shm");
            const missing = join(root, "missing");
            const r = Bun.spawnSync(launch(writeLauncher(root), [missing], {}, ["/bin/true"]), {
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(r.exitCode).not.toBe(0);
            expect(readdirSync("/dev/shm")).toEqual(before);
        },
        60_000,
    );
});

describe("preflight assessment", () => {
    const result = (name: string, intercepted: boolean): Interception => ({
        name,
        path: `/bin/${name}`,
        intercepted,
        wall_clock_only: !intercepted,
        evidence: {},
    });

    test("a wall-clock-only binary is listed among the distortions", () => {
        const { distortions } = assess([
            result("pi", true),
            result("opencode", false),
            result("daemon", true),
        ]);
        expect(distortions).toEqual([...DISTORTIONS, "opencode runs wall-clock-only"]);
    });

    test("the run stops when neither Pi nor the daemon is intercepted", () => {
        expect(() =>
            assess([result("pi", false), result("opencode", true), result("daemon", false)]),
        ).toThrow(/escalate/);
        expect(() =>
            assess([result("pi", false), result("opencode", false), result("daemon", true)]),
        ).not.toThrow();
    });
});

describe("clock hook", () => {
    test("a jump is journaled before the hook publishes it", () => {
        const calls: number[] = [];
        const journal = new Journal(join(mkdtempSync(join(tmpdir(), "oc-")), "j.jsonl"));
        const clock = new Clock(0, journal, Date.now, (ms) => {
            expect(
                journal.entries.some((e) => e.kind === "AdvanceClock" && e.scenario_ms === ms),
            ).toBe(true);
            calls.push(ms);
        });
        clock.advanceTo(5_000, "a");
        expect(calls).toEqual([5_000]);
        const failing = {
            append: () => {
                throw new Error("disk full");
            },
            entries: [],
        } as unknown as Journal;
        const unpublished = new Clock(0, failing, Date.now, (ms) => void calls.push(ms));
        expect(() => unpublished.advanceTo(9_000, "a")).toThrow(/disk full/);
        expect(calls).toEqual([5_000]);
    });

    test("onClock receives each arm's starting time and every jump", async () => {
        const calls: [string, number][] = [];
        const j = new Journal(join(mkdtempSync(join(tmpdir(), "oc-")), "j.jsonl"));
        const events = [
            { id: "e-0", kind: "session_start" as const, scenario_ms: 0, session: "s" },
            { id: "e-1", kind: "user_turn" as const, scenario_ms: 5_000, session: "s", index: 0 },
            { id: "e-2", kind: "session_end" as const, scenario_ms: 9_000, session: "s" },
        ];
        const driver = {
            reset: async () => undefined,
            event: async () => ({}),
            fault: async () => ({}),
        };
        await new Scheduler({
            events,
            faults: [],
            journal: j,
            order: ["a"],
            drivers: { a: driver },
            settleMs: 0,
            onClock: (arm, ms) => {
                calls.push([arm, ms]);
                return {
                    offset_s: ms / 1000 + 7,
                    offset_wall_ms: 1_000 + ms,
                    offset_settled_ms: 1_000 + ms,
                };
            },
        }).run();
        // The arm's start and every published jump write a ClockOffset; a jump's follows its
        // AdvanceClock, so the journal holds every jump a process could have read.
        const offsets = j.entries.filter((e) => typeof e.offset_s === "number");
        expect(offsets.map((e) => [e.kind, e.scenario_ms, e.offset_s, e.offset_wall_ms])).toEqual(
            calls.map(([, ms]) => ["ClockOffset", ms, ms / 1000 + 7, 1_000 + ms]),
        );
        for (const offset of offsets.slice(1)) {
            const before = j.entries[j.entries.indexOf(offset) - 1];
            expect([before?.kind, before?.scenario_ms]).toEqual([
                "AdvanceClock",
                offset.scenario_ms,
            ]);
        }
        expect(calls[0]).toEqual(["a", 0]);
        expect(calls[1]).toEqual(["a", 5_000]);
        expect(calls.at(-1)?.[1] ?? 0).toBeGreaterThanOrEqual(9_000);
        const jumps = j.entries
            .filter((e) => e.kind === "AdvanceClock")
            .map((e) => ["a", e.scenario_ms]);
        expect(calls.slice(1)).toEqual(jumps as [string, number][]);
        // The offsets are journal entries a later process reads back.
        j.close();
        const reread = new Journal(j.path);
        expect(reread.entries.filter((e) => e.kind === "ClockOffset")).toHaveLength(calls.length);
    });
});

describe("ResourceSampler", () => {
    test("procStats reports RSS and CPU time in the host's units", () => {
        const stats = procStats(process.pid);
        const status = readFileSync(`/proc/${process.pid}/status`, "utf8");
        const rssKb = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1]);
        const tck = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim());
        const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        expect(stats).not.toBeNull();
        expect(Math.abs((stats?.rss ?? 0) - rssKb * 1024)).toBeLessThan(64 * 1024 * 1024);
        expect(Math.abs((stats?.cpuMs ?? 0) - (ticks * 1000) / tck)).toBeLessThan(200);
        expect(procStats(2 ** 22 - 1)).toBeNull();
    });

    test("treeBytes reports a store it cannot read as missing, not empty", () => {
        expect(treeBytes(join(mkdtempSync(join(tmpdir(), "tree-")), "absent"))).toBeNull();
    });

    test("a busy sampler holds busy across a sample with no fraction until idleness is measured", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const events: boolean[] = [];
        let pid: number | null = process.pid;
        const sampler = new ResourceSampler({
            path,
            intervalMs: 50,
            busyFraction: 0.2,
            pid: () => pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: (b) => void events.push(b),
        });
        sampler.sample();
        const until = Date.now() + 150;
        while (Date.now() < until) Math.sqrt(Math.random());
        expect(sampler.sample().cpu_fraction ?? 0).toBeGreaterThan(0.2);
        expect(events).toEqual([true]);
        pid = null;
        expect(sampler.sample().cpu_fraction).toBeNull();
        pid = process.ppid;
        expect(sampler.sample().cpu_fraction).toBeNull();
        expect(events).toEqual([true]);
        await Bun.sleep(50);
        expect(sampler.sample().cpu_fraction ?? 1).toBeLessThan(0.2);
        expect(events).toEqual([true, false]);
        sampler.stop();
        expect(events).toEqual([true, false]);
    });

    test("start() takes the baseline sample at once, and stop() a final one", () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const sampler = new ResourceSampler({
            path,
            intervalMs: 10_000,
            busyFraction: 0.2,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: () => undefined,
        });
        sampler.start();
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
        sampler.stop();
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    });

    test("treeBytes counts regular files under the store and does not follow symlinks", () => {
        const base = mkdtempSync(join(tmpdir(), "tree-"));
        const store = join(base, "store");
        const outside = join(base, "outside");
        mkdirSync(join(store, "sub"), { recursive: true });
        mkdirSync(outside);
        writeFileSync(join(store, "a"), "12345");
        writeFileSync(join(store, "sub", "b"), "123");
        writeFileSync(join(outside, "big"), "x".repeat(1000));
        symlinkSync(outside, join(store, "to-outside"));
        symlinkSync(join(outside, "big"), join(store, "to-big"));
        symlinkSync(store, join(store, "sub", "loop"));
        expect(treeBytes(store)).toBe(8);
    });

    test("a sample for a different PID reports no fraction, and stop() while busy reports idle", () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const events: boolean[] = [];
        let pid = process.pid;
        const sampler = new ResourceSampler({
            path,
            intervalMs: 50,
            busyFraction: 0.2,
            pid: () => pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: (b) => void events.push(b),
        });
        const spin = () => {
            const until = Date.now() + 150;
            while (Date.now() < until) Math.sqrt(Math.random());
        };
        sampler.sample();
        spin();
        pid = process.ppid;
        const restarted = sampler.sample();
        expect(restarted.pid).toBe(process.ppid);
        expect(restarted.cpu_fraction).toBeNull();
        expect(events).toEqual([]);
        pid = process.pid;
        sampler.sample();
        spin();
        expect(sampler.sample().cpu_fraction ?? 0).toBeGreaterThan(0.2);
        expect(events).toEqual([true]);
        sampler.stop();
        expect(events).toEqual([true, false]);
    });

    test("samples a process, writes each sample, and reports busy while CPU use is above the threshold", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const events: boolean[] = [];
        const sampler = new ResourceSampler({
            path,
            intervalMs: 50,
            busyFraction: 0.2,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 42,
            onBusy: (b) => void events.push(b),
        });
        sampler.sample();
        const until = Date.now() + 200;
        while (Date.now() < until) Math.sqrt(Math.random());
        const busy = sampler.sample();
        await Bun.sleep(300);
        const quiet = sampler.sample();
        sampler.stop();
        expect(busy.cpu_fraction ?? 0).toBeGreaterThan(0.2);
        expect(quiet.cpu_fraction ?? 1).toBeLessThan(0.2);
        expect(events).toEqual([true, false]);
        const lines = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatchObject({ scenario_ms: 42, pid: process.pid });
        expect(lines[0].rss).toBeGreaterThan(0);
        expect(lines[0].store_bytes).toBeGreaterThan(0);
    });

    test("a busy callback that throws inside an interval sample still reaches onError once", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const errors: string[] = [];
        const sampler = new ResourceSampler({
            path,
            intervalMs: 20,
            busyFraction: -1,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: () => {
                throw new Error("journal closed");
            },
            onError: (caught) => void errors.push((caught as Error).message),
        });
        sampler.start();
        await Bun.sleep(120);
        expect(errors).toEqual(["journal closed"]);
        expect(() => sampler.stop()).not.toThrow();
    });

    test("a cut final sample is dropped when the sampler reopens its file", () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        writeFileSync(path, '{"wall_ms":1}\n{"wall_ms":2,"sce');
        const sampler = new ResourceSampler({
            path,
            intervalMs: 60_000,
            busyFraction: 0.2,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: () => undefined,
        });
        sampler.sample();
        const lines = readFileSync(path, "utf8").trim().split("\n");
        expect(lines).toHaveLength(2);
        expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
    });

    test("an interval sample that fails reports through onError and stops the timer", async () => {
        const dir = mkdtempSync(join(tmpdir(), "samp-"));
        const errors: string[] = [];
        const sampler = new ResourceSampler({
            path: join(dir, "resources.jsonl"),
            intervalMs: 20,
            busyFraction: 0.2,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: () => undefined,
            onError: (caught) => void errors.push((caught as NodeJS.ErrnoException).code ?? "?"),
        });
        sampler.start();
        rmSync(dir, { recursive: true, force: true });
        await Bun.sleep(120);
        expect(errors).toEqual(["ENOENT"]);
        sampler.stop();
    });

    test("start takes the baseline sample at once, so the next sample yields a CPU fraction", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "samp-")), "resources.jsonl");
        const sampler = new ResourceSampler({
            path,
            intervalMs: 60_000,
            busyFraction: 0.2,
            pid: () => process.pid,
            storeDir: import.meta.dir,
            scenarioMs: () => 0,
            onBusy: () => undefined,
        });
        sampler.start();
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
        await Bun.sleep(20);
        expect(sampler.sample().cpu_fraction).not.toBeNull();
        sampler.stop();
    });
});
