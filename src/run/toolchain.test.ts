import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import {
    checkToolchainBins,
    checkToolchainHomes,
    SYSTEM_PATH,
    sandboxPath,
    TOOLCHAIN_PROBES,
    toolchainEnv,
    toolchainProbe,
    versionLine,
    writeToolWrappers,
} from "./toolchain";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const root = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "sim-tools-")));
    dirs.push(d);
    return d;
};

test("each wall-clock tool runs through a wrapper that drops the preload, and cargo is pointed at it", () => {
    const dir = root();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["rustc", "rustdoc"]) writeFileSync(join(bin, tool), "", { mode: 0o755 });
    const base = loadConfig();
    const config = {
        ...base,
        toolchain: { bin: [bin], keep: [bin], env: {}, wall_clock_tools: ["rustc", "rustdoc"] },
    };
    const launcher = join(dir, "sandbox.sh");
    writeToolWrappers(config, launcher);
    const { path, env } = toolchainEnv(config, launcher);
    const toolbin = join(dir, "toolbin");
    expect(path).toBe(`${toolbin}:${bin}`);
    expect(env).toEqual({ RUSTC: join(toolbin, "rustc"), RUSTDOC: join(toolbin, "rustdoc") });
    expect(readFileSync(join(toolbin, "rustc"), "utf8")).toBe(
        `#!/bin/sh\nunset LD_PRELOAD\nexec '${join(bin, "rustc")}' "$@"\n`,
    );
});

test("the rustc probe falls back to PATH when no wrapper defines RUSTC", () => {
    const dir = root();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "rustc"), "#!/bin/sh\necho rustc 1.0.0\n", { mode: 0o755 });
    const script = TOOLCHAIN_PROBES.find(([tool]) => tool === "rustc")?.[1] as string;
    const r = Bun.spawnSync(["/bin/sh", "-c", script], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("rustc 1.0.0\n");
});

test("the probe and the hosts see the configured tools and the system directories only", () => {
    expect(SYSTEM_PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(sandboxPath("/t/bin")).toBe("/t/bin:/usr/local/bin:/usr/bin:/bin");
});

test("a probe is accepted only with the tool's own version line", () => {
    expect(versionLine("cargo", "cargo 1.99.0 (abc 2026-01-01)\n")).toBe(
        "cargo 1.99.0 (abc 2026-01-01)",
    );
    expect(versionLine("rustc", "rustc 1.99.0 (abc)\nbinary: rustc\n")).toBe("rustc 1.99.0 (abc)");
    expect(versionLine("bun", "1.3.14\n")).toBe("1.3.14");
    expect(() => versionLine("cargo", "")).toThrow("toolchain: cargo printed no version");
    expect(() => versionLine("bun", "hello\n")).toThrow("toolchain: bun printed no version");
});

test("every generated wrapper is probed, rustdoc included", () => {
    expect(TOOLCHAIN_PROBES.map(([tool]) => tool)).toEqual(["cargo", "rustc", "rustdoc", "bun"]);
    expect(versionLine("rustdoc", "rustdoc 1.99.0 (abc)\n")).toBe("rustdoc 1.99.0 (abc)");
});

test("a toolchain bin reached through a symlink out of its keep path is refused", () => {
    const dir = root();
    const kept = join(dir, "cache");
    const outside = join(dir, "outside/bin");
    mkdirSync(kept);
    mkdirSync(outside, { recursive: true });
    symlinkSync(join(dir, "outside"), join(kept, "link"));
    const base = loadConfig();
    const config = (bin: string) => ({
        ...base,
        toolchain: { ...base.toolchain, bin: [bin], keep: [kept] },
    });
    expect(() => checkToolchainBins(config(join(kept, "link/bin")))).toThrow(
        `toolchain bin ${join(kept, "link/bin")} resolves outside its keep paths`,
    );
    mkdirSync(join(kept, "bin"));
    expect(() => checkToolchainBins(config(join(kept, "bin")))).not.toThrow();
});

test("any executable in a kept bin that resolves outside the keep paths is refused", () => {
    const dir = root();
    const kept = join(dir, "kept/bin");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(dir, "rustfmt-elsewhere"), "", { mode: 0o755 });
    symlinkSync(join(dir, "rustfmt-elsewhere"), join(kept, "rustfmt"));
    const base = loadConfig();
    const config = {
        ...base,
        toolchain: { ...base.toolchain, bin: [kept], keep: [join(dir, "kept")] },
    };
    expect(() => checkToolchainBins(config)).toThrow(
        `toolchain tool ${join(kept, "rustfmt")} resolves outside its keep paths`,
    );
});

