import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
    const stack = {
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
