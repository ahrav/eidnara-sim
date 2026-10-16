import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "eidnara-build.sh");

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
}

function build(src: string, dst: string, stubs: string) {
    return Bun.spawnSync(["bash", SCRIPT, src, dst], {
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("a reused build clone is reset to the fetched commit before building", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sim-build-")));
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    for (const tool of ["bun", "cargo"])
        writeFileSync(join(stubs, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const src = join(root, "src");
    for (const pkg of ["shm-native", "pi-plugin", "opencode-plugin"]) {
        mkdirSync(join(src, "packages", pkg), { recursive: true });
        writeFileSync(join(src, "packages", pkg, "package.json"), "{}\n");
    }
    writeFileSync(join(src, "README"), "one\n");
    git(src, "init", "--quiet");
    git(src, "add", ".");
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "fixture");
    const dst = join(root, "clone");

    const first = build(src, dst, stubs);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString().trim()).toBe(git(src, "rev-parse", "HEAD"));

    writeFileSync(join(dst, "README"), "edited\n");
    writeFileSync(join(dst, "stray.txt"), "left behind\n");
    const second = build(src, dst, stubs);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(join(dst, "README"), "utf8")).toBe("one\n");
    expect(existsSync(join(dst, "stray.txt"))).toBe(false);
});
