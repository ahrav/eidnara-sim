/**
 * Each arm's declared configuration and the capabilities each daemon variant provides. The host
 * stack derives every compaction and plugin setting from `ARM_PROFILES`, the run refuses an arm
 * whose daemon cannot provide what the arm declares, and `src/run/capabilities.ts` checks the
 * declaration against the arm's run evidence.
 */

export type ArmName = "host" | "eidnara" | "eidnara-kl" | "eidnara-cf" | "eidnara-hybrid";

/** How an arm's memory search answers: none, the plugin's legacy snapshot scan, or the daemon's fused route. */
export type SearchRoute = "none" | "legacy-scan" | "fused";

export type DaemonVariant = "direct-host-fixture" | "production-payload";

export interface DaemonCapabilities {
    search: SearchRoute;
    /** The local embedding engine the daemon links. */
    embeddings: "deterministic-fixture" | "gte-modernbert-base-f32";
    memory_reviewer: boolean;
    /** Where the daemon's own model calls go: through the sim proxy, or straight to Bedrock. */
    side_calls: "proxy" | "direct-bedrock";
}

/** The Eidnara commit whose source `DAEMON_VARIANTS` was read from. */
export const AUDITED_EIDNARA = "08de9051a735f136ff63a9dca49eaa11493b3006";

export interface VariantRecord extends DaemonCapabilities {
    evidence: string;
    /** The Eidnara files that fix these capabilities; a build whose copies differ from `AUDITED_EIDNARA`'s needs a fresh reading. */
    sources: string[];
}

/**
 * What each daemon variant provides, with the Eidnara source that establishes it. Only the
 * fixture's `--harness-runtime` redirect extension points model calls at the proxy; the
 * production launcher refuses that closure.
 */
export const DAEMON_VARIANTS: Record<DaemonVariant, VariantRecord> = {
    "direct-host-fixture": {
        search: "legacy-scan",
        embeddings: "deterministic-fixture",
        memory_reviewer: false,
        side_calls: "proxy",
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs builds its Handler without set_query_route_limits or a memory reviewer host and links an 8-dimension deterministic embedding engine; packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy",
        sources: [
            "crates/daemon/examples/direct_host_fixture.rs",
            "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts",
            "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
        ],
    },
    "production-payload": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: true,
        side_calls: "direct-bedrock",
        evidence:
            "eidnara-host serve (crates/daemon/src/bin/eidnara_host/serve.rs) admits only the compiled-in QUALIFIED_HARNESS_CLOSURES, runs Pi with --no-extensions and a fresh HOME (crates/host-runtime/src/model_execution/pi.rs), and refuses AWS endpoint overrides (aws_profile.rs), so its model calls cannot reach the sim proxy",
        sources: [
            "crates/daemon/src/bin/eidnara_host/serve.rs",
            "crates/host-runtime/src/model_execution/pi.rs",
            "crates/host-runtime/src/model_execution/aws_profile.rs",
        ],
    },
};

/** The four arm roles Workstream A compares; `eidnara-cf` is fallback-search with counterfactual deletions. */
export type ArmRole = "host-only" | "fallback-search" | "knowledge-only" | "production-hybrid";

export interface ArmProfile {
    role: ArmRole;
    daemon: DaemonVariant | null;
    plugin: boolean;
    /** Eidnara's `compaction.enabled`: its transform, folding, and history summarizer. */
    eidnara_compaction: boolean;
    /** The host's native compaction (Pi `compaction.enabled`, OpenCode `compaction.auto`). */
    host_compaction: boolean;
    search: SearchRoute;
    /** Capabilities the arm needs from its daemon beyond `search`. */
    requires: Partial<DaemonCapabilities>;
}

const PROXIED = { side_calls: "proxy" } as const;

export const ARM_PROFILES: Record<ArmName, ArmProfile> = {
    host: {
        role: "host-only",
        daemon: null,
        plugin: false,
        eidnara_compaction: false,
        host_compaction: true,
        search: "none",
        requires: {},
    },
    eidnara: {
        role: "fallback-search",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        requires: PROXIED,
    },
    "eidnara-cf": {
        role: "fallback-search",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        requires: PROXIED,
    },
    // SIM-P76: the knowledge layer alone, with the host owning the context window.
    "eidnara-kl": {
        role: "knowledge-only",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: false,
        host_compaction: true,
        search: "legacy-scan",
        requires: PROXIED,
    },
    "eidnara-hybrid": {
        role: "production-hybrid",
        daemon: "production-payload",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "fused",
        requires: {
            ...PROXIED,
            embeddings: "gte-modernbert-base-f32",
            memory_reviewer: true,
        },
    },
};

export const isArmName = (name: string): name is ArmName => Object.hasOwn(ARM_PROFILES, name);

/** The profile an arm label runs under; an A/A control `host~aa` runs as `host`. */
export function armProfile(label: string): ArmProfile {
    const base = label.split("~")[0] as string;
    if (!isArmName(base)) throw new Error(`arm ${label} has no profile`);
    return ARM_PROFILES[base];
}

/**
 * Every capability the arm declares that its daemon variant does not provide, each naming the
 * declared and provided values and the source that fixes the provided one.
 */
export function capabilityGaps(label: string): string[] {
    const profile = armProfile(label);
    if (profile.daemon === null) return [];
    const provided = DAEMON_VARIANTS[profile.daemon];
    const wanted: Partial<DaemonCapabilities> = { ...profile.requires, search: profile.search };
    return (Object.keys(wanted) as Array<keyof DaemonCapabilities>)
        .filter((key) => wanted[key] !== provided[key])
        .map(
            (key) =>
                `${label} (${profile.role}) needs ${key}=${String(wanted[key])}, but ${profile.daemon} provides ${String(provided[key])}: ${provided.evidence}`,
        );
}
