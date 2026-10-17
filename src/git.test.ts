import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBound, GitOverflow, git } from "./git";

test("git output past the cap is a bounded failure, distinct from a plain error", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-git-"));
    git(dir, ["init", "-q"]);
    expect(() => git(dir, ["help", "-a"], {}, undefined, 64)).toThrow(GitOverflow);
    try {
        git(dir, ["help", "-a"], {}, undefined, 64);
    } catch (caught) {
        expect(caught).toBeInstanceOf(GitBound);
        expect(String(caught)).toContain("output passed 64 bytes");
    }
    expect(() => git(dir, ["no-such-command"])).not.toThrow(GitBound);
});
