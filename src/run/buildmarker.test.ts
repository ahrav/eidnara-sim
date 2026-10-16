import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuildMarker } from "./buildmarker";

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
