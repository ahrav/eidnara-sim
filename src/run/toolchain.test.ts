import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { TOOLCHAIN_PROBES, toolchainEnv, writeToolWrappers } from "./toolchain";

test("each wall-clock tool runs through a wrapper that drops the preload, and cargo is pointed at it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sim-tools-")));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["rustc", "rustdoc"]) writeFileSync(join(bin, tool), "", { mode: 0o755 });
    const base = loadConfig();
    const config = {
        ...base,
        toolchain: { bin: [bin], keep: [bin], env: {}, wall_clock_tools: ["rustc", "rustdoc"] },
    };
    const launcher = join(root, "sandbox.sh");
    writeToolWrappers(config, launcher);
    const { path, env } = toolchainEnv(config, launcher);
    const toolbin = join(root, "toolbin");
    expect(path).toBe(`${toolbin}:${bin}`);
    expect(env).toEqual({ RUSTC: join(toolbin, "rustc"), RUSTDOC: join(toolbin, "rustdoc") });
    expect(readFileSync(join(toolbin, "rustc"), "utf8")).toBe(
        `#!/bin/sh\nunset LD_PRELOAD\nexec '${join(bin, "rustc")}' "$@"\n`,
    );
});

test("the rustc probe falls back to PATH when no wrapper defines RUSTC", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sim-tools-")));
    const bin = join(root, "bin");
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
