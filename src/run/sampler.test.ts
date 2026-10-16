import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal } from "./journal";
import { ResourceSampler } from "./sampler";

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
    const entries = readJournal(path);
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
