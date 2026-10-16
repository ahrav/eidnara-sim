import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitedAsExpected, probes } from "./interception";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
}

test("the daemon fixture probe accepts its usage error as a normal exit, other probes need exit 0", () => {
    const dir = tempDir("sim-probes-");
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

test("the Pi probe keeps the same directory the live host keeps for a standalone node", () => {
    const dir = tempDir("sim-probes-");
    mkdirSync(join(dir, "opt"));
    writeFileSync(join(dir, "opt/node"), "");
    mkdirSync(join(dir, "install/bin"), { recursive: true });
    writeFileSync(join(dir, "install/bin/node"), "");
    for (const f of ["opencode", "direct_host_fixture"]) writeFileSync(join(dir, f), "");
    const rest = { opencode: join(dir, "opencode"), daemon: join(dir, "direct_host_fixture") };
    expect(probes({ node: join(dir, "opt/node"), ...rest })[0]?.keep).toEqual([join(dir, "opt")]);
    expect(probes({ node: join(dir, "install/bin/node"), ...rest })[0]?.keep).toEqual([
        join(dir, "install"),
    ]);
});
