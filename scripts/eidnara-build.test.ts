import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "eidnara-build.sh");

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sim-build-")));
    dirs.push(root);
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
    return { root, stubs, src, dst: join(root, "clone") };
}

test("a reused build clone is reset to the fetched commit before building", () => {
    const { stubs, src, dst } = fixture();
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

test("the build refuses a clone path that is the source checkout itself", () => {
    const { stubs, src } = fixture();
    writeFileSync(join(src, "README"), "edited\n");
    const r = build(src, `${src}/`, stubs);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("must be a separate directory");
    expect(readFileSync(join(src, "README"), "utf8")).toBe("edited\n");
});
