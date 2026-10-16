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

function build(src: string, dst: string, stubs: string, cwd?: string) {
    return Bun.spawnSync(["bash", SCRIPT, src, dst], {
        cwd,
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

test("the build refuses a clone path beneath the source checkout", () => {
    const { stubs, src } = fixture();
    const r = build(src, join(src, "build-clone"), stubs);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("must be a separate directory");
    expect(existsSync(join(src, "build-clone"))).toBe(false);
});

test("the build refuses to reuse a repository it did not clone", () => {
    const { stubs, src, root } = fixture();
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "mine.txt"), "theirs\n");
    git(other, "init", "--quiet");
    git(other, "add", ".");
    git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "other");
    const head = git(other, "rev-parse", "HEAD");
    const r = build(src, other, stubs);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("was not cloned by this script");
    expect(git(other, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(other, "mine.txt"), "utf8")).toBe("theirs\n");
});

test("a successful build records its commit, and a failed one leaves no record", () => {
    const { stubs, src, dst } = fixture();
    expect(build(src, dst, stubs).exitCode).toBe(0);
    const head = git(src, "rev-parse", "HEAD");
    expect(readFileSync(join(dst, ".sim-build-commit"), "utf8").trim()).toBe(head);
    writeFileSync(join(stubs, "cargo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(build(src, dst, stubs).exitCode).not.toBe(0);
    expect(existsSync(join(dst, ".sim-build-commit"))).toBe(false);
});

test("a relative clone path records the build in the clone", () => {
    const { stubs, src, root } = fixture();
    const r = build(src, "rel-clone", stubs, root);
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(root, "rel-clone/.sim-build-commit"), "utf8").trim()).toBe(
        git(src, "rev-parse", "HEAD"),
    );
});
