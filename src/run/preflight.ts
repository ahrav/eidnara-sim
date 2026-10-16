import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { assess, type Interception, interceptionTest, probes } from "./interception";
import { writeLauncher } from "./launcher";
import { buildFaketime } from "./timeinject";
import { hostVersion, transcriptPaths } from "./transcripts";

export interface Preflight {
    launcher: string;
    time_injection: Interception[];
    distortions: string[];
    hosts: { host: "pi" | "opencode"; version: string; transcript_paths: string[] }[];
}

export function piCli(config: SimConfig): string {
    return join(config.pi_install, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
}

export async function preflight(config: SimConfig, runRoot: string): Promise<Preflight> {
    await buildFaketime();
    const launcher = writeLauncher(runRoot);
    const node = realpathSync(Bun.which("node") ?? "node");
    const time_injection = interceptionTest(
        launcher,
        runRoot,
        probes({ node, opencode: config.opencode_binary, daemon: config.daemon_binary }),
    );
    const { distortions } = assess(time_injection);
    const hosts = (
        [
            ["pi", [node, piCli(config), "--version"]],
            ["opencode", [config.opencode_binary, "--version"]],
        ] as const
    ).map(([host, argv]) => {
        const version = hostVersion([...argv]);
        return { host, version, transcript_paths: transcriptPaths(host, version) };
    });
    return { launcher, time_injection, distortions, hosts };
}
