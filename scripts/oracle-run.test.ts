import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirs } from "./oracle-run";

test("a run directory named twice, directly or through a symlink, is one run", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-oracle-run-"));
    const run = join(root, "run");
    const alias = join(root, "alias");
    mkdirSync(run);
    symlinkSync(run, alias);
    expect(runDirs([run, `${run}/`, alias])).toEqual([run]);
});
