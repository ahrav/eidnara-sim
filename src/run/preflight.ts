import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import { DUMMY_AWS } from "../hosts/arms";
import { checkBuildMarker, checkDaemonFromBuild } from "./buildmarker";
import { assess, type Interception, interceptionTest, probes } from "./interception";
import { launch, plainPath, writeLauncher } from "./launcher";
import { buildFaketime } from "./timeinject";
import {
    checkToolchainBins,
    checkToolchainHomes,
    type ToolchainProbe,
    toolchainProbe,
} from "./toolchain";
import { hostVersion, transcriptPaths } from "./transcripts";

/** A probed host: its version and the real path of the install the version came from. */
export interface HostRow {
    host: "pi" | "opencode";
    version: string;
    path?: string;
    transcript_paths: string[];
}

export interface Preflight {
    launcher: string;
    time_injection: Interception[];
    distortions: string[];
    hosts: HostRow[];
    /** The `config.upgrade` versions a `host_upgrade` fault moves to, probed before the run. */
    upgrade: HostRow[];
    toolchain: ToolchainProbe[];
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type VersionRow = { host: "pi" | "opencode"; version: string };

/** A `config.upgrade` target must resolve to a version other than the host's current one. */
export function requireUpgradeMoves(hosts: VersionRow[], upgrade: VersionRow[]): void {
    const fields = { pi: "pi_install", opencode: "opencode_binary" } as const;
    for (const next of upgrade) {
        const current = hosts.find((h) => h.host === next.host);
        if (current && current.version === next.version) {
            throw new Error(
                `config.upgrade.${fields[next.host]}: resolves to the current version ${next.version}`,
            );
        }
    }
}

/**
 * What a resume's preflight changed against the manifest's: the interception results, or a
 * current or upgrade host's version or install path.
 */
export function preflightDrift(before: Preflight, now: Preflight): string[] {
    const intercepted = (p: Preflight) => p.time_injection.map((t) => [t.name, t.intercepted]);
    const versions = (p: Preflight) =>
        [...p.hosts, ...(p.upgrade ?? [])].map((h) => [h.host, h.version, h.path ?? null]);
    const drift: string[] = [];
    if (!sameJson(intercepted(before), intercepted(now))) drift.push("time interception");
    if (!sameJson(versions(before), versions(now))) drift.push("host versions");
    return drift;
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

/**
 * The host's `--version`, run inside the sandbox when a launcher is given: a scratch HOME, the
 * placeholder AWS variables the hosts run with, and read-only access to the host install alone.
 */
export function versionOf(config: SimConfig, host: "pi" | "opencode", launcher?: string): string {
    const node = realpathSync(Bun.which("node") ?? "node");
    const argv =
        host === "pi" ? [node, piCli(config), "--version"] : [config.opencode_binary, "--version"];
    if (!launcher) return hostVersion(argv);
    const home = mkdtempSync(join(dirname(launcher), "probe-home-"));
    const nodeRoot = resolve(node, "../..");
    const install =
        host === "pi"
            ? config.pi_install
            : dirname(dirname(dirname(plainPath(config.opencode_binary))));
    const ro = [nodeRoot, install, config.eidnara_checkout];
    const env = {
        HOME: home,
        PATH: `${join(nodeRoot, "bin")}:/usr/local/bin:/usr/bin:/bin`,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        ...DUMMY_AWS,
    };
    try {
        // The probe starts from this allowlisted environment alone; the sandbox preserves
        // whatever it is handed, so nothing of the tier process's environment reaches it.
        return hostVersion(launch(launcher, [home], env, argv, ro), env);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
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
                  .map((p) => ({
                      ...p,
                      name: "opencode-upgrade" as const,
                      readOnly: [config.eidnara_checkout],
                  }))
            : []),
    ]);
    const { distortions } = assess(time_injection);
    const wallTools = config.toolchain.wall_clock_tools;
    if (wallTools.length > 0) distortions.push(`${wallTools.join(", ")} read wall-clock time`);
    distortions.push(cacheDistortion(config));
    const row = (c: SimConfig, host: "pi" | "opencode"): HostRow => {
        const version = versionOf(c, host, launcher);
        const path = realpathSync(host === "pi" ? c.pi_install : c.opencode_binary);
        return { host, version, path, transcript_paths: transcriptPaths(host, version) };
    };
    const hosts = (["pi", "opencode"] as const).map((h) => row(config, h));
    const fields = { pi: "pi_install", opencode: "opencode_binary" } as const;
    const upgrade = (["pi", "opencode"] as const)
        .filter((h) => config.upgrade?.[fields[h]])
        .map((h) => row({ ...config, ...config.upgrade }, h));
    requireUpgradeMoves(hosts, upgrade);
    const offset = join(runRoot, "interception", "offset");
    checkToolchainBins(config);
    checkToolchainHomes(config);
    const toolchain = await toolchainProbe(config, launcher, offset);
    return { launcher, time_injection, distortions, hosts, upgrade, toolchain };
}
