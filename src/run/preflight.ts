import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { assess, type Interception, interceptionTest, probes } from "./interception";
import { writeLauncher } from "./launcher";
import { buildFaketime } from "./timeinject";
import { type ToolchainProbe, toolchainProbe } from "./toolchain";
import { hostVersion, transcriptPaths } from "./transcripts";

export interface Preflight {
    launcher: string;
    time_injection: Interception[];
    distortions: string[];
    hosts: { host: "pi" | "opencode"; version: string; transcript_paths: string[] }[];
    /** The `config.upgrade` versions a `host_upgrade` fault moves to, probed before the run. */
    upgrade: { host: "pi" | "opencode"; version: string; transcript_paths: string[] }[];
    toolchain: ToolchainProbe[];
}

export function piCli(config: SimConfig): string {
    return join(config.pi_install, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
}

export function versionOf(config: SimConfig, host: "pi" | "opencode"): string {
    const node = realpathSync(Bun.which("node") ?? "node");
    return hostVersion(
        host === "pi" ? [node, piCli(config), "--version"] : [config.opencode_binary, "--version"],
    );
}

export async function preflight(config: SimConfig, runRoot: string): Promise<Preflight> {
    await buildFaketime();
    const launcher = writeLauncher(runRoot);
    const node = realpathSync(Bun.which("node") ?? "node");
    const next = config.upgrade?.opencode_binary;
    const time_injection = interceptionTest(launcher, runRoot, [
        ...probes({ node, opencode: config.opencode_binary, daemon: config.daemon_binary }),
        ...(next
            ? probes({ node, opencode: next, daemon: config.daemon_binary })
                  .filter((p) => p.name === "opencode")
                  .map((p) => ({ ...p, name: "opencode-upgrade" as const }))
            : []),
    ]);
    const { distortions } = assess(time_injection);
    const wallTools = config.toolchain.wall_clock_tools;
    if (wallTools.length > 0) distortions.push(`${wallTools.join(", ")} read wall-clock time`);
    distortions.push(
        "toolchain caches are read-only, so a dependency missing from them fails to fetch",
    );
    const row = (c: SimConfig, host: "pi" | "opencode") => {
        const version = versionOf(c, host);
        return { host, version, transcript_paths: transcriptPaths(host, version) };
    };
    const hosts = (["pi", "opencode"] as const).map((h) => row(config, h));
    const fields = { pi: "pi_install", opencode: "opencode_binary" } as const;
    const upgrade = (["pi", "opencode"] as const)
        .filter((h) => config.upgrade?.[fields[h]])
        .map((h) => row({ ...config, ...config.upgrade }, h));
    const offset = join(runRoot, "interception", "offset");
    const toolchain = await toolchainProbe(config, launcher, offset);
    return { launcher, time_injection, distortions, hosts, upgrade, toolchain };
}
