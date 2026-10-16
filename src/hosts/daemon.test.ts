import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    const filler = `${"x".repeat(1023)}\n`.repeat(3_000);
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

test("a lifetime's stderr log left by a harness kill is saved before the next daemon starts, and a clean stop leaves none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const logPath = join(dir, "direct-host.log");
    const ctx = {
        config: loadConfig(),
        root: dir,
        dataDir: dir,
        logFile,
        offsetFile: join(dir, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout: "", stderr: "", retainedLog: "" }) },
    };
    const first = new DaemonStack(ctx);
    Object.assign(first as unknown as Record<string, unknown>, {
        stack: { logPath, terminateHost: async () => {} },
        hh,
    });
    writeFileSync(logPath, "daemon: memory capture output rejected\n");
    first.noteLogSource();
    const killed = new DaemonStack(ctx);
    killed.recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe("daemon: memory capture output rejected\n");
    expect(existsSync(logPath)).toBe(false);
    killed.recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe("daemon: memory capture output rejected\n");
    writeFileSync(logPath, "second lifetime\n");
    first.noteLogSource();
    await first.stop();
    expect(readFileSync(logFile, "utf8")).toBe(
        "daemon: memory capture output rejected\nsecond lifetime\n",
    );
    expect(existsSync(logPath)).toBe(false);
    new DaemonStack(ctx).recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe(
        "daemon: memory capture output rejected\nsecond lifetime\n",
    );
});
