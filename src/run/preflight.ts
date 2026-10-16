import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { checkBuildMarker, checkDaemonFromBuild } from "./buildmarker";
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
    toolchain: ToolchainProbe[];
}

export function piCli(config: SimConfig): string {
    return join(config.pi_install, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
}

/** The claim names the paths the sandbox actually keeps read-only. */
export function cacheDistortion(config: SimConfig): string {
    const keep = config.toolchain.keep;
    if (keep.length === 0) {
        return "no toolchain path is kept read-only, so the agent's builds can fetch dependencies into writable caches";
    }
    return `toolchain paths ${keep.join(", ")} are read-only and the sandbox keeps the host network, so a dependency missing from them fails unless the agent points a cache elsewhere and fetches it`;
}

export async function preflight(config: SimConfig, runRoot: string): Promise<Preflight> {
    checkBuildMarker(config.eidnara_checkout);
    checkDaemonFromBuild(config.eidnara_checkout, config.daemon_binary);
    await buildFaketime();
    const launcher = writeLauncher(runRoot);
    const node = realpathSync(Bun.which("node") ?? "node");
    const time_injection = interceptionTest(
        launcher,
        runRoot,
        probes({ node, opencode: config.opencode_binary, daemon: config.daemon_binary }),
    );
    const { distortions } = assess(time_injection);
    const wallTools = config.toolchain.wall_clock_tools;
    if (wallTools.length > 0) distortions.push(`${wallTools.join(", ")} read wall-clock time`);
    distortions.push(cacheDistortion(config));
    const hosts = (
        [
            ["pi", [node, piCli(config), "--version"]],
            ["opencode", [config.opencode_binary, "--version"]],
        ] as const
    ).map(([host, argv]) => {
        const version = hostVersion([...argv]);
        return { host, version, transcript_paths: transcriptPaths(host, version) };
    });
    const offset = join(runRoot, "interception", "offset");
    const toolchain = await toolchainProbe(config, launcher, offset);
    return { launcher, time_injection, distortions, hosts, toolchain };
}