test("a dangling symlink in a kept bin is refused", () => {
    const dir = root();
    const kept = join(dir, "kept/bin");
    mkdirSync(kept, { recursive: true });
    symlinkSync(join(dir, "not-yet"), join(kept, "cargo-x"));
    const base = loadConfig();
    const config = {
        ...base,
        toolchain: { ...base.toolchain, bin: [kept], keep: [join(dir, "kept")] },
    };
    expect(() => checkToolchainBins(config)).toThrow(
        `toolchain tool ${join(kept, "cargo-x")} is a dangling symlink`,
    );
});

test("tool homes and caches must be read-only keeps or private to the sandbox", () => {
    const dir = root();
    const base = loadConfig();
    const kept = join(dir, "kept");
    mkdirSync(join(kept, "cargo"), { recursive: true });
    // /var/tmp is writable and stays shared across sandboxes, unlike the masked home and /tmp.
    const shared = realpathSync(mkdtempSync("/var/tmp/sim-shared-"));
    dirs.push(shared);
    const config = (env: Record<string, string>) => ({
        ...base,
        toolchain: { ...base.toolchain, keep: [kept], env },
    });
    expect(() =>
        checkToolchainHomes(
            config({ CARGO_HOME: join(kept, "cargo"), RUSTUP_HOME: join(homedir(), ".rustup") }),
        ),
    ).not.toThrow();
    expect(() =>
        checkToolchainHomes(config({ CARGO_HOME: join(kept, "cargo"), RUSTUP_HOME: shared })),
    ).toThrow(
        `toolchain.env.RUSTUP_HOME ${shared} is neither kept read-only nor private to the sandbox`,
    );
});

test("the probe runs the configured compiler, whatever RUSTC the harness inherited", async () => {
    const dir = root();
    const bin = join(dir, "bin");
    const ambient = join(dir, "ambient");
    const launcherDir = join(dir, "launcher");
    const clock = join(dir, "clock");
    for (const d of [bin, ambient, launcherDir, clock]) mkdirSync(d);
    const stub = (path: string, line: string) =>
        writeFileSync(path, `#!/bin/sh\necho '${line}'\n`, { mode: 0o755 });
    stub(join(bin, "cargo"), "cargo 1.0.0");
    stub(join(bin, "rustc"), "rustc 1.0.0");
    stub(join(bin, "rustdoc"), "rustdoc 1.0.0");
    stub(join(bin, "bun"), "1.0.0");
    stub(join(ambient, "rustc"), "rustc 9.9.9-ambient");
    // Stands in for the sandbox launcher: applies the --env pairs and runs the command.
    const launcher = join(launcherDir, "sandbox.sh");
    writeFileSync(
        launcher,
        '#!/bin/sh\nwhile [ "$1" != "--env" ]; do shift; done\nshift\n' +
            'envs=""\nwhile [ "$1" != "--" ]; do envs="$envs $1"; shift; done\nshift\n' +
            'exec env $envs "$@"\n',
        { mode: 0o755 },
    );
    const offset = join(clock, "offset");
    writeFileSync(offset, "+0\n");
    const base = loadConfig();
    const config = {
        ...base,
        toolchain: { ...base.toolchain, bin: [bin], keep: [bin], wall_clock_tools: [] },
    };
    const before = process.env.RUSTC;
    process.env.RUSTC = join(ambient, "rustc");
    try {
        const results = await toolchainProbe(config, launcher, offset);
        expect(results.find((r) => r.tool === "rustc")?.version).toBe("rustc 1.0.0");
    } finally {
        if (before === undefined) delete process.env.RUSTC;
        else process.env.RUSTC = before;
    }
});

test("a tool home is accepted only where its configured path and its target share one safe root", () => {
    const dir = root();
    const base = loadConfig();
    const kept = join(dir, "kept");
    mkdirSync(join(kept, "cargo"), { recursive: true });
    const shared = realpathSync(mkdtempSync("/var/tmp/sim-shared-"));
    dirs.push(shared);
    // A link in shared writable space that points into a keep path is still a shared control point.
    symlinkSync(join(kept, "cargo"), join(shared, "cargo"));
    const config = (env: Record<string, string>) => ({
        ...base,
        toolchain: { ...base.toolchain, keep: [kept], env },
    });
    expect(() =>
        checkToolchainHomes(
            config({ CARGO_HOME: join(shared, "cargo"), RUSTUP_HOME: join(kept, "cargo") }),
        ),
    ).toThrow(`toolchain.env.CARGO_HOME ${join(shared, "cargo")} is neither kept read-only`);
    // The home is accepted under both the name the harness sees and its canonical path.
    expect(() =>
        checkToolchainHomes(
            config({
                CARGO_HOME: join(homedir(), ".cargo"),
                RUSTUP_HOME: join(realpathSync(homedir()), ".rustup"),
            }),
        ),
    ).not.toThrow();
});
