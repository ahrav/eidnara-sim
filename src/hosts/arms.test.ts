import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStack } from "./arms";

test("stop saves the daemon's output through its graceful exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "sim-daemon-"));
    try {
        const logFile = join(root, "daemon.log");
        const daemon = new DaemonStack({ logFile } as ConstructorParameters<typeof DaemonStack>[0]);
        let log = "booted\n";
        (daemon as unknown as { stack: unknown }).stack = {
            hostLog: () => log,
            terminateHost: async () => {
                log += "shutting down cleanly\n";
            },
        };
        await daemon.stop();
        expect(readFileSync(logFile, "utf8")).toBe("booted\nshutting down cleanly\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
