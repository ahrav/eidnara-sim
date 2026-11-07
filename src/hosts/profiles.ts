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

export type DaemonVariant =
    | "direct-host-fixture"
    | "direct-host-fixture-fused"
    | "production-payload";

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
    user_statement_delivery: boolean;
    whole_small_tool_outputs: boolean;
    failure_lines_captured: boolean;
    stream_tags_stripped: boolean;
    /**
     * Whether the daemon honours the user-tier `source_capture.enabled` consent key, retaining
     * message text, tool outputs, and configured documents as Kernel source descriptors.
     */
    source_capture: boolean;
}

/** The Eidnara commit whose source `DAEMON_VARIANTS` was read from. */
export const AUDITED_EIDNARA = "1f2867036ab7d7c6e5a36df1a36d99ab79d7982c";

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

const MEMORY_INJECTION =
    "crates/daemon/src/transform.rs injects m0 memory only while memory_enabled && memory_auto_inject holds, and crates/daemon/src/config.rs reads /memory/auto_inject/enabled from the user tier only (default true); crates/daemon/src/m0_compose.rs drops the project-memory and user-profile blocks when inject_memory is false, while memory.enabled keeps the plugin's kernel memory client (packages/opencode-plugin/src/shared/kernel-client/state.ts) serving Pi's eidnara_search (packages/pi-plugin/src/tools/eidnara-search.ts)";
const BEHAVIOUR_NOTES: VariantRecord["notes"] = {
    memory_injection: MEMORY_INJECTION,
    user_statement_delivery:
        "crates/daemon/src/memory_capture.rs records a captured whole user statement as an accepted decision stm_<id> in the user-statements domain, its rationale naming the capture session, and the transform serves accepted statements of other sessions in <project-memory>",
    whole_small_tool_outputs:
        "crates/daemon/src/tool_outcome.rs renders a tool output of at most WHOLE_OUTPUT_MAX_BYTES whole in the history summarizer's digest",
    failure_lines_captured:
        "crates/daemon/src/memory_capture/native.rs runs failure_evidence::attach on the frozen quotations, so error lines join the memory that frames them",
    stream_tags_stripped:
        "packages/pi-plugin/src/index.ts strips block tags from message_start and message_update events (stripStreamedTags) on turns the daemon served tagged",
};
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
    "crates/daemon/src/transform.rs",
    "packages/opencode-plugin/src/shared/kernel-client/state.ts",
    "packages/pi-plugin/src/tools/eidnara-search.ts",
];
const BEHAVIOUR_SOURCES = [
    "crates/daemon/src/memory_capture.rs",
    "crates/daemon/src/memory_capture/native.rs",
    "crates/daemon/src/tool_outcome.rs",
];
/** Source capture requires both `source_capture.enabled` and `memory.enabled` in the daemon's effective config. */
const SOURCE_CAPTURE_SOURCES = ["crates/daemon/src/source_capture.rs"];
const probe = (
    capability: keyof DaemonCapabilities,
    file: string,
    pattern: string,
    present = true,
): SourceProbe => ({ capability, file, pattern, present });
const SHARED_PROBES = [
    probe("memory_injection", "crates/daemon/src/config.rs", '"/memory/auto_inject/enabled"'),
    probe(
        "memory_injection",
        "crates/daemon/src/transform.rs",
        "self\\.memory_enabled && self\\.memory_auto_inject",
    ),
    probe("memory_injection", "crates/daemon/src/m0_compose.rs", "if inputs\\.inject_memory"),
    probe("source_capture", "crates/daemon/src/config.rs", '"/source_capture/enabled"'),
    probe(
        "source_capture",
        "crates/daemon/src/source_capture.rs",
        "config\\.source_capture_enabled\\s*&&\\s*config\\.memory_enabled",
    ),
    probe(
        "user_statement_delivery",
        "crates/daemon/src/memory_capture.rs",
        'STATEMENT_DOMAIN_ID: &str = "user-statements"',
    ),
    probe("user_statement_delivery", "crates/daemon/src/memory_capture.rs", 'format!\\("stm_'),
    probe(
        "user_statement_delivery",
        "crates/daemon/src/memory_capture.rs",
        '"session": job\\.session_id',
    ),
    probe(
        "whole_small_tool_outputs",
        "crates/daemon/src/tool_outcome.rs",
        "const WHOLE_OUTPUT_MAX_BYTES: usize",
    ),
    probe(
        "failure_lines_captured",
        "crates/daemon/src/memory_capture/native.rs",
        "failure_evidence::attach\\(",
    ),
    probe("stream_tags_stripped", "packages/pi-plugin/src/index.ts", 'pi\\.on\\("message_update"'),
    probe(
        "stream_tags_stripped",
        "packages/pi-plugin/src/index.ts",
        "stripStreamedTags\\(event\\)",
    ),
];
const BEHAVIOURS = {
    memory_injection: "switchable",
    user_statement_delivery: true,
    whole_small_tool_outputs: true,
    failure_lines_captured: true,
    stream_tags_stripped: true,
} as const;

