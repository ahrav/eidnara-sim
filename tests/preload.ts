import { afterAll } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `bunfig.toml` preloads this module; tests and the child processes they spawn that call
 * `tmpdir()` after initialization use `TEST_TMP`, which the global `afterAll` removes. A later
 * suite removes a `sim-test-<pid>-` directory whose pid no longer runs.
 */
export const PREFIX = "sim-test-";
const base = process.env.SIM_TEST_TMP_BASE ?? tmpdir();

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (caught) {
        return (caught as NodeJS.ErrnoException).code === "EPERM";
    }
}

for (const name of readdirSync(base)) {
    const pid = Number(/^sim-test-(\d+)-/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || alive(pid)) continue;
    const path = join(base, name);
    if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        try {
            rmSync(path, { recursive: true, force: true });
        } catch (caught) {
            console.error(`stale test temp ${path} left in place: ${(caught as Error).message}`);
        }
    }
}

export const TEST_TMP = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
process.env.SIM_TEST_TMP_BASE = base;
process.env.TMPDIR = TEST_TMP;

afterAll(() => {
    try {
        rmSync(TEST_TMP, { recursive: true, force: true });
    } catch (caught) {
        console.error(`test temp ${TEST_TMP} left in place: ${(caught as Error).message}`);
    }
});
