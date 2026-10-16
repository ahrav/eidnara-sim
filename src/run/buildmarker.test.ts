import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuildMarker, checkDaemonFromBuild } from "./buildmarker";

function repo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sim-marker-")));
    const git = (...args: string[]) => {
        const r = Bun.spawnSync(["git", "-C", dir, ...args]);
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    };
    writeFileSync(join(dir, "a"), "a\n");
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one");
    return dir;
}

test("a build clone passes preflight only with a commit record that matches its HEAD", () => {
    const dir = repo();
    const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(() => checkBuildMarker(dir)).toThrow(/no completed build/);
    writeFileSync(join(dir, ".sim-build-commit"), `${"0".repeat(40)}\n`);
    expect(() => checkBuildMarker(dir)).toThrow(/HEAD/);
    writeFileSync(join(dir, ".sim-build-commit"), `${head}\n`);
    expect(checkBuildMarker(dir)).toBe(head);
});

test("the daemon binary must be the build clone's own fixture", () => {
    const clone = repo();
    const other = repo();
    for (const dir of [clone, other]) {
        mkdirSync(join(dir, "target/release/examples"), { recursive: true });
        writeFileSync(join(dir, "target/release/examples/direct_host_fixture"), "");
    }
    const fixture = (dir: string) => join(dir, "target/release/examples/direct_host_fixture");
    expect(() => checkDaemonFromBuild(clone, fixture(other))).toThrow(/not the build clone's/);
    expect(checkDaemonFromBuild(clone, fixture(clone))).toBe(fixture(clone));
});

test("a directory that is not a Git checkout fails the build check even with an empty record", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sim-marker-")));
    writeFileSync(join(dir, ".sim-build-commit"), "");
    expect(() => checkBuildMarker(dir)).toThrow(/not a Git checkout|no completed build/);
});
