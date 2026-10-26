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
    /**
     * Whether the daemon honours the user-tier `source_capture.enabled` consent key, retaining
     * message text, tool outputs, and configured documents as Kernel source descriptors.
     */
    source_capture: boolean;
}

/** The Eidnara commit whose source `DAEMON_VARIANTS` was read from. */
export const AUDITED_EIDNARA = "1c56ba03388b9b1075cb13e6ffdff847ebf7fd5e";

/**
 * One mechanical reading behind a capability: `file` at the audited commit matches `pattern`
 * (`present: true`) or does not (`present: false`). `scripts/audit-eidnara.ts` evaluates every
 * probe at a candidate commit, so a re-audit starts from the readings that no longer hold.
 */
export interface SourceProbe {
    capability: keyof DaemonCapabilities;
    file: string;
    pattern: string;
    present: boolean;
}

export interface VariantRecord extends DaemonCapabilities {
    evidence: string;
    /** The source reading behind one capability, where it differs from `evidence`. */
    notes?: Partial<Record<keyof DaemonCapabilities, string>>;
    /** The Eidnara files that fix these capabilities; a build whose copies differ from `AUDITED_EIDNARA`'s needs a fresh reading. */
    sources: string[];
    /** The mechanical readings of `sources` that back the capability values. */
    probes: SourceProbe[];
}

/**
 * Both variants compose the request's `<project-memory>` block from the same daemon config, whose
 * only switch for it is `memory.enabled`, and that switch also closes the memory search source.
 */
const MEMORY_INJECTION =
    "crates/daemon/src/m0_compose.rs selects project memories for the <project-memory> block whenever memory_enabled holds, and crates/daemon/src/config.rs has no key that drops the block while memory stays on (memory.injection_budget_tokens has a schema minimum of 500); memory.enabled=false disables the plugin's kernel memory client (packages/opencode-plugin/src/shared/kernel-client/state.ts), which also serves Pi's eidnara_search memory source (packages/pi-plugin/src/tools/eidnara-search.ts)";
/**
 * The plugin sources behind the knowledge-only arm's evidence: the Pi context handler that
 * submits a pass in every compaction mode, the Pi window it submits, and the shared transform
 * client that logs each pass's `in=` and `out=` counts.
 */
const PASS_SOURCES = [
    "packages/pi-plugin/src/index.ts",
    "packages/pi-plugin/src/transform/pi-transform.ts",
    "packages/opencode-plugin/src/hooks/context/transform-session-client.ts",
];
const MEMORY_INJECTION_SOURCES = [
    "crates/daemon/src/m0_compose.rs",
    "crates/daemon/src/config.rs",
    "packages/opencode-plugin/src/shared/kernel-client/state.ts",
    "packages/pi-plugin/src/tools/eidnara-search.ts",
];
/**
 * Source capture runs when the daemon's effective config holds `source_capture.enabled` and
 * `memory.enabled` (`consents` in source_capture.rs), and the key is read from the user tier only.
 */
