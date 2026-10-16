import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import * as procs from "../run/procs";
import { HostDriver } from "./driver";

const stopped: number[] = [];
const starts: Array<string | null> = [];
const spies = [
    spyOn(procs, "running").mockReturnValue(true),
    spyOn(procs, "processStart").mockReturnValue("1"),
    spyOn(procs, "stopOwnedTree").mockImplementation(
        async (pid: number, _grace: number, start?: string) => {
            stopped.push(pid);
            starts.push(start ?? null);
            return pid !== 4_000_000;
        },
    ),
];
afterAll(() => {
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

test("a recorded process that survives is reported after every other recorded process is tried", async () => {
    const root = mkdtempSync(join(tmpdir(), "sim-reap-"));
    try {
        const armDir = join(root, "eidnara");
        mkdirSync(armDir, { recursive: true });
        const state = {
            model: 0,
            daemon: { pid: 4_000_001, start: "1" },
            host: { pid: 4_000_000, start: "1" },
        };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const driver = new HostDriver({
            config: loadConfig(),
            arm: "eidnara",
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
            onDaemonExit: () => undefined,
        });
        stopped.length = 0;
        await expect(driver.reap()).rejects.toThrow("survived");
        expect(stopped).toEqual([4_000_000, 4_000_001]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the reaper stops the recorded host before the recorded daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "sim-reap-"));
    try {
        const armDir = join(root, "eidnara");
        mkdirSync(armDir, { recursive: true });
        const state = {
            model: 0,
            daemon: { pid: 4_000_001, start: "1" },
            host: { pid: 4_000_002, start: "1" },
        };
        writeFileSync(join(armDir, "state.json"), JSON.stringify(state));
        const driver = new HostDriver({
            config: loadConfig(),
            arm: "eidnara",
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
            onDaemonExit: () => undefined,
        });
        stopped.length = 0;
        starts.length = 0;
        await driver.reap();
        expect(stopped).toEqual([4_000_002, 4_000_001]);
        expect(starts).toEqual(["1", "1"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
