import { expect, test } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { processStart, running } from "../run/procs";
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
    expect(readFileSync(logFile, "utf8")).toBe("memory capture output rejected\nready\n");
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
    expect(saved.endsWith("ready\n")).toBe(true);
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
    await killed.recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe("daemon: memory capture output rejected\n");
    expect(existsSync(logPath)).toBe(false);
    await killed.recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe("daemon: memory capture output rejected\n");
    writeFileSync(logPath, "second lifetime\n");
    first.noteLogSource();
    await first.stop();
    expect(readFileSync(logFile, "utf8")).toBe(
        "daemon: memory capture output rejected\nsecond lifetime\n",
    );
    expect(existsSync(logPath)).toBe(false);
    await new DaemonStack(ctx).recoverLog();
    expect(readFileSync(logFile, "utf8")).toBe(
        "daemon: memory capture output rejected\nsecond lifetime\n",
    );
});

test("the recovery marker outlives the copy, so a kill during recovery leaves the log findable", async () => {
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
    await expect(daemon.recoverLog()).rejects.toThrow();
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
        owner: null,
    });
});

test("a recovery interrupted mid-copy rolls back the partial append before copying again", async () => {
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
    await new DaemonStack(stackCtx(dir)).recoverLog();
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
    await new DaemonStack(stackCtx(dir)).recoverLog();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("old lifetime\nnew lifetime\n");
    expect(existsSync(marker)).toBe(false);
});

test("the marker leaves the copying state before the saved source is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const logPath = join(locked, "direct-host.log");
    writeFileSync(logPath, "daemon: memory capture output rejected\n");
    writeFileSync(`${logFile}.source`, JSON.stringify({ pending: [logPath], copying: null }));
    chmodSync(locked, 0o555);
    try {
        await expect(new DaemonStack(stackCtx(dir)).recoverLog()).rejects.toThrow();
        expect(readFileSync(logFile, "utf8")).toBe("daemon: memory capture output rejected\n");
        expect(JSON.parse(readFileSync(`${logFile}.source`, "utf8")).copying).toBeNull();
    } finally {
        chmodSync(locked, 0o755);
    }
});

test("a stop after a failed restart saves every log the marker still lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logPath, "old lifetime\n");
    const stack = {
        logPath,
        restartHost: async () => {
            rmSync(logPath);
            writeFileSync(logPath, "new lifetime\n");
            throw new Error("replacement daemon never became ready");
        },
        terminateHost: async () => {},
    };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout: "", stderr: "", retainedLog: "" }) },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await expect(daemon.restart()).rejects.toThrow("never became ready");
    await daemon.stop();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("old lifetime\nnew lifetime\n");
    expect(existsSync(join(dir, "daemon.log.held"))).toBe(false);
    expect(existsSync(join(dir, "daemon.log.source"))).toBe(false);
});

test("stdout the daemon wrote while handling SIGTERM is saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logPath, "");
    let stdout = "ready\n";
    const stack = {
        logPath,
        terminateHost: async () => {
            stdout += "daemon: memory capture output rejected\n";
        },
    };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout, stderr: "", retainedLog: "" }) },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.stop();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe(
        "ready\ndaemon: memory capture output rejected\n",
    );
});

test("recovery stops a daemon the marker still names as live before saving its log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logPath, "still writing\n");
    const child = Bun.spawn(["sleep", "60"]);
    const start = processStart(child.pid);
    writeFileSync(
        join(dir, "daemon.log.source"),
        JSON.stringify({ pending: [logPath], copying: null, owner: { pid: child.pid, start } }),
    );
    await new DaemonStack(stackCtx(dir)).recoverLog();
    expect(running(child.pid)).toBe(false);
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("still writing\n");
});

test("a stop rolls back and saves a copy that failed mid-way before the live log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const held = join(dir, "daemon.log.held");
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logFile, "earlier\n");
    writeFileSync(held, "held lifetime\n");
    writeFileSync(logPath, "live lifetime\n");
    appendFileSync(logFile, "held lif");
    writeFileSync(
        `${logFile}.source`,
        JSON.stringify({
            pending: [logPath],
            copying: { source: held, target_bytes: "earlier\n".length },
        }),
    );
    const stack = { logPath, terminateHost: async () => {} };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout: "", stderr: "", retainedLog: "" }) },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.stop();
    expect(readFileSync(logFile, "utf8")).toBe("earlier\nheld lifetime\nlive lifetime\n");
    expect(existsSync(held)).toBe(false);
    expect(existsSync(`${logFile}.source`)).toBe(false);
});

test("recovery saves two names of one inode once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    const held = join(dir, "daemon.log.held");
    writeFileSync(logPath, "one lifetime\n");
    linkSync(logPath, held);
    writeFileSync(
        join(dir, "daemon.log.source"),
        JSON.stringify({ pending: [held, logPath], copying: null }),
    );
    await new DaemonStack(stackCtx(dir)).recoverLog();
    expect(readFileSync(join(dir, "daemon.log"), "utf8")).toBe("one lifetime\n");
    expect(existsSync(held)).toBe(false);
    expect(existsSync(logPath)).toBe(false);
});

test("a stop keeps the shutdown stdout when it rolls back an interrupted copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logFile = join(dir, "daemon.log");
    const held = join(dir, "daemon.log.held");
    const logPath = join(dir, "direct-host.log");
    writeFileSync(logFile, "earlier\n");
    writeFileSync(held, "held lifetime\n");
    writeFileSync(logPath, "live lifetime\n");
    appendFileSync(logFile, "held lif");
    writeFileSync(
        `${logFile}.source`,
        JSON.stringify({
            pending: [logPath],
            copying: { source: held, target_bytes: "earlier\n".length },
        }),
    );
    const stack = { logPath, terminateHost: async () => {} };
    const hh = {
        __hermeticHostTest: {
            diagnostics: () => ({
                stdout: "daemon: memory capture output rejected\n",
                stderr: "",
                retainedLog: "",
            }),
        },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, { stack, hh });
    await daemon.stop();
    const saved = readFileSync(logFile, "utf8");
    expect(saved).toContain("daemon: memory capture output rejected\n");
    expect(saved).toContain("held lifetime\n");
    expect(saved).toContain("live lifetime\n");
    expect(saved).not.toContain("held lif\n");
});

test("every marker written during a restart keeps the daemon owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    const logPath = join(dir, "direct-host.log");
    const marker = join(dir, "daemon.log.source");
    writeFileSync(logPath, "old\n");
    const owners: unknown[] = [];
    const stack = {
        logPath,
        restartHost: async () => {
            rmSync(logPath);
            writeFileSync(logPath, "new\n");
        },
    };
    const hh = {
        __hermeticHostTest: { diagnostics: () => ({ stdout: "", stderr: "", retainedLog: "" }) },
    };
    const daemon = new DaemonStack(stackCtx(dir));
    Object.assign(daemon as unknown as Record<string, unknown>, {
        stack,
        hh,
        pid: () => process.pid,
        writeMarker: (m: { owner?: unknown }) => {
            owners.push(m.owner ?? null);
            const tmp = `${marker}.tmp`;
            writeFileSync(tmp, JSON.stringify(m));
            renameSync(tmp, marker);
        },
    });
    await daemon.restart();
    expect(owners.length).toBeGreaterThan(2);
    expect(owners.every((o) => o !== null)).toBe(true);
});
