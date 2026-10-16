import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** `scripts/eidnara-build.sh` writes the record after its last build step and removes it before the next. */
export function checkBuildMarker(checkout: string): string {
    let recorded: string;
    try {
        recorded = readFileSync(join(checkout, ".sim-build-commit"), "utf8").trim();
    } catch {
        throw new Error(`${checkout}: no completed build recorded; run scripts/eidnara-build.sh`);
    }
    const r = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const head = r.stdout.toString().trim();
    if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) {
        throw new Error(`${checkout}: not a Git checkout (${r.stderr.toString().trim()})`);
    }
    if (recorded !== head) {
        throw new Error(`${checkout}: recorded build ${recorded} differs from HEAD ${head}`);
    }
    return recorded;
}

const FIXTURE = "target/release/examples/direct_host_fixture";

/** The daemon and the plugins come from one commit only when the daemon is the clone's own build output. */
export function checkDaemonFromBuild(checkout: string, daemon: string): string {
    const expected = join(realpathSync(checkout), FIXTURE);
    if (realpathSync(daemon) !== expected) {
        throw new Error(`daemon_binary ${daemon} is not the build clone's ${expected}`);
    }
    return daemon;
}
