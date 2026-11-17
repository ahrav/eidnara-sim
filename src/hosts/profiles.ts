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
    settled_lines_retired: boolean;
    /**
     * The Kernel lineage a statement record joins: one shared by every statement of the data home
     * (`shared`, at most 64 accepted statements), or one per quoted user message (`per-message`),
     * where a refused approval stores the statement labeled and counts it in
     * `decisions_approval_refused`.
     */
    statement_lineage: "shared" | "per-message";
    /** Whether a statement an observation contradicts renders as contested in `<project-memory>` and in `eidnara_search` results. */
    contested_statements: boolean;
    /** Whether the history renderer derives open items from the stored segments, so a waiting line renders only in the newest summarized segment. */
    keyed_open_items: boolean;
    /** Whether the Context module's `status` answer carries a `process_memory` block. */
    process_memory: boolean;
    /** Whether `search.lifecycle.status` answers with a `progress` block (lag behind the kernel tip, rebuild counts). */
    search_progress: boolean;
    /**
     * Whether the daemon honours the user-tier `source_capture.enabled` consent key, retaining
     * message text, tool outputs, and configured documents as Kernel source descriptors.
     */
    source_capture: boolean;
}

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
    /** The Eidnara files that fix these capabilities; a build whose copies differ from the audited commit's needs a fresh reading. */
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
const C8_NOTES: VariantRecord["notes"] = {
    ...BEHAVIOUR_NOTES,
    settled_lines_retired:
        "the history summarizer prompt (crates/daemon/testdata/history_summarizer-system-prompt.txt) asks for keyed Waiting on user / Constraint / Decided / Lifted status lines, and crates/daemon/src/history_summarizer_validate.rs runs history_summarizer_open_items::retire_settled_lines on each parsed segment before claims are checked",
    statement_lineage:
        "crates/daemon/src/memory_capture.rs writes every statement record with source id memory_capture_statement, so the Kernel's 64 authority bearers per lineage bound the data home's accepted statements",
};
const W2_NOTES: VariantRecord["notes"] = {
    ...BEHAVIOUR_NOTES,
    statement_lineage:
        "crates/daemon/src/memory_capture.rs statement_source_id names each statement record's source as memory_capture_statement:<first 32 hex digits of the capture job id>, one lineage per quoted user message; a plan whose approval the Kernel refuses commits labeled, and crates/daemon/src/source_capture.rs counts its statements as decisions_approval_refused",
    contested_statements:
        "crates/daemon/src/canonical_memory.rs contested_line renders a statement an observation contradicts as `<statement> (stated <date>; contested <date> by <memory>: <excerpt>)` in <project-memory>, and packages/opencode-plugin/src/tools/eidnara-search/render.ts appends `Contested by <memory>: <excerpt>` to the statement's search result",
    keyed_open_items:
        "crates/daemon/src/decay_render.rs renders history rows through crates/daemon/src/history_open_items.rs, which keeps a `Waiting on user (key)` line only while its segment is the newest summarized segment of the rows rendered together, and a `Constraint (key)` line until a later claim anchored on a `Lifted (key)` line",
    process_memory:
        "crates/daemon/src/lib.rs answers the Context module's status request with process_memory (crates/daemon/src/process_memory.rs: RssAnon, RssFile, RssShmem, threads, glibc C-heap bytes, the arena limit, and the C-heap release counts)",
};
const W2_FUSED_SEARCH_PROGRESS =
    "crates/daemon/src/search_lifecycle_wire.rs answers search.lifecycle.status with progress {tip, checkpoint, lag_commits, rebuilds, blocked}; crates/daemon/src/projection_gates.rs judge_lifecycle_work admits the lifecycle owner's own catch-up and rebuild of a family past the freshness limit, and the fixture's admission records (crates/daemon/examples/search_admission_records/records.rs) set that limit to READER_LAG_COMMITS = 1024 commits";
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
/** Sources both builds read their shared behaviours from. */
const BEHAVIOUR_SOURCES = [
    "crates/daemon/src/memory_capture.rs",
    "crates/daemon/src/memory_capture/native.rs",
    "crates/daemon/src/tool_outcome.rs",
    "crates/daemon/src/history_summarizer_citations.rs",
    "crates/daemon/src/history_summarizer_validate.rs",
    "crates/daemon/testdata/history_summarizer-system-prompt.txt",
    "crates/daemon/src/canonical_memory.rs",
    "crates/daemon/src/decay_render.rs",
    "crates/daemon/src/lib.rs",
];
/** The plugin files that render an `eidnara_search` result and resolve the contest a statement names. */
const SEARCH_RENDER = "packages/opencode-plugin/src/tools/eidnara-search/render.ts";
const SEARCH_ROWS = "packages/opencode-plugin/src/tools/eidnara-search/kernel-memory-search.ts";
const C8_BEHAVIOUR_SOURCES = [
    ...BEHAVIOUR_SOURCES,
    "crates/daemon/src/history_summarizer_open_items.rs",
    SEARCH_RENDER,
    SEARCH_ROWS,
];
const W2_BEHAVIOUR_SOURCES = [
    ...BEHAVIOUR_SOURCES,
    "crates/daemon/src/history_open_items.rs",
    "crates/daemon/src/process_memory.rs",
    SEARCH_RENDER,
    SEARCH_ROWS,
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
const PROMPT = "crates/daemon/testdata/history_summarizer-system-prompt.txt";
const OPEN_ITEMS_SECTION = "## Open items: waiting, constraints, decided, lifted";
/** The c8 build's readings of the behaviours the w2 rework changed. */
const C8_PROBES = [
    probe(
        "settled_lines_retired",
        "crates/daemon/src/history_summarizer_open_items.rs",
        "pub\\(crate\\) fn retire_settled_lines",
    ),
    probe(
        "settled_lines_retired",
        "crates/daemon/src/history_summarizer_validate.rs",
        "history_summarizer_open_items::retire_settled_lines\\(",
    ),
    probe("settled_lines_retired", PROMPT, OPEN_ITEMS_SECTION),
    probe(
        "statement_lineage",
        "crates/daemon/src/memory_capture.rs",
        "source_id: STATEMENT_SOURCE_ID\\.into\\(\\)",
    ),
    probe(
        "statement_lineage",
        "crates/daemon/src/source_capture.rs",
        "decisions_approval_refused",
        false,
    ),
    probe("contested_statements", "crates/daemon/src/canonical_memory.rs", "contested_line", false),
    probe("contested_statements", SEARCH_RENDER, "Contested by ", false),
    probe("contested_statements", SEARCH_ROWS, "resolveContests", false),
    probe("keyed_open_items", "crates/daemon/src/decay_render.rs", "history_open_items", false),
    probe("process_memory", "crates/daemon/src/lib.rs", "pub mod process_memory", false),
];
/** The w2 build's readings of the same behaviours. */
const W2_PROBES = [
    probe(
        "settled_lines_retired",
        "crates/daemon/src/history_summarizer_validate.rs",
        "retire_settled_lines",
        false,
    ),
    probe(
        "statement_lineage",
        "crates/daemon/src/memory_capture.rs",
        "fn statement_source_id\\(job: &CaptureJob\\)",
    ),
    probe(
        "statement_lineage",
        "crates/daemon/src/memory_capture.rs",
        'format!\\("\\{STATEMENT_SOURCE_ID\\}:\\{message\\}"\\)',
    ),
    probe(
        "statement_lineage",
        "crates/daemon/src/source_capture.rs",
        'DecisionsApprovalRefused => "decisions_approval_refused"',
    ),
    probe("contested_statements", "crates/daemon/src/canonical_memory.rs", "fn contested_line\\("),
    probe(
        "contested_statements",
        "crates/daemon/src/canonical_memory.rs",
        "\\(stated \\{\\}; contested \\{\\} by \\{(?:memory)?\\}: \\{\\}\\)",
    ),
    probe("contested_statements", "crates/daemon/src/memory_capture.rs", '"contested_by"'),
    probe("contested_statements", SEARCH_RENDER, "Contested by "),
    probe("contested_statements", SEARCH_ROWS, "export async function resolveContests\\("),
    probe(
        "keyed_open_items",
        "crates/daemon/src/history_open_items.rs",
        '\\("Waiting on user \\(", Status::Waiting\\)',
    ),
    probe(
        "keyed_open_items",
        "crates/daemon/src/decay_render.rs",
        "crate::history_open_items::rows\\(segments\\)",
    ),
    probe("keyed_open_items", PROMPT, OPEN_ITEMS_SECTION),
    probe(
        "process_memory",
        "crates/daemon/src/lib.rs",
        '"process_memory": process_memory::ProcessMemory::sample\\(\\)\\.to_json\\(\\)',
    ),
    probe(
        "process_memory",
        "crates/daemon/src/process_memory.rs",
        "pub const C_HEAP_ARENAS: usize = 4",
    ),
];
const SHARED_BEHAVIOURS = {
    memory_injection: "switchable",
    user_statement_delivery: true,
    whole_small_tool_outputs: true,
    failure_lines_captured: true,
    stream_tags_stripped: true,
    search_progress: false,
} as const;
const C8_BEHAVIOURS = {
    ...SHARED_BEHAVIOURS,
    settled_lines_retired: true,
    statement_lineage: "shared",
    contested_statements: false,
    keyed_open_items: false,
    process_memory: false,
} as const;
const W2_BEHAVIOURS = {
    ...SHARED_BEHAVIOURS,
    settled_lines_retired: false,
    statement_lineage: "per-message",
    contested_statements: true,
    keyed_open_items: true,
    process_memory: true,
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
/** The fixture and `eidnara-host` both limit glibc malloc to `C_HEAP_ARENAS` arenas before their runtime starts. */
const arenaProbe = (file: string) =>
    probe("process_memory", file, "daemon::process_memory::limit_c_heap_arenas\\(\\)");

/**
 * The production route, in the fused fixture and in `eidnara-host`, registers search-projection
 * outbox consumers, so automatic delivery there also rests on the canonical memory read serving at any consumer lag and on the projection
 * lifecycle renewing a rebuild whose deadline passed (Eidnara #1208, c8 ISSUES I3). A served
 * projection rests on the lifecycle owner catching up or rebuilding a family that trails past the
 * freshness limit, and its state is read through `search.lifecycle.status` (Eidnara #1211).
 */
const FUSED_SOURCES = [
    "crates/daemon/src/search_lifecycle_owner.rs",
    "crates/daemon/src/search_lifecycle_wire.rs",
    "crates/daemon/src/projection_gates.rs",
];
const FUSED_PROBES = [
    probe(
        "user_statement_delivery",
        "crates/daemon/src/canonical_memory.rs",
        "decide_for_tip_read",
        false,
    ),
    probe("search", "crates/daemon/src/search_lifecycle_owner.rs", "SliceOutcome::Expired"),
    probe("search", "crates/daemon/src/projection_gates.rs", "fn judge_lifecycle_work\\("),
    probe("search_progress", "crates/daemon/src/search_lifecycle_wire.rs", '"lag_commits": lag'),
    probe("search_progress", "crates/daemon/src/search_lifecycle_wire.rs", '"rebuilds": \\{'),
];
/** The fixture's search admission records, which size the production route's bounds. */
const ADMISSION_RECORDS = "crates/daemon/examples/search_admission_records/records.rs";
/**
 * The most commits a served projection trails the kernel tip by on the fused fixture: the reader
 * bound its admission records set (`catchup_lag_commits`). `FUSED_FIXTURE_PROBES` pins the value.
 */
export const FIXTURE_READER_LAG_COMMITS = 1024;
const FUSED_FIXTURE_PROBES = [
    probe(
        "search_progress",
        ADMISSION_RECORDS,
        `pub const READER_LAG_COMMITS: u64 = ${FIXTURE_READER_LAG_COMMITS};`,
    ),
    probe("search_progress", ADMISSION_RECORDS, '\\("catchup_lag_commits", READER_LAG_COMMITS\\)'),
];
const FUSED_NOTES: VariantRecord["notes"] = {
    ...W2_NOTES,
    user_statement_delivery: `${BEHAVIOUR_NOTES.user_statement_delivery}; crates/daemon/src/canonical_memory.rs read_project_memory serves those rows from the canonical tables at the pinned tip at any outbox consumer lag, so the production route's search-projection consumers cannot withhold the block`,
    search: "crates/daemon/src/search_lifecycle_owner.rs reports a Rebuilding record whose deadline passed, or that was stamped ahead of a clock stepped back, as SliceOutcome::Expired, and the slice loop renews it with its attempt and consumer, so a rebuild outlives a clock jump longer than B_recovery_ms",
    search_progress: W2_FUSED_SEARCH_PROGRESS,
};

const LEGACY_FIXTURE_EVIDENCE =
    "crates/daemon/examples/direct_host_fixture.rs started without --query-route keeps the legacy search route and links an 8-dimension deterministic embedding engine; it builds its Handler without a memory reviewer host, and its review-witness control runs MemoryReviewer jobs only on a test's request, against a scripted local provider (direct_host_fixture/review_witness.rs); packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy";
const LEGACY_FIXTURE_PROBES = [
    probe("search", FIXTURE, "\\(None, None\\) => SearchRoute::Legacy"),
    // The fixture installs search admission, and with it the lifecycle owner, on the production route alone.
    probe("search_progress", FIXTURE, "\\(None, None\\) => SearchRoute::Legacy"),
    probe("embeddings", FIXTURE, "struct DeterministicEngine"),
    ...FIXTURE_PROBES,
];

/**
 * What each daemon variant of the w2 build provides, with the Eidnara source that establishes it.
 * Only the fixture's `--harness-runtime` redirect extension points model calls at the proxy; the
 * production launcher refuses that closure.
 */
export const DAEMON_VARIANTS: Record<DaemonVariant, VariantRecord> = {
    "direct-host-fixture": {
        search: "legacy-scan",
        embeddings: "deterministic-fixture",
        memory_reviewer: false,
        side_calls: "proxy",
        source_capture: true,
        ...W2_BEHAVIOURS,
        evidence: LEGACY_FIXTURE_EVIDENCE,
        sources: [...FIXTURE_SOURCES, ...W2_BEHAVIOUR_SOURCES],
        probes: [...LEGACY_FIXTURE_PROBES, ...W2_PROBES, arenaProbe(FIXTURE)],
        notes: W2_NOTES,
    },
    "direct-host-fixture-fused": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: false,
        side_calls: "proxy",
        source_capture: true,
        ...W2_BEHAVIOURS,
        search_progress: true,
        evidence:
            "crates/daemon/examples/direct_host_fixture.rs started with --query-route production --local-embeddings-manifest <payload-manifest.json> sets the production query route limits over the payload's gte-modernbert-base-f32 local embedding lane (payload_local_embeddings.rs), installs search admission from fixture records sized for a whole store (search_admission_records/records.rs), and logs `search route production, embedding model <model>` on stderr; it builds its Handler without a memory reviewer host; packages/e2e-tests/src/rust-runner/hermetic-host.ts passes both flags for productionSearchManifest, and harness-runtime.ts points its closures at the proxy",
        sources: [
            ...FIXTURE_SOURCES,
            ...W2_BEHAVIOUR_SOURCES,
            "crates/daemon/src/bin/eidnara_host/payload_local_embeddings.rs",
            ADMISSION_RECORDS,
            ...FUSED_SOURCES,
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
            ...FUSED_PROBES,
            ...FUSED_FIXTURE_PROBES,
            ...FIXTURE_PROBES,
            ...W2_PROBES,
            arenaProbe(FIXTURE),
        ],
        notes: FUSED_NOTES,
    },
    "production-payload": {
        search: "fused",
        embeddings: "gte-modernbert-base-f32",
        memory_reviewer: true,
        side_calls: "direct-bedrock",
        source_capture: true,
        ...W2_BEHAVIOURS,
        search_progress: true,
        evidence:
            "eidnara-host serve (crates/daemon/src/bin/eidnara_host/serve.rs) admits only the compiled-in QUALIFIED_HARNESS_CLOSURES, runs Pi with --no-extensions and a fresh HOME (crates/host-runtime/src/model_execution/pi.rs), and refuses AWS endpoint overrides (aws_profile.rs), so its model calls cannot reach the sim proxy",
        sources: [
            "crates/daemon/src/bin/eidnara_host/serve.rs",
            "crates/host-runtime/src/model_execution/pi.rs",
            "crates/host-runtime/src/model_execution/aws_profile.rs",
            ...FUSED_SOURCES,
            ...PASS_SOURCES,
            ...MEMORY_INJECTION_SOURCES,
            ...SOURCE_CAPTURE_SOURCES,
            ...W2_BEHAVIOUR_SOURCES,
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
            ...FUSED_PROBES,
            ...SHARED_PROBES,
            ...W2_PROBES,
            arenaProbe("crates/daemon/src/bin/eidnara_host/serve.rs"),
        ],
        notes: FUSED_NOTES,
    },
};

/**
 * One Eidnara build the capability tables were read from: the audited commit, the integration
 * branch it heads, and the daemon variants read there. An arm runs on a build only through a
 * variant the build registers.
 */
export interface AuditedBuild {
    commit: string;
    label: string;
    variants: Partial<Record<DaemonVariant, VariantRecord>>;
}

/**
 * The c8 reference build's legacy fixture, as read for the c8 campaign: keyed status lines that
 * validation retires inside a segment, one statement lineage for the data home, and none of the
 * w2 rework. The c8 campaign ran its fused arms on `eval/c8h`, which this list leaves out.
 */
const C8_BUILD: AuditedBuild = {
    commit: "8e6265d2ccc12c9e9fddd602e4d206c57b6eb52d",
    label: "eval/c8",
    variants: {
        "direct-host-fixture": {
            search: "legacy-scan",
            embeddings: "deterministic-fixture",
            memory_reviewer: false,
            side_calls: "proxy",
            source_capture: true,
            ...C8_BEHAVIOURS,
            evidence: LEGACY_FIXTURE_EVIDENCE,
            sources: [...FIXTURE_SOURCES, ...C8_BEHAVIOUR_SOURCES],
            probes: [...LEGACY_FIXTURE_PROBES, ...C8_PROBES],
            notes: C8_NOTES,
        },
    },
};

/**
 * Every build a run may bind, the current one first. `scripts/audit-eidnara.ts` reads a candidate
 * commit against any of them, and a run records the one its build clone matches in its manifest.
 */
export const AUDITED_BUILDS: readonly [AuditedBuild, ...AuditedBuild[]] = [
    {
        commit: "ae1b673b77651ce8a3b95892fe27f90d9287d869",
        label: "eval/w2b",
        variants: DAEMON_VARIANTS,
    },
    {
        commit: "7901aae3962825be247cc30f2682b6aec39c7ea8",
        label: "eval/w2",
        variants: DAEMON_VARIANTS,
    },
    C8_BUILD,
];

/** The Eidnara commit whose source `DAEMON_VARIANTS` was read from. */
export const AUDITED_EIDNARA = AUDITED_BUILDS[0].commit;

/** A variant's capability values alone, as a run's manifest records them. */
export function capabilitiesOf(record: VariantRecord): DaemonCapabilities {
    const {
        evidence: _evidence,
        notes: _notes,
        sources: _sources,
        probes: _probes,
        ...caps
    } = record;
    return caps;
}

/** The registered build a commit or a label names. */
export const auditedBuild = (name: string): AuditedBuild | undefined =>
    AUDITED_BUILDS.find((b) => b.commit === name || b.label === name);

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
 * Every capability the arm declares that its daemon variant on `build` does not provide, each
 * naming the declared and provided values and the source that fixes the provided one; a variant
 * the build does not register is one gap.
 */
export function capabilityGaps(label: string, build: AuditedBuild = AUDITED_BUILDS[0]): string[] {
    const profile = armProfile(label);
    if (profile.daemon === null) return [];
    const provided = build.variants[profile.daemon];
    if (!provided) {
        return [
            `${label} (${profile.role}) runs ${profile.daemon}, which the audited build ${build.label} (${build.commit}) does not register`,
        ];
    }
    const wanted: Partial<DaemonCapabilities> = { ...profile.requires, search: profile.search };
    return (Object.keys(wanted) as Array<keyof DaemonCapabilities>)
        .filter((key) => wanted[key] !== provided[key])
        .map(
            (key) =>
                `${label} (${profile.role}) needs ${key}=${String(wanted[key])}, but ${profile.daemon} provides ${String(provided[key])}: ${provided.notes?.[key] ?? provided.evidence}`,
        );
}
