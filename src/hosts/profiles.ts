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
    | "eidnara-reviewer"
    | "host-oracle";

/**
 * A run's registered prompt-caching condition, the same for every arm. Under `on` the host places
 * the provider cache points it places for a model it recognises (`piModelName` in `arms.ts`);
 * under `off` the host's own model matching decides, which for Pi 0.80.2 and the Claude 5.5 model
 * ids places none.
 */
export const PROMPT_CACHING = ["off", "on"] as const;
export type PromptCaching = (typeof PROMPT_CACHING)[number];

/** How an arm's memory search answers: none, the plugin's legacy snapshot scan, or the daemon's fused route. */
export type SearchRoute = "none" | "legacy-scan" | "fused";

/** Where a background call's provider cache points sit (`DaemonCapabilities.background_cache_points`). */
export type BackgroundCachePoints = "system-and-message" | "system";

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
     * Whether capture classes each statement of a user message by how long it holds and records
     * the class as `lifetime` in the fact's rationale. A statement classed `lasting` or
     * `unsettled`, or carrying no class, is approved for `<project-memory>`; one classed `status`
     * is stored labeled for explicit search, and so is one classed `current_work` on a build
     * without `current_work_delivery`.
     */
    statement_lifetime: boolean;
    /**
     * Whether a whole user statement classed `current_work` is approved and served to later
     * sessions in the `<CURRENT_WORK>` element that closes `<project-memory>`, until a later whole
     * statement of the user ends it: the row is then rewritten labeled with an `ended_by` record.
     * Such a build also names the class `request`, an instruction its own turn answers, which is
     * stored labeled for explicit search.
     */
    current_work_delivery: boolean;
    /**
     * Whether a delivered `<project-memory>` block ends, on the line before its closing tag, with
     * the sentence that calls its lines a partial record of the project's sessions.
     */
    block_closing_sentence: boolean;
    /**
     * Whether `<project-memory>` opens with a `<NAMED_FILES>` element listing project files a
     * message of the user named and the agent then used, each with the time it last changed, and
     * a `User stated:` line of such a block ends with the minute memory recorded it, in square
     * brackets.
     */
    named_files: boolean;
    /**
     * Whether a user statement that replaced an earlier observation renders with the day it was
     * stated and the day the replaced value was recorded.
     */
    replaced_observation_date: boolean;
    /**
     * Whether the daemon records a failed command of a Pi session as a fact of category
     * `TOOL_FAILURE` on a `tool_failure` lineage, served on explicit search alone.
     */
    failed_command_records: boolean;
    /**
     * Whether, under the user-tier `memory_reviewer.enabled` switch, the daemon's worker reviews
     * stored memories in two stages through the host's model execution and writes `contested`
     * marks and `disputed` labels. `memory_reviewer` says whether the variant installs the
     * reviewer host the worker runs on.
     */
    memory_review: boolean;
    /**
     * Whether a gated memory read is judged by the consumers a search serves from, and the
     * plugin's snapshot scan answers a read that a lagging consumer gates from the canonical tip
     * with the note `Memory: a search consumer is behind recent changes. These results are read
     * from the canonical tip and include them.` A build without it answers that state with the
     * error `Memory results may lag recent changes; the projector has not caught up.`
     */
    search_tip_read_while_lagging: boolean;
    /**
     * Whether a review selection enqueues the memories of the delivered block first and names
     * the group on each `enqueued` log line (`delivery=automatic|search`), and the reviewer's
     * status block counts the projects at their review-metadata quota
     * (`projects_at_metadata_quota`), each logged once per daemon process.
     */
    review_selection_by_delivery: boolean;
    /**
     * The cache points a background call (memory capture, a daemon-run call) carries under
     * prompt caching on for a model Pi recognises: one after the system prompt and one at the end
     * of its single user message (`system-and-message`, what Pi's client places), or the system
     * prompt's alone (`system`), where the capture executor and the bundled model-execution hook
     * remove cache markers from user messages.
     */
    background_cache_points: BackgroundCachePoints;
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
const W3_NOTES: VariantRecord["notes"] = {
    statement_lifetime:
        "crates/daemon/src/memory_capture.rs reads the extractor's `lifetime` of each proposal of a user source (lasting, current_work, status, unsettled), writes it into the fact's rationale, and approves a whole user statement only when its class outlives its task (lasting, unsettled, or no class); a current_work or status statement commits as a labeled memory for explicit search with no statement record",
    background_cache_points:
        "packages/pi-plugin/src/memory-capture-native.ts passes withoutConversationCacheMarkers as the capture call's onPayload, and crates/host-runtime/assets/pi-model_execution-extension.mjs applies the same function to a daemon-run call's messages before the provider request, so a background call keeps the cache marker of its system prompt and carries none on its user message; crates/host-runtime/src/model_execution/pi.rs starts every Pi model-execution run in one working directory under the state root, so the system prompt Pi ends with that directory is the same text on every run",
};
const W4_NOTES: VariantRecord["notes"] = {
    statement_lifetime:
        "crates/daemon/src/memory_capture.rs reads the extractor's `lifetime` of each proposal of a user source (lasting, current_work, request, status, unsettled), writes it into the fact's rationale, and approves a whole user statement whose class is eligible (lasting, unsettled, current_work, or no class); a request or status statement commits as a labeled memory for explicit search with no statement record",
    current_work_delivery:
        'crates/daemon/src/canonical_memory.rs gives a served capture memory whose rationale names lifetime current_work the category CURRENT_WORK, newest first by the commit that first recorded it, and crates/daemon/src/m0_compose.rs trim_block_to_budget admits those rows after the lasting rows within a quarter of memory.injection_budget_tokens; crates/daemon/src/memory_render.rs renders them last in `<CURRENT_WORK note="...">`; a later whole user statement that names such a row under replaces or also_replaces ends it: crates/daemon/src/memory_capture.rs rewrite_statement supersedes it with a labeled row whose rationale holds ended_by {memory, session}; packages/opencode-plugin/src/tools/eidnara-search/render.ts shows `lifetime=current_work state=live|ended` on a search result',
};
const W9_NOTES: VariantRecord["notes"] = {
    block_closing_sentence:
        "crates/daemon/src/memory_render.rs render_delivered_memory_block writes PROJECT_MEMORY_NOTE on the line before `</project-memory>` of every delivered block, and crates/daemon/src/m0_compose.rs composes the session's block through it and charges the frame (delivered_memory_frame) to the memory budget",
    named_files:
        'crates/daemon/src/named_files.rs records a project file that a message of the user named and a tool call of the same turn then used, and delivered() lists up to MAX_DELIVERED of them to other sessions as `<path> (the agent used it in <n> earlier session(s), last on <day>; last changed <minute>|<minute> on disk|at a time the read history does not show)`; crates/daemon/src/memory_render.rs renders them first, in `<NAMED_FILES note="...">`, without an object id; in a read that lists a file, mark_recorded appends ` [<minute>]` to each `User stated:` line no other mark rewrote (crates/daemon/src/canonical_memory.rs read_at_tip calls date_statements)',
    replaced_observation_date:
        "crates/daemon/src/memory_capture.rs records `replaces_observation` in the rationale of a user statement that replaced an observation, and crates/daemon/src/canonical_memory.rs replaced_line renders its line as `<statement> (stated <day>; it replaces a value recorded <day> that the user had not stated)`, a day the commit log lacks reading `unknown date`",
    failed_command_records:
        "crates/daemon/src/memory_capture/failures.rs writes one labeled row of category TOOL_FAILURE (FAILURE_CATEGORY, the row's decision_kind) for a tool result the harness marks as an error, on the source lineage `tool_failure:<digest of the command line>`, under the source-capture consent; a later marked result of the command supersedes the row and a later unmarked one rewrites it as resolved; the block renders positive categories only, so the row is served on explicit search",
    memory_review:
        "crates/daemon/src/config.rs reads the user-only keys /memory_reviewer/enabled, /model, /stage1_model, /apply, and /classifier, and an enabled switch sets source_capture_enabled and contradiction_candidates_enabled; crates/daemon/src/memory_reviewer/worker.rs switched_pass reviews the stored memories of a switched project every IDLE_INTERVAL (30 s) while idle: review_cycle.rs selects and enqueues jobs, coordinator.rs asks stage 1 (stage_one.rs, the small chat model) through the host's model execution and, for a flagged review, the review model for a proposal, and the worker applies it by the mode (`contest`: a `disputed` label through the Kernel's mark_disputed, or a `contested` mark on a user statement)",
};
const WM_NOTES: VariantRecord["notes"] = {
    block_closing_sentence:
        "crates/daemon/src/memory_render.rs render_delivered_memory_block renders the rows through render_block with PROJECT_MEMORY_NOTE as its note, which render_block writes on its own line before `</project-memory>`, and crates/daemon/src/m0_compose.rs composes the session's block through it and charges the frame (delivered_memory_frame) to the memory budget",
    memory_review:
        "crates/daemon/src/config.rs reads the user-only keys /memory_reviewer/enabled, /model, /stage1_model, /apply, and /classifier, and an enabled switch sets source_capture_enabled and contradiction_candidates_enabled; crates/daemon/src/memory_reviewer/worker.rs switched_pass reviews the stored memories of a switched project every IDLE_INTERVAL (30 s) while idle: review_cycle.rs selects and enqueues jobs on evidence written after the memory was stated by a writer who may change it (stage_one.rs takes_evidence: the user for a user statement and an assistant report, any writer for work in progress and a note), coordinator.rs asks stage 1 (the small chat model) through the host's model execution and, for a flagged review, the review model for a proposal, and the worker applies it by the mode (`contest`: a `disputed` label through the Kernel's mark_disputed, a `contested` mark on a user statement, and `standing` with nothing written for a revise of an assistant report)",
    search_tip_read_while_lagging:
        "crates/daemon/src/kernel_routes/read.rs judges a gated kernel.read by outbox_lag_excluding the consumers serving.rs unserved_consumers names: the reviewer's claim consumer on a host where crates/daemon/src/lib.rs has set no claims_feed_search (no search lifecycle owner); packages/opencode-plugin/src/tools/eidnara-search/execute.ts canonicalTipNote turns a `stale` read and a `no_required_consumer` read into a note, and the snapshot scan repeats the read ungated and answers from the canonical tip",
    review_selection_by_delivery:
        "crates/daemon/src/memory_reviewer/review_cycle.rs select_and_enqueue orders its candidates with the memories of the delivered block first and logs `enqueued job=<id> trigger=<t> later=<n> source=<n> delivery=<automatic|search>`; a reservation the store's review metadata quota refuses logs `selection queues no new review for a project` once per project and process, and crates/memory-store/src/lib.rs counts such projects as projects_at_metadata_quota in the memory_reviewer block of the Context module's status answer",
};
const W9_FIXTURE_REVIEWER_NOTE =
    "crates/daemon/examples/direct_host_fixture.rs builds its Handler with_memory_reviewer_host over its own model-execution supervisor, so the worker runs as under eidnara-host, and answers the control `review-drain` (ControlCommand::ReviewDrain, HandlerCore::drain_memory_reviewer), which packages/e2e-tests/src/rust-runner/hermetic-host.ts exposes as reviewDrain(timeoutMs)";
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
/** The Pi plugin's capture executor and the hook the daemon's child Pi loads: the two places a background call's payload passes. */
const CAPTURE_EXECUTOR = "packages/pi-plugin/src/memory-capture-native.ts";
const EXECUTION_HOOK = "crates/host-runtime/assets/pi-model_execution-extension.mjs";
/** Sources every build reads its shared behaviours from. */
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
    CAPTURE_EXECUTOR,
    EXECUTION_HOOK,
    "crates/host-runtime/src/model_execution/pi.rs",
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
/** A build before the w3 changes: capture approves by quotation alone, and a background call keeps Pi's two cache markers. */
const BEFORE_W3_PROBES = [
    probe(
        "statement_lifetime",
        "crates/daemon/src/memory_capture.rs",
        "Lifetime::outlives_its_task",
        false,
    ),
    probe("background_cache_points", CAPTURE_EXECUTOR, "withoutConversationCacheMarkers", false),
    probe("background_cache_points", EXECUTION_HOOK, "withoutConversationCacheMarkers", false),
];
/** The w3 build's readings of the same two behaviours. */
const W3_PROBES = [
    probe(
        "statement_lifetime",
        "crates/daemon/src/memory_capture.rs",
        "memory\\.lifetime\\.is_none_or\\(Lifetime::outlives_its_task\\)",
    ),
    probe(
        "statement_lifetime",
        "crates/daemon/src/memory_capture.rs",
        'rationale\\.insert\\("lifetime"\\.to_owned\\(\\), json!\\(lifetime\\)\\)',
    ),
    probe(
        "background_cache_points",
        CAPTURE_EXECUTOR,
        "onPayload: withoutConversationCacheMarkers",
    ),
    probe(
        "background_cache_points",
        EXECUTION_HOOK,
        "next\\.messages = withoutConversationCacheMarkers\\(next\\.messages\\)",
    ),
];
/** A build before the w4 change: `<project-memory>` has no element for work in progress, and no row records an end. */
const BEFORE_W4_PROBES = [
    probe("current_work_delivery", "crates/daemon/src/memory_capture.rs", "fn is_eligible", false),
    probe("current_work_delivery", "crates/daemon/src/memory_capture.rs", "ended_by", false),
];
const MEMORY_RENDER = "crates/daemon/src/memory_render.rs";
/** The w4 build's readings of the same behaviour. */
const W4_PROBES = [
    probe(
        "current_work_delivery",
        "crates/daemon/src/memory_capture.rs",
        "Self::Lasting \\| Self::Unsettled \\| Self::CurrentWork => true",
    ),
    probe(
        "current_work_delivery",
        "crates/daemon/src/memory_capture.rs",
        "Self::Request \\| Self::Status => false",
    ),
    probe(
        "current_work_delivery",
        "crates/daemon/src/memory_capture.rs",
        'rationale\\.insert\\("ended_by"\\.to_owned\\(\\), json!\\(end\\)\\)',
    ),
    probe(
        "current_work_delivery",
        MEMORY_RENDER,
        'const CURRENT_WORK_SECTION: &str = "CURRENT_WORK"',
    ),
    probe(
        "current_work_delivery",
        "crates/daemon/src/canonical_memory.rs",
        "CURRENT_WORK_SECTION\\.to_owned\\(\\)",
    ),
    probe("current_work_delivery", "crates/daemon/src/m0_compose.rs", "fn trim_block_to_budget"),
];
const NAMED_FILES = "crates/daemon/src/named_files.rs";
const FAILURES = "crates/daemon/src/memory_capture/failures.rs";
const REVIEW_WORKER = "crates/daemon/src/memory_reviewer/worker.rs";
const REVIEW_CYCLE = "crates/daemon/src/memory_reviewer/review_cycle.rs";
const REVIEW_STAGE_ONE = "crates/daemon/src/memory_reviewer/stage_one.rs";
const REVIEW_COORDINATOR = "crates/daemon/src/memory_reviewer/coordinator.rs";
/** The sources the w9 table reads beside the w4 table's. */
const W9_SOURCES = [
    NAMED_FILES,
    FAILURES,
    REVIEW_WORKER,
    REVIEW_CYCLE,
    REVIEW_STAGE_ONE,
    REVIEW_COORDINATOR,
];
/**
 * A build before the w9 changes: the block ends at its last element, lists no named file, dates
 * no replaced observation, and the daemon records no failed command and reads no reviewer switch.
 */
