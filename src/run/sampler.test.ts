import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl } from "./journal";
import { processStart } from "./procs";
import { pageBytes, procStats, ResourceSampler } from "./sampler";

test("start takes RSS(0) at once instead of waiting for the first interval", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    sampler.start();
    sampler.stop();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}");
    expect(first.scenario_ms).toBe(7);
    expect(first.rss).toBeGreaterThan(0);
});

test("stop takes a final sample while the daemon is still alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    sampler.stop();
    sampler.stop();
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});

test("start drops a sample line a kill cut, so the resumed file stays readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    writeFileSync(path, `${JSON.stringify({ scenario_ms: 1, rss: 5 })}\n{"scenario_ms": 2, "rs`);
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    sampler.stop();
    const entries = readJsonl<{ scenario_ms: number }>(path);
    expect(entries.map((e) => e.scenario_ms)).toEqual([1, 7, 7]);
});

test("a final sample that cannot be written fails stop, so the run does not end as complete evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    rmSync(dir, { recursive: true, force: true });
    expect(() => sampler.stop()).toThrow();
});

test("the final sample reports no busy transition after stop has cleared the busy state", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const busy: boolean[] = [];
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: -1,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: (b) => void busy.push(b),
    });
    sampler.start();
    const spin = Date.now() + 20;
    while (Date.now() < spin) {}
    sampler.stop();
    expect(busy.at(-1) ?? false).toBe(false);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});

test("a sample names the daemon's process start time alongside its pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => process.pid,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    sampler.stop();
    const first = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "{}");
    expect(first.pid).toBe(process.pid);
    expect(first.start).toBe(processStart(process.pid));
});

test("RSS is read in bytes using the host's page size", () => {
    const page = Number(Bun.spawnSync(["getconf", "PAGESIZE"]).stdout.toString().trim());
    expect(pageBytes()).toBe(page);
    const stats = procStats(process.pid);
    expect(stats).not.toBeNull();
    expect((stats?.rss ?? 0) % page).toBe(0);
    expect(stats?.rss ?? 0).toBeGreaterThan(page);
});

test("procStats reads the process start time from the same /proc snapshot as RSS", () => {
    const stats = procStats(process.pid);
    expect(stats?.start ?? null).toBe(processStart(process.pid) ?? "");
});

test("a sample whose process vanished between the pid read and the snapshot carries a null pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => 2_147_483_000,
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    const sample = sampler.sample();
    expect(sample.rss).toBeNull();
    expect(sample.pid).toBeNull();
    expect(sample.start).toBeNull();
});

test("a CPU baseline belongs to one process lifetime, so a reused pid starts a fresh baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-sampler-"));
    const path = join(dir, "resources.jsonl");
    let start = "100";
    const sampler = new ResourceSampler({
        path,
        intervalMs: 60_000,
        busyFraction: 0.5,
        pid: () => 7,
        stats: () => ({ rss: 4096, cpuMs: start === "100" ? 5_000_000 : 0, start }),
        storeDir: dir,
        scenarioMs: () => 7,
        onBusy: () => {},
    });
    sampler.start();
    start = "200";
    const spin = Date.now() + 5;
    while (Date.now() < spin) {}
    sampler.observe();
    sampler.stop();
    const lines = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.start)).toEqual(["100", "200", "200"]);
    expect(lines[1]?.cpu_fraction).toBeNull();
});
