import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitedAsExpected, probes } from "./interception";

test("the daemon fixture probe accepts its usage error as a normal exit, other probes need exit 0", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sim-probes-")));
    for (const f of ["node", "opencode", "direct_host_fixture"]) writeFileSync(join(dir, f), "");
    const [pi, , daemon] = probes({
        node: join(dir, "node"),
        opencode: join(dir, "opencode"),
        daemon: join(dir, "direct_host_fixture"),
    });
    const usage =
        'Error: "usage: direct_host_fixture --state-root <path> [--harness-runtime <file>]"\n';
    expect(exitedAsExpected(daemon!, 1, usage)).toBe(true);
    expect(exitedAsExpected(daemon!, 1, "Segmentation fault\n")).toBe(false);
    expect(exitedAsExpected(daemon!, 0, "")).toBe(false);
    expect(exitedAsExpected(pi!, 0, "")).toBe(true);
    expect(exitedAsExpected(pi!, 1, usage)).toBe(false);
});
