import { expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
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

test("the recovery marker outlives the copy, so a kill during recovery leaves the log findable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const logPath = join(dir, "direct-host.log");
    mkdirSync(logFile);
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
    writeFileSync(`${logFile}.source`, JSON.stringify({ pending: [logPath], copying: null }));
    writeFileSync(logPath, "daemon: memory capture output rejected\n");
    expect(() => daemon.recoverLog()).toThrow();
    expect(existsSync(`${logFile}.source`)).toBe(true);
    expect(existsSync(logPath)).toBe(true);
});

function stackCtx(dir: string) {
    return {
        config: loadConfig(),
        root: dir,
        dataDir: dir,
        logFile: join(dir, "daemon.log"),
        offsetFile: join(dir, "offset"),
        proxyHttp1: "",
        proxyHttp2: "",
        model: "m",
    };
}

test("a restart saves what the old daemon wrote up to its death, after the stack has replaced the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logPath, "before\n");
    const stack = {
        logPath,
        restartHost: async () => {
            appendFileSync(logPath, "daemon: memory capture output rejected\n");
            rmSync(logPath);
            writeFileSync(logPath, "new lifetime\n");
        },
    };
    const hh = {
        __hermeticHostTest: {
            diagnostics: () => ({ stdout: "out\n", stderr: "", retainedLog: "" }),
        },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.restart();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe(
        "out\nbefore\ndaemon: memory capture output rejected\n",
    );
    expect(readFileSync(logPath, "utf8")).toBe("new lifetime\n");
    expect(JSON.parse(readFileSync(join(dir, "daemon.log.source"), "utf8"))).toEqual({
        pending: [logPath],
        copying: null,
    });
});

test("a recovery interrupted mid-copy rolls back the partial append before copying again", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logFile, "earlier lifetime\n");
    writeFileSync(logPath, "daemon: memory capture output rejected\nrest\n");
    writeFileSync(
        `${logFile}.source`,
        JSON.stringify({
            pending: [],
            copying: { source: logPath, target_bytes: "earlier lifetime\n".length },
        }),
    );
    appendFileSync(logFile, "daemon: memory capture output rej");
    new DaemonStack(stackCtx(dir)).recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe(
        "earlier lifetime\ndaemon: memory capture output rejected\nrest\n",
    );
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(`${logFile}.source`)).toBe(false);
});

test("the recovery marker names the held and the live log through a restart, so a kill at any point loses neither", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    const marker = join(dir, "daemon.log.source");
    writeFileSync(logPath, "old lifetime\n");
    let seen: string[] = [];
    const stack = {
        logPath,
        restartHost: async () => {
            seen = JSON.parse(readFileSync(marker, "utf8")).pending;
            rmSync(logPath);
            writeFileSync(logPath, "new lifetime\n");
        },
    };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout: "", stderr: "", retainedLog: "" }) },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.restart();
    expect(seen).toEqual([join(dir, "daemon.log.held"), logPath]);
    expect(JSON.parse(readFileSync(marker, "utf8")).pending).toEqual([logPath]);
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("old lifetime\n");
    new DaemonStack(stackCtx(dir)).recoverLog();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("old lifetime\nnew lifetime\n");
    expect(existsSync(marker)).toBe(false);
});
