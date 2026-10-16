import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