const BEFORE_W9_PROBES = [
    probe(
        "block_closing_sentence",
        "crates/daemon/src/m0_compose.rs",
        "render_delivered_memory_block",
        false,
    ),
    probe("named_files", "crates/daemon/src/lib.rs", "mod named_files", false),
    probe("named_files", "crates/daemon/src/canonical_memory.rs", "named_files::", false),
    probe(
        "replaced_observation_date",
        "crates/daemon/src/canonical_memory.rs",
        "fn replaced_line",
        false,
    ),
    probe(
        "replaced_observation_date",
        "crates/daemon/src/memory_capture.rs",
        "replaces_observation",
        false,
    ),
    probe("failed_command_records", "crates/daemon/src/memory_capture.rs", "mod failures", false),
    probe("memory_review", "crates/daemon/src/config.rs", "/memory_reviewer/enabled", false),
    // A build that reads no reviewer switch selects nothing for review.
    probe(
        "review_selection_by_delivery",
        "crates/daemon/src/config.rs",
        "/memory_reviewer/enabled",
        false,
    ),
];
/** The w9 build's reading of the delivered block's frame, whose source text differs on `eval/wM`. */
const W9_BLOCK_FRAME = probe(
    "block_closing_sentence",
    MEMORY_RENDER,
    'format!\\("\\{DELIVERED_OPEN\\}\\{elements\\}\\{PROJECT_MEMORY_NOTE\\}\\\\n\\{DELIVERED_CLOSE\\}"\\)',
);
/** The w9 build's `enqueued` log line, which ends at its `source=` field. */
const W9_ENQUEUED_LINE = probe(
    "memory_review",
    REVIEW_CYCLE,
    '"daemon: memory_reviewer enqueued job=\\{\\} trigger=\\{\\} later=\\{\\} source=\\{\\}"',
);
/** The w9 build's reviewer selects by evidence alone: its `enqueued` line names no delivery group. */
const W9_SELECTION_PROBES = [
    probe("review_selection_by_delivery", REVIEW_CYCLE, "delivery=", false),
    probe("review_selection_by_delivery", REVIEW_CYCLE, "candidate\\.delivered", false),
];
/** The w9 build's readings of the same behaviours. */
const W9_PROBES = [
    probe(
        "block_closing_sentence",
        MEMORY_RENDER,
        "pub\\(crate\\) const PROJECT_MEMORY_NOTE: &str = \"The lines above are a partial record of this project's sessions: they hold what was said or recorded there, and conventions kept in the repository's files stay in those files\\.\"",
    ),
    W9_BLOCK_FRAME,
    probe(
        "block_closing_sentence",
        "crates/daemon/src/m0_compose.rs",
        "let project_memory = render_delivered_memory_block\\(selected_memories\\)",
    ),
    probe(
        "named_files",
        MEMORY_RENDER,
        'pub\\(crate\\) const NAMED_FILES_SECTION: &str = "NAMED_FILES"',
    ),
    probe(
        "named_files",
        MEMORY_RENDER,
        "pub\\(crate\\) const SECTIONS_BEFORE_FACTS: &\\[&str\\] = &\\[NAMED_FILES_SECTION\\]",
    ),
    probe("named_files", MEMORY_RENDER, "if memory\\.category != NAMED_FILES_SECTION"),
    probe(
        "named_files",
        NAMED_FILES,
        '"\\{path\\} \\(the agent used it in \\{\\} earlier session\\{\\}, last on \\{\\}\\{LAST_CHANGE_CLAUSE\\}\\{\\}\\)"',
    ),
    probe("named_files", NAMED_FILES, 'const LAST_CHANGE_CLAUSE: &str = "; last changed "'),
    probe("named_files", NAMED_FILES, 'at\\.format\\("%Y-%m-%dT%H:%MZ"\\)'),
    probe(
        "named_files",
        NAMED_FILES,
        '\\.push_str\\(&format!\\(" \\[\\{\\}\\]", minute\\(\\*at_ms\\)\\)\\)',
    ),
    probe(
        "named_files",
        "crates/daemon/src/canonical_memory.rs",
        "crate::named_files::date_statements\\(&store, &mut response, &statements\\)",
    ),
    probe(
        "replaced_observation_date",
        "crates/daemon/src/canonical_memory.rs",
        '"\\{statement\\} \\(stated \\{\\}; it replaces a value recorded \\{\\} that the user had not stated\\)"',
    ),
    probe(
        "replaced_observation_date",
        "crates/daemon/src/canonical_memory.rs",
        "crate::memory_capture::replaced_observation_commit\\(decision\\)",
    ),
    probe(
        "replaced_observation_date",
        "crates/daemon/src/memory_capture.rs",
        'const REPLACES_OBSERVATION: &str = "replaces_observation"',
    ),
    probe("failed_command_records", "crates/daemon/src/memory_capture.rs", "\\nmod failures;\\n"),
    probe(
        "failed_command_records",
        FAILURES,
        'pub\\(crate\\) const FAILURE_SOURCE_ID: &str = "tool_failure"',
    ),
    probe(
        "failed_command_records",
        FAILURES,
        'pub\\(crate\\) const FAILURE_CATEGORY: &str = "TOOL_FAILURE"',
    ),
    probe(
        "failed_command_records",
        FAILURES,
        'format!\\("\\{FAILURE_SOURCE_ID\\}:\\{digest\\}"\\)',
    ),
    probe("failed_command_records", FAILURES, "decision_kind: FAILURE_CATEGORY\\.into\\(\\)"),
    probe(
        "memory_review",
        "crates/daemon/src/config.rs",
        'Self::MemoryReviewerEnabled => "/memory_reviewer/enabled"',
    ),
    probe(
        "memory_review",
        "crates/daemon/src/config.rs",
        'Self::MemoryReviewerStage1Model => "/memory_reviewer/stage1_model"',
    ),
    probe(
        "memory_review",
        "crates/daemon/src/config.rs",
        'Self::MemoryReviewerApply => "/memory_reviewer/apply"',
    ),
    probe("memory_review", REVIEW_WORKER, "async fn switched_pass\\("),
    probe(
        "memory_review",
        REVIEW_WORKER,
        "pub const IDLE_INTERVAL: Duration = Duration::from_secs\\(30\\)",
    ),
    probe("memory_review", REVIEW_WORKER, "pub async fn drain\\("),
    probe(
        "memory_review",
        REVIEW_WORKER,
        '"daemon: memory_reviewer applied a proposal: job=\\{\\} \\{\\}"',
    ),
    W9_ENQUEUED_LINE,
    probe(
        "memory_review",
        REVIEW_COORDINATOR,
        '"daemon: memory_reviewer stage 1 job=\\{\\} decider=\\{\\} model=\\{\\} request=\\{\\} decision=\\{\\} \\{shown\\} later=\\{\\}"',
    ),
    probe(
        "memory_review",
        REVIEW_STAGE_ONE,
        "pub const FAILURE_COOLDOWN: Duration = Duration::from_secs\\(60\\)",
    ),
    ...W9_SELECTION_PROBES,
];
const SEARCH_EXECUTE = "packages/opencode-plugin/src/tools/eidnara-search/execute.ts";
const KERNEL_READ = "crates/daemon/src/kernel_routes/read.rs";
const KERNEL_SERVING = "crates/daemon/src/kernel_routes/serving.rs";
const MEMORY_STORE = "crates/memory-store/src/lib.rs";
/** The sources the wM table reads beside the w9 table's. */
const WM_SOURCES = [SEARCH_EXECUTE, KERNEL_READ, KERNEL_SERVING, MEMORY_STORE];
/**
 * A build before the wM changes: a gated read counts every registered consumer, so the daemon
 * holds no record of whether the claim consumer feeds a search.
 */
