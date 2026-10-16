import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import * as procs from "../run/procs";
import { HostDriver } from "./driver";

const spies = [
    spyOn(procs, "running").mockReturnValue(true),
    spyOn(procs, "processStart").mockReturnValue("1"),
    spyOn(procs, "stopOwnedTree").mockResolvedValue(false),
];
afterEach(() => {
    for (const s of spies) s.mockRestore();
});

test("resume stops when a recorded process survives the reaper", async () => {
    const root = mkdtempSync(join(tmpdir(), "sim-reap-"));
    try {
        const armDir = join(root, "host");
        mkdirSync(armDir, { recursive: true });
        const state = { model: 0, daemon: null, host: { pid: 4_000_000, start: "1" } };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const driver = new HostDriver({
            config: loadConfig(),
            arm: "host",
            host: "pi",
            armRoot: join(armDir, "r"),
            launcher: "/bin/false",
            offsetFile: join(root, "offset"),
            keep: [],
            proxyHttp1: "http://127.0.0.1:1",
            proxyHttp2: "http://127.0.0.1:2",
            contextLimit: 200_000,
            projects: {},
            models: ["m"],
            turnDeadlineMs: 1_000,
            transcriptPaths: [],
            loopStore: false,
            baseMs: 0,
            hostFactory: () => {
                throw new Error("a replacement host was started over the survivor");
            },
            onDaemonExit: () => undefined,
        });
        await expect(driver.resume(null)).rejects.toThrow("survived");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
