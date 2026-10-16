import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SimConfig } from "../config/config";
import { withDeadline } from "./deadline";
import { launch, shellQuote } from "./launcher";
import { stopOwnedTree } from "./procs";
import { FAKETIME_LIB, faketimeEnv } from "./timeinject";

export interface ToolchainProbe {
    tool: string;
    version: string;
}

/** `RUSTC` names a wall-clock wrapper only when the config asks for one; cargo falls back the same way. */
export const TOOLCHAIN_PROBES: [string, string][] = [
    ["cargo", "exec cargo --version"],
    ["rustc", 'exec "${RUSTC:-rustc}" -vV'],
    ["bun", "exec bun --version"],
];

export const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

/** The PATH sandboxed hosts and the toolchain probe share: the configured tools, then the system directories. */
export const sandboxPath = (tools: string) => `${tools}:${SYSTEM_PATH}`;

export const toolbinDir = (launcher: string) => join(dirname(launcher), "toolbin");

function locate(config: SimConfig, tool: string): string {
    const path = config.toolchain.bin.map((dir) => join(dir, tool)).find((p) => existsSync(p));
    if (!path) throw new Error(`toolchain: no ${tool} in ${config.toolchain.bin.join(", ")}`);
    return path;
}

export function writeToolWrappers(config: SimConfig, launcher: string): void {
    const dir = toolbinDir(launcher);
    mkdirSync(dir, { recursive: true });
    for (const tool of config.toolchain.wall_clock_tools) {
        const script = `#!/bin/sh\nunset LD_PRELOAD\nexec ${shellQuote(locate(config, tool))} "$@"\n`;
        writeFileSync(join(dir, tool), script, { mode: 0o755 });
    }
}

export function toolchainEnv(
    config: SimConfig,
    launcher: string,
): { path: string; env: Record<string, string> } {
    const dir = toolbinDir(launcher);
    const env = { ...config.toolchain.env };
    for (const tool of config.toolchain.wall_clock_tools) {
        if (tool === "rustc" || tool === "rustdoc") env[tool.toUpperCase()] = join(dir, tool);
    }
    return { path: [dir, ...config.toolchain.bin].join(":"), env };
}

async function probe(argv: string[], path: string): Promise<{ ok: boolean; out: string }> {
    const child = Bun.spawn(argv, {
        env: { ...process.env, PATH: sandboxPath(path) },
        stdout: "pipe",
        stderr: "pipe",
    });
    const code = await withDeadline(child.exited, 60_000);
    if (code === null) {
        const stopped = await stopOwnedTree(child.pid, 2_000);
        return {
            ok: false,
            out: stopped ? "no exit after 60 s" : "no exit after 60 s; its tree survived SIGKILL",
        };
    }
    const out = await new Response(code === 0 ? child.stdout : child.stderr).text();
    return { ok: code === 0, out: out.trim() };
}

export async function toolchainProbe(
    config: SimConfig,
    launcher: string,
    offset: string,
): Promise<ToolchainProbe[]> {
    writeToolWrappers(config, launcher);
    const { path, env } = toolchainEnv(config, launcher);
    const keep = [dirname(offset)];
    const ro = [...config.toolchain.keep, toolbinDir(launcher), dirname(dirname(FAKETIME_LIB))];
    const vars = { ...faketimeEnv(offset), ...env };
    const results: ToolchainProbe[] = [];
    for (const [tool, script] of TOOLCHAIN_PROBES) {
        const r = await probe(launch(launcher, keep, vars, ["/bin/sh", "-c", script], ro), path);
        if (!r.ok) throw new Error(`toolchain: ${tool} under the interposer: ${r.out}`);
        results.push({ tool, version: versionLine(tool, r.out) });
    }
    return results;
}

const VERSION: Record<string, RegExp> = {
    cargo: /^cargo \d+\.\d+/,
    rustc: /^rustc \d+\.\d+/,
    bun: /^\d+\.\d+\.\d+/,
};

export function versionLine(tool: string, out: string): string {
    const line = out.split("\n")[0]?.trim() ?? "";
    if (!VERSION[tool]?.test(line))
        throw new Error(`toolchain: ${tool} printed no version (${line})`);
    return line;
}