const FIXTURE = "crates/daemon/examples/direct_host_fixture.rs";
const FIXTURE_SOURCES = [
    FIXTURE,
    "crates/daemon/examples/direct_host_fixture/review_witness.rs",
    "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts",
    "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
    ...PASS_SOURCES,
    ...MEMORY_INJECTION_SOURCES,
    ...SOURCE_CAPTURE_SOURCES,
    ...BEHAVIOUR_SOURCES,
];
const FIXTURE_PROBES = [
    probe("memory_reviewer", FIXTURE, "with_memory_reviewer_host", false),
    probe("side_calls", "packages/e2e-tests/src/bedrock-peer/harness-runtime.ts", "piBaseUrl"),
    probe("source_capture", FIXTURE, "SourceCaptureReport"),
    probe(
        "source_capture",
        "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
        "settledSourceCapture",
    ),
    ...SHARED_PROBES,
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
        source_capture: true,
        ...BEHAVIOURS,
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs started without --query-route keeps the legacy search route and links an 8-dimension deterministic embedding engine; it builds its Handler without a memory reviewer host, and its review-witness control runs MemoryReviewer jobs only on a test's request, against a scripted local provider (direct_host_fixture/review_witness.rs); packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy",
        sources: FIXTURE_SOURCES,
        probes: [
            probe("search", FIXTURE, "\\(None, None\\) => SearchRoute::Legacy"),
            probe("embeddings", FIXTURE, "struct DeterministicEngine"),
            ...FIXTURE_PROBES,
        ],
        notes: BEHAVIOUR_NOTES,
    },
    "direct-host-fixture-fused": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: false,
        side_calls: "proxy",
        source_capture: true,
        ...BEHAVIOURS,
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs started with --query-route production --local-embeddings-manifest <payload-manifest.json> sets the production query route limits over the payload's gte-modernbert-base-f32 local embedding lane (payload_local_embeddings.rs), installs search admission from fixture records, and logs `search route production, embedding model <model>` on stderr; it builds its Handler without a memory reviewer host; packages/e2e-tests/src/rust-runner/hermetic-host.ts passes both flags for productionSearchManifest, and harness-runtime.ts points its closures at the proxy",
        sources: [
            ...FIXTURE_SOURCES,
            "crates/daemon/src/bin/eidnara_host/payload_local_embeddings.rs",
        ],
        probes: [
            probe("search", FIXTURE, '\\(Some\\("production"\\), Some\\(payload_manifest\\)\\)'),
            probe("search", FIXTURE, "\\.set_query_route_limits\\("),
            probe(
                "search",
                "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
                "productionSearchManifest",
            ),
            probe("embeddings", FIXTURE, "with_local_embeddings\\(lane"),
            probe(
                "embeddings",
                "crates/daemon/src/bin/eidnara_host/payload_local_embeddings.rs",
                "payload/model/gte-modernbert-base-f32",
            ),
            probe("embeddings", FIXTURE, "search route production, embedding model"),
            ...FIXTURE_PROBES,
        ],
        notes: BEHAVIOUR_NOTES,
    },
    "production-payload": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: true,
        side_calls: "direct-bedrock",
        source_capture: true,
        ...BEHAVIOURS,
        evidence:
            "eidnara-host serve (crates/daemon/src/bin/eidnara_host/serve.rs) admits only the compiled-in QUALIFIED_HARNESS_CLOSURES, runs Pi with --no-extensions and a fresh HOME (crates/host-runtime/src/model_execution/pi.rs), and refuses AWS endpoint overrides (aws_profile.rs), so its model calls cannot reach the sim proxy",
        sources: [
            "crates/daemon/src/bin/eidnara_host/serve.rs",
            "crates/host-runtime/src/model_execution/pi.rs",
            "crates/host-runtime/src/model_execution/aws_profile.rs",
            ...PASS_SOURCES,
            ...MEMORY_INJECTION_SOURCES,
            ...SOURCE_CAPTURE_SOURCES,
            ...BEHAVIOUR_SOURCES,
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
        notes: BEHAVIOUR_NOTES,
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
/** What the c8 comparison arms need beyond the proxy: the build's user-statement delivery. */
const C8_EIDNARA = { ...PROXIED, user_statement_delivery: true } as const;

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
        requires: { ...C8_EIDNARA, source_capture: true },
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
    // The c8 eidnara arm with the fixture's production query route over the payload's embeddings.
    "eidnara-hybrid": {
        role: "production-hybrid",
        daemon: "direct-host-fixture-fused",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "fused",
        source_capture: true,
        requires: {
            ...C8_EIDNARA,
            embeddings: "gte-modernbert-base-f32",
            source_capture: true,
        },
    },
    // The c8 eidnara arm with automatic memory injection and the search hint off.
    "eidnara-search": {
        role: "explicit-search-only",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        source_capture: true,
        requires: { ...C8_EIDNARA, memory_injection: "switchable", source_capture: true },
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