const SOURCE_CAPTURE_SOURCES = ["crates/daemon/src/source_capture.rs"];
const probe = (
    capability: keyof DaemonCapabilities,
    file: string,
    pattern: string,
    present = true,
): SourceProbe => ({ capability, file, pattern, present });
/** The readings both variants share: the memory block's lack of a switch and the capture key. */
const SHARED_PROBES = [
    probe(
        "memory_injection",
        "crates/daemon/src/config.rs",
        "injection_enabled|/memory/injection/enabled",
        false,
    ),
    probe("memory_injection", "crates/daemon/src/m0_compose.rs", "memory_enabled"),
    probe("source_capture", "crates/daemon/src/config.rs", '"/source_capture/enabled"'),
    probe(
        "source_capture",
        "crates/daemon/src/source_capture.rs",
        "config\\.source_capture_enabled\\s*&&\\s*config\\.memory_enabled",
    ),
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
        source_capture: true,
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs builds its Handler without set_query_route_limits or a memory reviewer host and links an 8-dimension deterministic embedding engine; its review-witness control runs MemoryReviewer jobs only on a test's request, against a scripted local provider, and the host's own worker keeps its closed gate (direct_host_fixture/review_witness.rs); packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy",
        sources: [
            "crates/daemon/examples/direct_host_fixture.rs",
            "crates/daemon/examples/direct_host_fixture/review_witness.rs",
            "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts",
            "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
            ...PASS_SOURCES,
            ...MEMORY_INJECTION_SOURCES,
            ...SOURCE_CAPTURE_SOURCES,
        ],
        probes: [
            probe(
                "search",
                "crates/daemon/examples/direct_host_fixture.rs",
                "set_query_route_limits",
                false,
            ),
            probe(
                "memory_reviewer",
                "crates/daemon/examples/direct_host_fixture.rs",
                "with_memory_reviewer_host",
                false,
            ),
            probe(
                "embeddings",
                "crates/daemon/examples/direct_host_fixture.rs",
                "struct DeterministicEngine",
            ),
            probe(
                "side_calls",
                "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts",
                "piBaseUrl",
            ),
            probe(
                "source_capture",
                "crates/daemon/examples/direct_host_fixture.rs",
                "SourceCaptureReport",
            ),
            probe(
                "source_capture",
                "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
                "settledSourceCapture",
            ),
            ...SHARED_PROBES,
        ],
        notes: { memory_injection: MEMORY_INJECTION },
    },
    "production-payload": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: true,
        side_calls: "direct-bedrock",
        memory_injection: "always-on",
        source_capture: true,
        evidence:
            "eidnara-host serve (crates/daemon/src/bin/eidnara_host/serve.rs) admits only the compiled-in QUALIFIED_HARNESS_CLOSURES, runs Pi with --no-extensions and a fresh HOME (crates/host-runtime/src/model_execution/pi.rs), and refuses AWS endpoint overrides (aws_profile.rs), so its model calls cannot reach the sim proxy",
        sources: [
            "crates/daemon/src/bin/eidnara_host/serve.rs",
            "crates/host-runtime/src/model_execution/pi.rs",
            "crates/host-runtime/src/model_execution/aws_profile.rs",
            ...MEMORY_INJECTION_SOURCES,
            ...SOURCE_CAPTURE_SOURCES,
        ],
        probes: [
            probe(
                "search",
                "crates/daemon/src/bin/eidnara_host/serve.rs",
                "set_query_route_limits",
            ),
            probe(
                "memory_reviewer",
                "crates/daemon/src/bin/eidnara_host/serve.rs",
                "with_memory_reviewer_host",
            ),
            probe(
                "embeddings",
                "crates/daemon/src/bin/eidnara_host/serve.rs",
                "gte-modernbert-base-f32",
            ),
            probe(
                "side_calls",
                "crates/daemon/src/bin/eidnara_host/serve.rs",
                "QUALIFIED_HARNESS_CLOSURES",
            ),
            probe("side_calls", "crates/host-runtime/src/model_execution/pi.rs", "--no-extensions"),
            ...SHARED_PROBES,
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
    /** Eidnara's user-only `source_capture.enabled` consent key, written to the daemon and plugin user tiers. */
    source_capture: boolean;
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
        source_capture: false,
        requires: {},
    },
    eidnara: {
        role: "fallback-search",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        source_capture: true,
        requires: { ...PROXIED, source_capture: true },
    },
    "eidnara-cf": {
        role: "fallback-search",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        source_capture: true,
        requires: { ...PROXIED, source_capture: true },
    },
    // SIM-P76: the knowledge layer alone, with the host owning the context window.
    "eidnara-kl": {
        role: "knowledge-only",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: false,
        host_compaction: true,
        search: "legacy-scan",
        source_capture: false,
        requires: PROXIED,
    },
    "eidnara-hybrid": {
        role: "production-hybrid",
        daemon: "production-payload",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "fused",
        source_capture: false,
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
        source_capture: false,
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
        source_capture: false,
        requires: {},
        delivery: "oracle-context",
    },
};

export const isArmName = (name: string): name is ArmName => Object.hasOwn(ARM_PROFILES, name);

/** Whether the arm a label names runs Eidnara's daemon and plugin; an unknown label does. */
export function runsEidnara(label: string): boolean {
    const base = label.split("~")[0] as string;
    return !isArmName(base) || ARM_PROFILES[base].daemon !== null;
}

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
