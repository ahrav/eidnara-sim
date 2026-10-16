import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
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
import { ResourceSampler } from "./sampler";
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
        writeOffset(file, 10_000_000, 3_600_000, 10_000_000);
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
        expect(() => launch("/x/sandbox.sh", [], { A: "x y" }, ["true"])).toThrow(/plain word/);
        expect(launch("/x/sandbox.sh", ["/k"], { A: "1" }, ["true"], ["/r"])).toEqual([
            "/x/sandbox.sh",
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
        expect(transcriptPaths("opencode", "1.19.0")).toHaveLength(2);
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
        "a binary that drops the interposer is recorded wall-clock-only",
        () => {
            const root = runRoot();
            const [pi] = probes({
                node: realpathSync(Bun.which("node") ?? "node"),
                opencode: "/bin/true",
                daemon: "/bin/true",
            });
            const stripped: BinaryProbe = {
                ...(pi as BinaryProbe),
                argv: ["/usr/bin/env", "-u", "LD_PRELOAD", ...(pi as BinaryProbe).argv],
            };
            const [result] = interceptionTest(writeLauncher(root), root, [stripped]);
            expect(result?.intercepted).toBe(false);
            expect(result?.wall_clock_only).toBe(true);
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
            onClock: (arm, ms) => void calls.push([arm, ms]),
        }).run();
        expect(calls[0]).toEqual(["a", 0]);
        expect(calls[1]).toEqual(["a", 5_000]);
        expect(calls.at(-1)?.[1] ?? 0).toBeGreaterThanOrEqual(9_000);
        const jumps = j.entries
            .filter((e) => e.kind === "AdvanceClock")
            .map((e) => ["a", e.scenario_ms]);
        expect(calls.slice(1)).toEqual(jumps as [string, number][]);
    });
});

describe("ResourceSampler", () => {
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