const BEFORE_WM_PROBES = [
    probe("search_tip_read_while_lagging", "crates/daemon/src/lib.rs", "claims_feed_search", false),
];
/** The wM build's readings of the two w9 readings it rewrote and of its own two behaviours. */
const WM_PROBES = [
    probe(
        "block_closing_sentence",
        MEMORY_RENDER,
        'render_block\\(memories, "project-memory", Some\\(PROJECT_MEMORY_NOTE\\)\\)',
    ),
    probe(
        "block_closing_sentence",
        MEMORY_RENDER,
        "block\\.push\\('\\\\n'\\);\\s*block\\.push_str\\(note\\);",
    ),
    probe(
        "block_closing_sentence",
        MEMORY_RENDER,
        'format!\\("\\{DELIVERED_OPEN\\}\\{PROJECT_MEMORY_NOTE\\}\\\\n\\{DELIVERED_CLOSE\\}"\\)',
    ),
    probe(
        "memory_review",
        REVIEW_CYCLE,
        '"daemon: memory_reviewer enqueued job=\\{\\} trigger=\\{\\} later=\\{\\} source=\\{\\} ',
    ),
    probe(
        "memory_review",
        REVIEW_STAGE_ONE,
        "pub fn takes_evidence\\(said_by: Writer, work_in_progress: bool, writer: Writer\\) -> bool",
    ),
    probe(
        "search_tip_read_while_lagging",
        "crates/daemon/src/lib.rs",
        "kernel\\.set_claims_feed_search\\(\\);",
    ),
    probe(
        "search_tip_read_while_lagging",
        KERNEL_SERVING,
        "pub fn unserved_consumers\\(claims_feed_search: bool\\) -> &'static \\[&'static str\\]",
    ),
    probe(
        "search_tip_read_while_lagging",
        KERNEL_READ,
        "\\.outbox_lag_excluding\\(now_ms, unserved\\)",
    ),
    probe(
        "search_tip_read_while_lagging",
        SEARCH_EXECUTE,
        "function canonicalTipNote\\(state: MemoryState\\): string \\| undefined",
    ),
    probe(
        "search_tip_read_while_lagging",
        SEARCH_EXECUTE,
        '"Memory: a search consumer is behind recent changes\\. These results are read from the canonical tip and include them\\."',
    ),
    probe(
        "search_tip_read_while_lagging",
        SEARCH_EXECUTE,
        "const freshnessNote = memory\\.state \\? canonicalTipNote\\(memory\\.state\\) : undefined;",
    ),
    probe(
        "review_selection_by_delivery",
        REVIEW_CYCLE,
        '"daemon: memory_reviewer enqueued job=\\{\\} trigger=\\{\\} later=\\{\\} source=\\{\\} delivery=\\{\\}"',
    ),
    probe(
        "review_selection_by_delivery",
        REVIEW_CYCLE,
        "std::cmp::Reverse\\(a\\.delivered\\),\\s*std::cmp::Reverse\\(a\\.recency\\),",
    ),
    probe(
        "review_selection_by_delivery",
        REVIEW_CYCLE,
        'if candidate\\.delivered \\{\\s*"automatic"\\s*\\} else \\{\\s*"search"\\s*\\}',
    ),
    probe(
        "review_selection_by_delivery",
        REVIEW_CYCLE,
        "candidate\\.delivered = delivered\\.contains\\(&candidate\\.decision\\.object_id\\);",
    ),
    probe(
        "review_selection_by_delivery",
        REVIEW_CYCLE,
        "\"daemon: memory_reviewer selection queues no new review for a project: the store's review metadata quota refused the reservation \\(",
    ),
    probe("review_selection_by_delivery", MEMORY_STORE, "pub projects_at_metadata_quota: u64,"),
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
    ...BEFORE_W3_PROBES,
    ...BEFORE_W4_PROBES,
    ...BEFORE_W9_PROBES,
    ...BEFORE_WM_PROBES,
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
    ...BEFORE_W3_PROBES,
    ...BEFORE_W4_PROBES,
    ...BEFORE_W9_PROBES,
    ...BEFORE_WM_PROBES,
];
const SHARED_BEHAVIOURS = {
    memory_injection: "switchable",
    user_statement_delivery: true,
    whole_small_tool_outputs: true,
    failure_lines_captured: true,
    stream_tags_stripped: true,
    search_progress: false,
    statement_lifetime: false,
    current_work_delivery: false,
    block_closing_sentence: false,
    named_files: false,
    replaced_observation_date: false,
    failed_command_records: false,
    memory_review: false,
    search_tip_read_while_lagging: false,
    review_selection_by_delivery: false,
    background_cache_points: "system-and-message",
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
/** The w9 fixture's reviewer host and the control that drains its worker. */
const W9_FIXTURE_REVIEWER_PROBES = [
    probe("memory_reviewer", FIXTURE, "\\.with_memory_reviewer_host\\(memory_reviewer_host\\)"),
    probe("memory_reviewer", FIXTURE, "ControlCommand::ReviewDrain => core"),
    probe(
        "memory_reviewer",
        "packages/e2e-tests/src/rust-runner/hermetic-host.ts",
        "async reviewDrain\\(timeoutMs: number\\): Promise<number>",
    ),
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
 * What each daemon variant of the two w2 builds provides, with the Eidnara source that establishes it.
 * Only the fixture's `--harness-runtime` redirect extension points model calls at the proxy; the
 * production launcher refuses that closure.
 */
export const W2_VARIANTS: Record<DaemonVariant, VariantRecord> = {
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
 * What each daemon variant of the `eval/w3-all` build provides: the w2 builds' table with the
 * lifetime class on captured statements and the system prompt's cache point alone on a
 * background call.
 */
export const W3_VARIANTS = Object.fromEntries(
    Object.entries(W2_VARIANTS).map(([variant, record]): [string, VariantRecord] => [
        variant,
        {
            ...record,
            statement_lifetime: true,
            background_cache_points: "system",
            probes: [...record.probes.filter((p) => !BEFORE_W3_PROBES.includes(p)), ...W3_PROBES],
            notes: { ...record.notes, ...W3_NOTES },
        },
    ]),
) as Record<DaemonVariant, VariantRecord>;

/**
 * What each daemon variant of the `eval/w4` build and of the main commit `ea12bff2a` provides:
 * the w3 build's table with work in progress approved and served in its own element of
 * `<project-memory>`.
 */
export const W4_VARIANTS = Object.fromEntries(
    Object.entries(W3_VARIANTS).map(([variant, record]): [string, VariantRecord] => [
        variant,
        {
            ...record,
            current_work_delivery: true,
            sources: [...record.sources, MEMORY_RENDER],
            probes: [...record.probes.filter((p) => !BEFORE_W4_PROBES.includes(p)), ...W4_PROBES],
            notes: { ...record.notes, ...W4_NOTES },
        },
    ]),
) as Record<DaemonVariant, VariantRecord>;

/** The fixture's own reading of `memory_reviewer` on a build before w9: it installs no reviewer host. */
const isFixtureWithoutReviewer = (p: SourceProbe) =>
    p.capability === "memory_reviewer" && p.file === FIXTURE && !p.present;
const W9_FIXTURE_EVIDENCE: Partial<Record<DaemonVariant, string>> = {
    "direct-host-fixture":
        "crates/daemon/examples/direct_host_fixture.rs started without --query-route keeps the legacy search route and links an 8-dimension deterministic embedding engine; it builds its Handler with a memory reviewer host over its own model execution; packages/e2e-tests/src/bedrock-peer/harness-runtime.ts points its closures at the proxy",
    "direct-host-fixture-fused":
        "crates/daemon/examples/direct_host_fixture.rs started with --query-route production --local-embeddings-manifest <payload-manifest.json> sets the production query route limits over the payload's gte-modernbert-base-f32 local embedding lane (payload_local_embeddings.rs), installs search admission from fixture records sized for a whole store (search_admission_records/records.rs), and logs `search route production, embedding model <model>` on stderr; it builds its Handler with a memory reviewer host over its own model execution; packages/e2e-tests/src/rust-runner/hermetic-host.ts passes both flags for productionSearchManifest, and harness-runtime.ts points its closures at the proxy",
};

/**
 * What each daemon variant of the `eval/w9` build provides: the w4 table with the block's
 * closing sentence, the named files and recorded minutes, the dated replacement mark,
 * failed-command records, and the memory review under the user-tier switch. Both fixture
 * variants install a reviewer host, so the worker runs in the fixture as under `eidnara-host`.
 */
export const W9_VARIANTS = Object.fromEntries(
    Object.entries(W4_VARIANTS).map(([variant, record]): [string, VariantRecord] => {
        const fixture = variant !== "production-payload";
        return [
            variant,
            {
                ...record,
                block_closing_sentence: true,
                named_files: true,
                replaced_observation_date: true,
                failed_command_records: true,
                memory_review: true,
                memory_reviewer: true,
                evidence: W9_FIXTURE_EVIDENCE[variant as DaemonVariant] ?? record.evidence,
                sources: [...record.sources, ...W9_SOURCES],
                probes: [
                    ...record.probes.filter(
                        (p) => !BEFORE_W9_PROBES.includes(p) && !isFixtureWithoutReviewer(p),
                    ),
                    ...W9_PROBES,
                    ...(fixture ? W9_FIXTURE_REVIEWER_PROBES : []),
                ],
                notes: {
                    ...record.notes,
                    ...W9_NOTES,
                    ...(fixture ? { memory_reviewer: W9_FIXTURE_REVIEWER_NOTE } : {}),
                },
            },
        ];
    }),
) as Record<DaemonVariant, VariantRecord>;

/** The w9 table's readings the wM table replaces with its own. */
const READ_AGAIN_AT_WM: readonly SourceProbe[] = [
    W9_BLOCK_FRAME,
    W9_ENQUEUED_LINE,
    ...W9_SELECTION_PROBES,
    ...BEFORE_WM_PROBES,
];

/**
 * What each daemon variant of the current build (`eval/wM`) provides: the w9 table with a gated
 * read judged by the consumers a search serves from, the snapshot scan's answer from the
 * canonical tip while such a consumer lags, and a review selection that takes the delivered
 * block's memories first and names the group in its log.
 */
export const DAEMON_VARIANTS = Object.fromEntries(
    Object.entries(W9_VARIANTS).map(([variant, record]): [string, VariantRecord] => [
        variant,
        {
            ...record,
            search_tip_read_while_lagging: true,
            review_selection_by_delivery: true,
            sources: [...record.sources, ...WM_SOURCES],
            probes: [...record.probes.filter((p) => !READ_AGAIN_AT_WM.includes(p)), ...WM_PROBES],
            notes: { ...record.notes, ...WM_NOTES },
        },
    ]),
) as Record<DaemonVariant, VariantRecord>;

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
        commit: "f618ce77e6f0e2a5be96390c2c1375b3809a97c7",
        label: "eval/wM",
        variants: DAEMON_VARIANTS,
    },
    {
        commit: "4c293f1835960b8d60b55756933f196ecd12d007",
        label: "eval/w9",
        variants: W9_VARIANTS,
    },
    {
        commit: "ea12bff2adb028d942d3b339de6dc74b605ab1ab",
        label: "main-ea12bff2a",
        variants: W4_VARIANTS,
    },
    {
        commit: "6aabc77e16cb2765a4a59ccd5898688b787e8b69",
        label: "eval/w4",
        variants: W4_VARIANTS,
    },
    {
        commit: "a996cc46602659e6225fd850395e2e988048648e",
        label: "eval/w3-all",
        variants: W3_VARIANTS,
    },
    {
        commit: "ae1b673b77651ce8a3b95892fe27f90d9287d869",
        label: "eval/w2b",
        variants: W2_VARIANTS,
    },
    {
        commit: "7901aae3962825be247cc30f2682b6aec39c7ea8",
        label: "eval/w2",
        variants: W2_VARIANTS,
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
    /**
     * Set on the arm that writes Eidnara's user-only `memory_reviewer` switch to the daemon and
     * plugin user tiers, in `contest` mode with the arm's side model as the review model and the
     * run's registered stage-1 model. The switch also turns on the daemon's
     * contradiction-candidate pass. Absent on the arms that predate it, which write no such key,
     * so their recorded profiles stand.
     */
    memory_reviewer?: true;
}

/** Whether the arm writes the `memory_reviewer` switch. */
export const reviewsMemory = (profile: ArmProfile): boolean => profile.memory_reviewer === true;

/** An arm's delivery mode: its declared one, or automatic with the plugin and none without. */
export const deliveryOf = (profile: ArmProfile): Delivery =>
    profile.delivery ?? (profile.plugin ? "automatic" : "none");

/**
 * Whether two arms run one treatment: the same delivery mode, the same search route, and the
 * same reviewer switch. A contrast pairs arms that differ in at least one.
 */
export const sameTreatment = (a: ArmProfile, b: ArmProfile): boolean =>
    deliveryOf(a) === deliveryOf(b) &&
    a.search === b.search &&
    reviewsMemory(a) === reviewsMemory(b);

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
    // The eidnara arm with the memory reviewer switched on, which the fixture's reviewer host runs.
    "eidnara-reviewer": {
        role: "fallback-search",
        daemon: "direct-host-fixture",
        plugin: true,
        eidnara_compaction: true,
        host_compaction: false,
        search: "legacy-scan",
        source_capture: true,
        memory_reviewer: true,
        requires: {
            ...C8_EIDNARA,
            source_capture: true,
            memory_reviewer: true,
            memory_review: true,
        },
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
