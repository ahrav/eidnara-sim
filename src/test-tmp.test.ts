import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PREFIX, TEST_TMP } from "../tests/preload";

const PRELOAD = join(import.meta.dir, "..", "tests", "preload.ts");

test("the suite's temporary directory is the one the preload removes", () => {
    expect(tmpdir()).toBe(TEST_TMP);
    expect(basename(TEST_TMP).startsWith(`${PREFIX}${process.pid}-`)).toBe(true);
    const made = mkdtempSync(join(tmpdir(), "sim-run-"));
    expect(made.startsWith(`${TEST_TMP}/`)).toBe(true);
});

test("a suite removes its own directory and one a dead suite left behind", () => {
    const base = mkdtempSync(join(tmpdir(), "preload-base-"));
    const dead = Bun.spawnSync(["true"]).pid;
    const stale = join(base, `${PREFIX}${dead}-left`);
    mkdirSync(join(stale, "sim-run-x"), { recursive: true });
    const other = join(base, "unrelated");
    mkdirSync(other);
    const file = join(base, "probe.test.ts");
    writeFileSync(
        file,
        [
            'import { test } from "bun:test";',
            'import { mkdtempSync, writeFileSync } from "node:fs";',
            'import { tmpdir } from "node:os";',
            'import { join } from "node:path";',
            'test("leaks", () => {',
            '    const d = mkdtempSync(join(tmpdir(), "sim-report-"));',
            '    writeFileSync(join(d, "x"), "x");',
            `    writeFileSync(${JSON.stringify(join(base, "seen"))}, tmpdir());`,
            "});",
            "",
        ].join("\n"),
    );
    const child = Bun.spawnSync(["bun", "test", "--preload", PRELOAD, file], {
        cwd: base,
        env: { ...process.env, SIM_TEST_TMP_BASE: base },
    });
    expect(child.exitCode).toBe(0);
    const seen = Bun.file(join(base, "seen"));
    expect(seen.size).toBeGreaterThan(0);
    const left = readdirSync(base).sort();
    expect(left).toEqual(["probe.test.ts", "seen", "unrelated"]);
});
