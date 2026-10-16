import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { toolchainEnv, writeToolWrappers } from "./toolchain";

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
