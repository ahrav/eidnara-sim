import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { checkBuildMarker, checkDaemonFromBuild } from "./buildmarker";
import { assess, type Interception, interceptionTest, probes } from "./interception";
import { writeLauncher } from "./launcher";
import { buildFaketime } from "./timeinject";
import {
    checkToolchainBins,
    checkToolchainHomes,
    type ToolchainProbe,
    toolchainProbe,
} from "./toolchain";
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

/** The canonical CLI, which must lie inside the Pi install the sandbox keeps read-only. */
export function piCli(config: SimConfig): string {
    const cli = join(config.pi_install, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const install = realpathSync(config.pi_install);
    const real = realpathSync(cli);
    if (!real.startsWith(`${install}/`)) {
        throw new Error(`Pi CLI ${cli} resolves outside ${config.pi_install}`);
    }
    return real;
}

/** The claim names the paths the sandbox actually keeps read-only. */
export function cacheDistortion(config: SimConfig): string {
    const keep = config.toolchain.keep;
    if (keep.length === 0) {
        return "no toolchain path is kept read-only, so the agent's builds can fetch dependencies into writable caches";
    }
    return `toolchain paths ${keep.join(", ")} are read-only and the sandbox keeps the host network, so a dependency missing from them fails unless the agent points a cache elsewhere and fetches it`;
}

export function versionOf(config: SimConfig, host: "pi" | "opencode"): string {
    const node = realpathSync(Bun.which("node") ?? "node");
    return hostVersion(
        host === "pi" ? [node, piCli(config), "--version"] : [config.opencode_binary, "--version"],
    );
}

export async function preflight(config: SimConfig, runRoot: string): Promise<Preflight> {
    checkBuildMarker(config.eidnara_checkout);
    checkDaemonFromBuild(config.eidnara_checkout, config.daemon_binary);
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
    distortions.push(cacheDistortion(config));
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
    checkToolchainBins(config);
    checkToolchainHomes(config);
    const toolchain = await toolchainProbe(config, launcher, offset);
    return { launcher, time_injection, distortions, hosts, upgrade, toolchain };
}
