import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { DaemonStack } from "./arms";

test("daemon.log holds each daemon output line once; the v1 stack's hostLog repeats stderr from its log file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const daemon = new DaemonStack({
        config: loadConfig(),
        root: dir,
        dataDir: dir,
        logFile,
        offsetFile: join(dir, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logPath, "memory capture output rejected\n");
    const stack = {
        logPath,
        hostLog: () => "ready\nmemory capture output rejected\nmemory capture output rejected\n",
        terminateHost: async () => {},
    };
    const hh = {
        __hermeticHostTest: {
            diagnostics: () => ({
                stdout: "ready\n",
                stderr: "memory capture output rejected\n",
                retainedLog: "memory capture output rejected\n",
            }),
        },
    };
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.stop();
    expect(readFileSync(logFile, "utf8")).toBe("ready\nmemory capture output rejected\n");
});

test("daemon.log keeps the whole stderr of a lifetime, past the 256 KiB tail the stack retains in memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const logPath = join(dir, "direct-host.log");
    const refusal = "daemon: memory capture output rejected\n";
    const filler = `${"x".repeat(1023)}\n`.repeat(300);
    writeFileSync(logPath, `${refusal}${filler}`);
    const daemon = new DaemonStack({
        config: loadConfig(),
        root: dir,
        dataDir: dir,
        logFile,
        offsetFile: join(dir, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    });
    const stack = { logPath, terminateHost: async () => {} };
    const hh = {
        __hermeticHostTest: {
            diagnostics: () => ({
                stdout: "ready\n",
                stderr: filler.slice(-(256 * 1024)),
                retainedLog: filler.slice(-(256 * 1024)),
            }),
        },
    };
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.stop();
    const saved = readFileSync(logFile, "utf8");
    expect(saved.startsWith("ready\n")).toBe(true);
    expect(saved).toContain(refusal);
    expect(saved.length).toBe("ready\n".length + refusal.length + filler.length);
});
