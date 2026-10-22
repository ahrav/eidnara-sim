/**
 * Each arm's declared configuration and the capabilities each daemon variant provides. The host
 * stack derives every compaction and plugin setting from `ARM_PROFILES`, the run refuses an arm
 * whose daemon cannot provide what the arm declares, and `src/run/capabilities.ts` checks the
 * declaration against the arm's run evidence.
 */

export type ArmName =
    | "host"
    | "eidnara"
    | "eidnara-kl"
    | "eidnara-cf"
    | "eidnara-hybrid"
    | "eidnara-search"
    | "host-oracle";

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
    /**
     * Whether the recalled-memory block the daemon writes into every request can be turned off
     * while the memory search source stays on (`switchable`), or comes with memory itself
     * (`always-on`).
     */
    memory_injection: "always-on" | "switchable";
}

/** The Eidnara commit whose source `DAEMON_VARIANTS` was read from. */
export const AUDITED_EIDNARA = "08de9051a735f136ff63a9dca49eaa11493b3006";

export interface VariantRecord extends DaemonCapabilities {
    evidence: string;
    /** The source reading behind one capability, where it differs from `evidence`. */
    notes?: Partial<Record<keyof DaemonCapabilities, string>>;
    /** The Eidnara files that fix these capabilities; a build whose copies differ from `AUDITED_EIDNARA`'s needs a fresh reading. */
    sources: string[];
}

/**
 * Both variants compose the request's `<project-memory>` block from the same daemon config, whose
 * only switch for it is `memory.enabled`, and that switch also closes the memory search source.
 */
const MEMORY_INJECTION =
    "crates/daemon/src/m0_compose.rs selects project memories for the <project-memory> block whenever memory_enabled holds, and crates/daemon/src/config.rs has no key that drops the block while memory stays on (memory.injection_budget_tokens has a schema minimum of 500); memory.enabled=false disables the plugin's kernel memory client (packages/opencode-plugin/src/shared/kernel-client/state.ts), which also serves Pi's eidnara_search memory source (packages/pi-plugin/src/tools/eidnara-search.ts)";
const MEMORY_INJECTION_SOURCES = [
    "crates/daemon/src/m0_compose.rs",
    "crates/daemon/src/config.rs",
    "packages/opencode-plugin/src/shared/kernel-client/state.ts",
    "packages/pi-plugin/src/tools/eidnara-search.ts",
];

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
        memory_injection: "always-on",
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs builds its Handler without set_query_route_limits or a memory reviewer host and links an 8-dimension deterministic embedding engine; packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy",
        sources: [
            "crates/daemon/examples/direct_host_fixture.rs",
            "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts",
            "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
            ...MEMORY_INJECTION_SOURCES,
        ],
        notes: { memory_injection: MEMORY_INJECTION },
    },
    "production-payload": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: true,
        side_calls: "direct-bedrock",
        memory_injection: "always-on",
        evidence:
            "eidnara-host serve (crates/daemon/src/bin/eidnara_host/serve.rs) admits only the compiled-in QUALIFIED_HARNESS_CLOSURES, runs Pi with --no-extensions and a fresh HOME (crates/host-runtime/src/model_execution/pi.rs), and refuses AWS endpoint overrides (aws_profile.rs), so its model calls cannot reach the sim proxy",
        sources: [
            "crates/daemon/src/bin/eidnara_host/serve.rs",
            "crates/host-runtime/src/model_execution/pi.rs",
            "crates/host-runtime/src/model_execution/aws_profile.rs",
            ...MEMORY_INJECTION_SOURCES,
        ],
        notes: { memory_injection: MEMORY_INJECTION },
    },
};

/**
 * The arm roles Workstream A compares; `eidnara-cf` is fallback-search with counterfactual
 * deletions, and `oracle-context` is a harness control that never stands for a production setup.
 */
export type ArmRole =
    | "host-only"
    | "fallback-search"
    | "knowledge-only"
    | "production-hybrid"
    | "explicit-search-only"
    | "oracle-context";

/**
 * How knowledge from earlier sessions reaches the agent: not at all, through Eidnara's automatic
 * injection beside its tools, through Eidnara's tools alone, or as the probe's ground-truth source
 * text the harness puts in the probe turn's prompt.
 */
export type Delivery = "none" | "automatic" | "explicit-search" | "oracle-context";

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
    /** Absent on the arms that predate it, which deliver as `deliveryOf` derives. */
    delivery?: Delivery;
}

/** An arm's delivery mode: its declared one, or automatic with the plugin and none without. */
export const deliveryOf = (profile: ArmProfile): Delivery =>
    profile.delivery ?? (profile.plugin ? "automatic" : "none");

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
    // Eidnara's tools with its automatic memory injection and search hints off.
    "eidnara-search": {
        role: "explicit-search-only",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        requires: { ...PROXIED, memory_injection: "switchable" },
        delivery: "explicit-search",
    },
    // The upper-bound control: the host alone, given each probe's source text in its prompt.
    "host-oracle": {
        role: "oracle-context",
        daemon: null,
        plugin: false,
        eidnara_compaction: false,
        host_compaction: true,
        search: "none",
        requires: {},
        delivery: "oracle-context",
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
                `${label} (${profile.role}) needs ${key}=${String(wanted[key])}, but ${profile.daemon} provides ${String(provided[key])}: ${provided.notes?.[key] ?? provided.evidence}`,
        );
}
