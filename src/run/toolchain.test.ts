import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import {
    SYSTEM_PATH,
    sandboxPath,
    TOOLCHAIN_PROBES,
    toolchainEnv,
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
