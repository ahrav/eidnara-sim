import { Database } from "bun:sqlite";
import {
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
} from "node:fs";
import { join } from "node:path";
import { bodyText, injectedBlocks } from "../evidence/stages";
import { payloadManifest, processMemoryBlock, progressBlock } from "../hosts/arms";
import {
    type ArmProfile,
    AUDITED_BUILDS,
    type AuditedBuild,
    armProfile,
    type BackgroundCachePoints,
    type DaemonCapabilities,
    type DaemonVariant,
    deliveryOf,
    FIXTURE_READER_LAG_COMMITS,
    type PromptCaching,
} from "../hosts/profiles";
import type { ConverseBody } from "../proxy/classify";
import { type CallRecord, HARNESS_COMPONENTS } from "../proxy/records";
import {
    bodyCachePoints,
    cachePointsOf,
    type PartLookup,
    placePiCachePoints,
    rebuildRequest,
} from "../proxy/requests";
import { ORACLE_OPENING } from "./oracle-note";

/** The model-call components only the Eidnara plugin and daemon make. */
export const EIDNARA_COMPONENTS = [
    "history_summarizer",
    "memory_capture",
    "memory_classifier",
    "context_researcher",
] as const;

/** What an arm's run evidence shows it ran. */
export interface ArmObservation {
    arm: string;
    host: "pi" | "opencode";
    /**
     * Plugin boots by outcome; Pi's boot line also names whether the transform registered, and a
     * Pi boot line naming neither mode counts as `transform_unknown`.
     */
    boots: {
        enabled: number;
        transform_on: number;
        transform_off: number;
        transform_unknown: number;
        disabled: string[];
    };
    /** Plugin-log lines for a pass the daemon served through the transform. */
    transform_passes: number;
    /** Of those, the passes whose output holds fewer messages than their input: a fold or a drop. */
    narrowing_passes: number;
    /** Of those, the passes whose line names no `in=` and `out=` counts, so neither can be compared. */
    unsized_passes: number;
    /**
     * `eidnara_search` results in the host transcripts: the legacy scan's fallback reasons, the
     * successful results the fused route answered (every success without the fallback note), and
     * the results that reported an error; null where the host's transcripts are not read.
     */
    search: {
        legacy_scan: string[];
        fused: number;
        errored: number;
        /** Results holding a `Contested by` line; absent on observations recorded before it was read. */
        contested?: number;
    } | null;
    /** Proxy call records of the arm, by component. */
    components: Record<string, number>;
    /** What the arm's agent requests carried; null where the run's arms need no request read. */
    delivery?: DeliveryObservation | null;
    /** The arm's source capture evidence; absent on observations recorded before it was read. */
    source_capture?: SourceCaptureObservation;
    /** The user statements in the arm's final store; absent on observations recorded before it was read. */
    statements?: StatementObservation;
    /** The daemon starts in the arm's `daemon.log`; absent on observations recorded before it was read. */
    daemon_routes?: DaemonRouteObservation;
    /** The daemon status readings in the arm's `resources.jsonl`; absent on observations recorded before they were read. */
    daemon_status?: DaemonStatusObservation;
    /** The cache points and cache tokens of the arm's calls; absent on observations recorded before they were read. */
    prompt_caching?: CachingObservation;
}

/** One component's calls as the provider's cache saw them. */
export interface CachingCount {
    /** Calls whose forwarded body the run stored. */
    requests: number;
    /** Of those, the calls whose body carries at least one cache point. */
    with_cache_points: number;
    /** Of those, the calls whose cache points the proxy placed (`daemonCachePoints`). */
    placed_by_proxy: number;
    /**
     * Of the calls that carry cache points of their own (the proxy placed none), those carrying
     * one in a message, and those carrying one after the system prompt. Both are counted from the
     * stored bodies at the arm's end, so they are absent on observations recorded before they
     * were read, and a count that also took calls as they started (a resume's session-end count)
     * holds them only for the calls the log held. The layout check reads the arm-end tally alone.
     */
    with_message_points?: number;
    with_system_points?: number;
    /** Of the same calls, those carrying a cache point in any other part, such as the tool list. */
    with_other_points?: number;
    /** The provider's prompt usage summed over the component's calls. */
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
}

/** An arm's calls by component, the harness's own callers and refused requests left out. */
export interface CachingObservation {
    components: Record<string, CachingCount>;
}

const countOf = (components: Record<string, CachingCount>, component: string): CachingCount =>
    (components[component] ??= {
        requests: 0,
        with_cache_points: 0,
        placed_by_proxy: 0,
        input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    });

/**
 * Counts one request of `component` that carries `points` cache points. The run counts each
 * request as its call starts, so a session's end can hold the arm to the caching condition
 * before the arm's finish reads the stored bodies.
 */
export function noteRequest(
    components: Record<string, CachingCount>,
    component: string,
    points: number,
    placed = 0,
): void {
    if (HARNESS_COMPONENTS.has(component)) return;
    const count = countOf(components, component);
    count.requests++;
    if (points > 0) count.with_cache_points++;
    if (points > 0 && placed > 0) count.placed_by_proxy++;
}

/**
 * The model calls the daemon runs itself. On Pi its model-execution backend starts a child `pi`
 * from the daemon's own Pi closure, with a private home and Pi's built-in model list, so the
 * model definition the arm writes (`piModelName`) stays outside it.
 */
const DAEMON_CALLERS: readonly string[] = [
    "history_summarizer",
    "memory_classifier",
    "context_researcher",
];

/**
 * Under prompt caching on, places cache points on a daemon-run call whose body carries none, and
 * returns how many: the points the request of the child Pi carries for a model that Pi
 * recognises. Pi's client places one after the system prompt and one at the end of the user
 * message; on a build whose bundled hook removes cache markers from user messages (`layout`
 * `system`) the request carries the system prompt's alone. A body that carries a cache point
 * already (OpenCode's closure places its own) and every other caller's body stay as they are.
 */
export const daemonCachePoints =
    (layout: BackgroundCachePoints) =>
    (body: ConverseBody, component: string): number => {
        if (!DAEMON_CALLERS.includes(component) || bodyCachePoints(body) > 0) return 0;
        // A turn spec persisted before the layout existed names none, and reads as Pi's own two.
        return placePiCachePoints(body, layout !== "system");
    };

/**
 * The background cache-point layout of the build a manifest bound: every variant of a build names
 * the same one. A manifest that names none (a host-only run, or a run recorded before the
 * capability) reads as Pi's own two points.
 */
export function backgroundCachePointsOf(build: unknown): BackgroundCachePoints {
    // A replay reads the manifest from disk, so any shape other than a named `system` reads as Pi's own.
    const capabilities = (
        build as {
            capabilities?: Record<string, { background_cache_points?: unknown } | null> | null;
        }
    )?.capabilities;
    return Object.values(capabilities ?? {}).some((c) => c?.background_cache_points === "system")
        ? "system"
        : "system-and-message";
}

/** Builds an arm's `CachingObservation` from its call records; each stored part is read once. */
export class CachingTally {
    private readonly components: Record<string, CachingCount> = {};
    private readonly points = new Map<string, { points: number; field: string } | null>();

    constructor(private readonly parts: PartLookup) {}

    add(
        call: Pick<
            CallRecord,
            | "component"
            | "request"
            | "input_tokens"
            | "cache_read_tokens"
            | "cache_write_tokens"
            | "cache_points_placed"
        >,
    ): void {
        if (HARNESS_COMPONENTS.has(call.component)) return;
        const count = countOf(this.components, call.component);
        count.input_tokens += call.input_tokens;
        count.cache_read_tokens += call.cache_read_tokens;
        count.cache_write_tokens += call.cache_write_tokens;
        if (!call.request) return;
        // A request with a part the log lacks cannot be rebuilt, so it shows no cache point.
        const points = call.request.parts.map((id) => this.pointsOf(id));
        const whole = points.every((n) => n !== null);
        noteRequest(
            this.components,
            call.component,
            whole ? points.reduce<number>((sum, n) => sum + (n?.points ?? 0), 0) : 0,
            call.cache_points_placed,
        );
        count.with_message_points ??= 0;
        count.with_system_points ??= 0;
        count.with_other_points ??= 0;
        if (!whole || (call.cache_points_placed ?? 0) > 0) return;
        const fields = new Set(points.filter((n) => n && n.points > 0).map((n) => n?.field));
        if (fields.delete("messages")) count.with_message_points++;
        if (fields.delete("system")) count.with_system_points++;
        if (fields.size > 0) count.with_other_points++;
    }

    /** A stored part's cache points and its field, or null for a part the log lacks. */
    private pointsOf(id: string): { points: number; field: string } | null {
        let n = this.points.get(id);
        if (n === undefined) {
            const part = this.parts.get(id);
            n = part ? { points: cachePointsOf(part), field: part.field } : null;
            this.points.set(id, n);
        }
        return n;
    }

    observation(): CachingObservation {
        return { components: this.components };
    }
}

/**
 * The components whose every request the host's model client sends with cache points: the agent
 * loop and the Eidnara plugin's calls. Pi's own compaction is recorded and held to nothing, since
 * Pi 0.87 sends its compaction summary with cache retention `none` where 0.80.2 places the points.
 */
const CACHED_CALLERS: readonly string[] = ["agent", ...EIDNARA_COMPONENTS];

/**
 * What an arm's requests show against the run's prompt-caching condition. Under `on` the host's
 * client places cache points on every request it sends, so a request of one of its callers
 * without a point ran outside the condition. Under `off` the host's own model matching decides,
 * so the observation stands as recorded.
 */
export function cachingMismatches(
    condition: PromptCaching,
    o: CachingObservation | undefined,
    background?: { layout: BackgroundCachePoints; label: string },
): string[] {
    if (condition !== "on" || !o) return [];
    const uncached = Object.entries(o.components)
        .filter(([component]) => CACHED_CALLERS.includes(component))
        .filter(([, c]) => c.with_cache_points < c.requests)
        .map(
            ([component, c]) =>
                `${c.requests - c.with_cache_points} of ${c.requests} ${component} requests carry no cache point, but the run registers prompt caching on`,
        );
    return [...uncached, ...backgroundMismatches(o, background)];
}

/**
 * A background call sends a system prompt and one user message. The requests the host sent with
 * their own cache points show the build's layout: each carries one after the system prompt, and
 * one on the message with `system-and-message` and none there with `system`. On a Pi arm those
 * are the capture calls, which run in the arm's Pi. A request whose points the proxy placed
 * follows the declared layout by construction, so the counts leave each such request out.
 * `background` is given for a Pi arm and for the arm-end tally, which holds both counts; the
 * session-end check passes none.
 */
function backgroundMismatches(
    o: CachingObservation,
    background: { layout: BackgroundCachePoints; label: string } | undefined,
): string[] {
    if (!background) return [];
    const out: string[] = [];
    for (const component of EIDNARA_COMPONENTS) {
        const c = o.components[component];
        if (!c || c.with_message_points === undefined || c.with_system_points === undefined) {
            continue;
        }
        const own = c.with_cache_points - c.placed_by_proxy;
        const bare = own - c.with_message_points;
        if ((c.with_other_points ?? 0) > 0) {
            out.push(
                `${c.with_other_points} of ${own} ${component} requests with cache points of their own carry one outside the system prompt and the messages, where ${background.label} and every other build place none on a background call`,
            );
        }
        if (own > c.with_system_points) {
            out.push(
                `${own - c.with_system_points} of ${own} ${component} requests with cache points of their own carry none after the system prompt, where ${background.label} and every other build place one on a background call`,
            );
        }
        if (background.layout === "system" && c.with_message_points > 0) {
            out.push(
                `${c.with_message_points} of ${own} ${component} requests with cache points of their own carry one on a message, but ${background.label} declares the system prompt's cache point alone on a background call`,
            );
        }
        if (background.layout === "system-and-message" && bare > 0) {
            out.push(
                `${bare} of ${own} ${component} requests with cache points of their own carry one on the system prompt alone, but ${background.label} declares one on the user message of a background call too`,
            );
        }
    }
    return out;
}

/**
 * The daemon status readings the sampler wrote beside its `/proc` samples: how many samples of a
 * live daemon there are, how many carry the `process_memory` block of the Context module's
 * `status` answer, and what the `progress` block of `search.lifecycle.status` reported.
 */
export interface DaemonStatusObservation {
    /** Samples that name a live daemon process. */
    samples: number;
    /** Of those, the samples carrying a status reading that returned without an error. */
    readings: number;
    /** Of those, the samples carrying a status reading whose read failed. */
    read_errors: number;
    /** Readings whose `status` answer carries a `process_memory` block. */
    process_memory: number;
    /** The largest anonymous resident bytes a `process_memory` block reported, or null with none. */
    max_rss_anon_bytes: number | null;
    /** The last `process_memory` block's C-heap release count, or null with none. */
    c_heap_releases: number | null;
    search_progress: {
        /** Samples carrying a `progress` block. */
        samples: number;
        /** Of those, the samples of a Current, admitted projection within `FIXTURE_READER_LAG_COMMITS` of the tip. */
        served: number;
        max_lag_commits: number | null;
        /** The last sample's lag behind the kernel tip, in commits. */
        last_lag_commits: number | null;
        /** The last sample's rebuild counts. */
        rebuilds: { recorded: number; completed: number; renewed: number } | null;
        /** Samples whose progress names a blocking reason. */
        blocked: number;
    };
}

/**
 * The committed user statements (`stm_*` decisions whose commit the log holds) in
 * `final-store/kernel.sqlite`. `sessions` and `unattributed` describe the live ones, which the
 * Kernel still serves as approved: the sessions their capture rationale names and the count of
 * those whose payload names none. A record retired during the run is left out for the whole
 * run, the sessions before its retirement included. Null when the store is absent, and an
 * `error` when its decisions cannot be read.
 */
export type StatementObservation = {
    count: number;
    sessions: string[];
    unattributed: number;
    /**
     * Of `count`, the statement records an invalidation retired, such as the record of work in
     * progress a later statement ended; absent on observations recorded before it was read.
     */
    retired?: number;
    /** Why the store's decisions could not be read, or null. */
    error: string | null;
    /**
     * The Kernel lineages (source ids) the statement records join: how many there are, how many
     * statements the largest holds, and how many statements sit on a per-message lineage
     * (`memory_capture_statement:<32 hex digits>`); absent on observations recorded before it was
     * read.
     */
    lineages?: { count: number; largest: number; per_message: number };
    /**
     * The committed captured facts (`mem_*` decisions) by the `lifetime` class their rationale
     * names; a fact whose rationale names none is left out. Absent on observations recorded
     * before it was read.
     */
    lifetimes?: Record<string, number>;
    /**
     * Of the facts classed `current_work`, those whose rationale holds an `ended_by` record: work
     * in progress a later statement of the user ended. Absent on observations recorded before it
     * was read.
     */
    ended_work?: number;
} | null;

/**
 * The daemon generations `daemon.log` records: ready records, and the fixture's production search
 * route lines with the embedding models they name.
 */
export interface DaemonRouteObservation {
    ready: number;
    /** Ready generations whose route line followed their ready record. */
    production: number;
    models: string[];
}

/**
 * Source capture as the arm's daemon left it: the Kernel source descriptors (`srcdesc:*`
 * observations) in `final-store/kernel.sqlite` by class, and the `source_capture` counters
 * totalled over the daemon generations the driver read (`source-capture.json`).
 */
export interface SourceCaptureObservation {
    /** Descriptors by class (`messages`, `raw_tool_spans`, `repository_documents`); null when the store is absent or unreadable. */
    descriptors: Record<string, number> | null;
    /** Of those, the descriptors no later revision retired. */
    live: number | null;
    /** The arm's counters aggregate successful reads across daemon generations. */
    counters: Record<string, number | null> | null;
    /** Why the counters could not be read, or null. */
    counters_error: string | null;
    /** The daemon generations whose counters the total leaves out; null on a record without the count. */
    unread_generations: number | null;
}

/** An oracle note the arm owes: the probe turn it goes into and the background it quotes. */
export interface ExpectedNote {
    event: string;
    session: string;
    background: string;
    /** The scripted turn text the delivered prompt ends with, after the note. */
    text: string;
    /**
     * False for a turn a resume recovered from the pairing log: the host may have received it, so
     * its note is placed where it appears, but its delivery is not owed.
     */
    owed: boolean;
}

/**
 * The arm's agent request bodies against its delivery mode: how many were read and could not be
 * rebuilt, how many carry an automatic recall block, which owed oracle notes reached the
 * prompt of their own turn, and which requests carry a note outside its session or before its
 * turn, or an opening that matches no owed note.
 */
export interface DeliveryObservation {
    requests: number;
    unreadable: number;
    /** Requests carrying a block whose tag is in `AUTOMATIC_RECALL_TAGS`. */
    injected_blocks: number;
    notes: { expected: number; delivered: number; missing: string[]; misplaced: number[] };
    /** Agent requests carrying a `<project-memory>` block; absent on observations recorded before it was read. */
    memory_blocks?: number;
    /** Sessions with an agent request; absent on observations recorded before it was read. */
    sessions?: number;
    /**
     * Whether some agent request came after a user statement was captured, in another session
     * than the capture's, so a later session's `<project-memory>` block owes it; absent on
     * observations recorded before it was read.
     */
    memory_due?: boolean;
    /**
     * Of the requests that owe a block (another session's, of the statement's project, started
     * after the capture ended), those carrying a `<project-memory>` block.
     */
    due_blocks?: number;
    /**
     * Sessions with at least one request that owes a block; absent on observations recorded
     * before it was read.
     */
    due_sessions?: number;
    /** Of those, the sessions in which at least one owing request carried a `<project-memory>` block. */
    covered_sessions?: number;
    /** The owing sessions in which no owing request carried a block, in session order. */
    uncovered_sessions?: string[];
    /** Agent requests whose `<project-memory>` block renders a contested statement; absent on observations recorded before it was read. */
    contested_blocks?: number;
    /** Agent requests whose `<project-memory>` block holds a `<CURRENT_WORK>` element; absent on observations recorded before it was read. */
    work_blocks?: number;
    /** The keyed open items in the requests' rendered history; absent on observations recorded before it was read. */
    open_items?: OpenItemObservation;
}

/**
 * The open-item status lines in the history blocks (`<session-history>` and
 * `<session-history-since>`) of the arm's agent requests. The rows of one block render together,
 * so a waiting line belongs in the block's newest summarized segment alone.
 */
export interface OpenItemObservation {
    /** History blocks holding at least one rendered segment. */
    blocks: number;
    /** Of those, the blocks with a `Waiting on user (key)` line. */
    waiting_blocks: number;
    /** Of those, the blocks where a later segment of the block holds a status line of any form. */
    stale_waiting_blocks: number;
    /** The call sequence numbers of the first requests with such a block, at most twenty. */
    stale_requests: number[];
}

const HISTORY_BLOCK = /<(session-history-since|session-history)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g;
/** A rendered segment opens with `## <first>-<last>`; a body line that starts with `## ` is rendered indented. */
const SEGMENT_HEADING = /^## \d+-\d+/;
/** The four status-line forms, each after at most one `- ` or `* ` bullet (Eidnara `history_open_items.rs`). */
const STATUS_LINE = /^(?:[-*] )?(Waiting on user|Constraint|Decided|Lifted) \([^()\s]+\): \S/;

/**
 * The open-item status lines of one request's history blocks. A block is stale when a segment
 * with a waiting line is followed, inside the block, by a segment holding a status line: that
 * later segment is a summarized one, so the waiting line's segment is no longer the newest.
 */
export function openItemsOf(text: string): { blocks: number; waiting: number; stale: number } {
    const out = { blocks: 0, waiting: 0, stale: 0 };
    for (const block of text.matchAll(HISTORY_BLOCK)) {
        const segments: { waiting: boolean; status: boolean }[] = [];
        for (const line of (block[2] as string).split("\n")) {
            if (SEGMENT_HEADING.test(line)) {
                segments.push({ waiting: false, status: false });
                continue;
            }
            const current = segments.at(-1);
            const form = STATUS_LINE.exec(line)?.[1];
            if (!current || form === undefined) continue;
            current.status = true;
            if (form === "Waiting on user") current.waiting = true;
        }
        if (segments.length === 0) continue;
        out.blocks++;
        if (!segments.some((s) => s.waiting)) continue;
        out.waiting++;
        const lastStatus = segments.map((s) => s.status).lastIndexOf(true);
        if (segments.some((s, i) => s.waiting && i < lastStatus)) out.stale++;
    }
    return out;
}

/** A contested statement as `<project-memory>` renders it (Eidnara `canonical_memory.rs` `contested_line`). */
const CONTESTED_LINE = / \(stated [^;()]+; contested [^()]+? by [^\s:]+: "/;

/** The opening tag of the element `<project-memory>` renders live work in progress in (Eidnara `memory_render.rs` `push_category_open`). */
const WORK_ELEMENT = /<CURRENT_WORK(?=[\s>])/;

/** The text blocks of the body's user messages, where a prompt prefix lands. */
const userTexts = (body: ConverseBody) =>
    (body.messages ?? [])
        .filter((m) => m?.role === "user")
        .map((m) =>
            (Array.isArray(m.content) ? m.content : [])
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("\n"),
        );

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Tags of the injected blocks that break explicit-search delivery mode. */
export const AUTOMATIC_RECALL_TAGS: ReadonlySet<string> = new Set([
    "project-memory",
    "project-note",
    "eidnara-search-auto",
    "eidnara-search-hint",
]);

export function observeDelivery(
    calls: readonly (Pick<CallRecord, "seq" | "component" | "session" | "turn" | "request"> &
        Partial<Pick<CallRecord, "started_wall_ms" | "wall_ms" | "status">>)[],
    parts: PartLookup,
    notes: readonly ExpectedNote[],
    eventIndex: ReadonlyMap<string, number>,
    statementSessions: readonly (string | null)[] | null = null,
    projectOf: ReadonlyMap<string, string> = new Map(),
): DeliveryObservation {
    const out: DeliveryObservation = {
        requests: 0,
        unreadable: 0,
        injected_blocks: 0,
        notes: {
            expected: notes.filter((n) => n.owed).length,
            delivered: 0,
            missing: [],
            misplaced: [],
        },
        memory_blocks: 0,
        sessions: 0,
        memory_due: false,
        due_blocks: 0,
        due_sessions: 0,
        covered_sessions: 0,
        uncovered_sessions: [],
        contested_blocks: 0,
        work_blocks: 0,
        open_items: { blocks: 0, waiting_blocks: 0, stale_waiting_blocks: 0, stale_requests: [] },
    };
    const openItems = out.open_items as OpenItemObservation;
    let contestedBlocks = 0;
    let workBlocks = 0;
    const delivered = new Set<string>();
    const index = (event: string | null) => eventIndex.get(event ?? "") ?? -1;
    const backgrounds = [...new Set(notes.map((n) => n.background))];
    const agentCalls: { started: number; session: string | null; block: boolean }[] = [];
    const lastCapture = new Map<string, number>();
    const lastCall = new Map<string, number>();
    let memoryBlocks = 0;
    for (const call of calls) {
        const session = call.session ?? null;
        const ended = call.wall_ms ?? call.seq;
        if (session !== null) lastCall.set(session, Math.max(lastCall.get(session) ?? -1, ended));
        // Only a capture call the provider answered can have produced a statement.
        const answered = call.status === undefined || call.status === 200;
        if (call.component === "memory_capture" && session !== null && answered) {
            lastCapture.set(session, Math.max(lastCapture.get(session) ?? -1, ended));
        }
        if (call.component !== "agent" || !call.request) continue;
        const agent = { started: call.started_wall_ms ?? call.seq, session, block: false };
        agentCalls.push(agent);
        const body = rebuildRequest(call.request, parts);
        if (!body) {
            out.unreadable++;
            continue;
        }
        out.requests++;
        const text = bodyText(body);
        if (injectedBlocks(text).some((b) => AUTOMATIC_RECALL_TAGS.has(b.tag))) {
            out.injected_blocks++;
        }
        const given = bodyText({
            system: body.system,
            messages: (body.messages ?? []).filter((m) => m?.role === "user"),
        });
        const memory = injectedBlocks(given).filter((b) => b.tag === "project-memory");
        if (memory.length > 0) {
            memoryBlocks++;
            agent.block = true;
            if (memory.some((b) => CONTESTED_LINE.test(b.body))) contestedBlocks++;
            if (memory.some((b) => WORK_ELEMENT.test(b.body))) workBlocks++;
        }
        const items = openItemsOf(given);
        openItems.blocks += items.blocks;
        openItems.waiting_blocks += items.waiting;
        openItems.stale_waiting_blocks += items.stale;
        if (items.stale > 0 && openItems.stale_requests.length < 20) {
            openItems.stale_requests.push(call.seq);
        }
        const users = userTexts(body);
        const prompt = [...users].reverse().find((t) => t.length > 0) ?? "";
        for (const n of notes) {
            const opens = prompt.startsWith(n.background);
            if (n.event === call.turn && opens && prompt.trimEnd().endsWith(n.text.trimEnd())) {
                delivered.add(n.event);
            }
        }
        const carried = backgrounds.filter((b) => text.includes(b));
        const due = (b: string) =>
            notes.filter(
                (n) =>
                    n.background === b &&
                    n.session === call.session &&
                    index(n.event) <= index(call.turn),
            ).length;
        const placed = carried.every((b) => due(b) > 0);
        // The agent's own replies may quote a note, so only system and user text count. User-message
        // occurrences count toward owned, capped per background by the matching notes due in the
        // call's session through its turn.
        const entered = bodyText({
            system: body.system,
            messages: (body.messages ?? []).filter((m) => m?.role === "user"),
        });
        const user = users.join("\n");
        const owned = carried.reduce((sum, b) => sum + Math.min(occurrences(user, b), due(b)), 0);
        if (!placed || occurrences(entered, ORACLE_OPENING) > owned) {
            out.notes.misplaced.push(call.seq);
        }
    }
    out.notes.delivered = delivered.size;
    out.notes.missing = notes.filter((n) => n.owed && !delivered.has(n.event)).map((n) => n.event);
    out.memory_blocks = memoryBlocks;
    out.contested_blocks = contestedBlocks;
    out.work_blocks = workBlocks;
    out.sessions = new Set(agentCalls.map((c) => c.session)).size;
    const owed = owingRequests(agentCalls, lastCapture, lastCall, statementSessions, projectOf);
    out.memory_due = owed.length > 0;
    out.due_blocks = owed.filter((c) => c.block).length;
    const owing = new Map<string, boolean>();
    for (const c of owed) {
        const key = c.session ?? "";
        owing.set(key, (owing.get(key) ?? false) || c.block);
    }
    out.due_sessions = owing.size;
    out.covered_sessions = [...owing.values()].filter(Boolean).length;
    out.uncovered_sessions = [...owing]
        .filter(([, covered]) => !covered)
        .map(([session]) => session)
        .sort();
    return out;
}

/**
 * Pi names each Eidnara session `sim-<session>`, so a statement's capture session maps onto the
 * run's session; a name without the prefix (OpenCode's own session ids) maps onto none, and then
 * every session that made a capture call stands as the possible capture session.
 */
const simSession = (name: string) => (name.startsWith("sim-") ? name.slice(4) : null);

/**
 * The agent requests that owe a statement's `<project-memory>` block: each started, in another
 * session of the same project, after the last capture call of a session that captured a user
 * statement had ended. The current session's statements stay out of its own block. A statement
 * whose session is unknown (null) or maps onto no run session adds every session that made a
 * capture call as a possible capture session; a session with no known project matches any.
 */
function owingRequests<C extends { started: number; session: string | null }>(
    agentCalls: readonly C[],
    lastCapture: ReadonlyMap<string, number>,
    lastCall: ReadonlyMap<string, number>,
    statementSessions: readonly (string | null)[] | null,
    projectOf: ReadonlyMap<string, string>,
): C[] {
    if (!statementSessions || statementSessions.length === 0) return [];
    const mapped = statementSessions.map((s) => (s === null ? null : simSession(s)));
    const sessions = new Set(mapped.filter((m) => m !== null) as string[]);
    if (mapped.some((m) => m === null)) for (const s of lastCapture.keys()) sessions.add(s);
    const sameProject = (a: string, b: string | null) => {
        const pa = projectOf.get(a);
        const pb = b === null ? undefined : projectOf.get(b);
        return pa === undefined || pb === undefined || pa === pb;
    };
    const owed = new Set<C>();
    for (const s of sessions) {
        const after = lastCapture.get(s) ?? lastCall.get(s);
        if (after === undefined) continue;
        for (const c of agentCalls) {
            if (c.session !== s && c.started > after && sameProject(s, c.session)) owed.add(c);
        }
    }
    return [...owed];
}

/** Delivery evidence that contradicts the profile; an arm without the observation passes. */
export function deliveryMismatches(profile: ArmProfile, o: DeliveryObservation | null): string[] {
    if (!o) return [];
    const mode = deliveryOf(profile);
    const out: string[] = [];
    const { notes } = o;
    if (o.unreadable > 0) {
        out.push(
            `${o.unreadable} agent request bodies cannot be rebuilt to check ${mode} delivery`,
        );
    }
    if (mode === "oracle-context") {
        if (notes.expected === 0) {
            out.push("the arm reached no probe turn with sources, so it delivered no oracle note");
        }
        if (notes.missing.length > 0) {
            out.push(
                `${notes.missing.length} oracle notes reached no prompt of their own turn: ${notes.missing.join(", ")}`,
            );
        }
    }
    if (mode === "explicit-search" && o.injected_blocks > 0) {
        out.push(
            `${o.injected_blocks} agent requests carry an automatic Eidnara recall block, but the arm declares explicit search alone`,
        );
    }
    if (notes.misplaced.length > 0) {
        const where =
            mode === "oracle-context"
                ? "before its probe turn, in another session, or matching no owed note"
                : `on a ${profile.role} arm`;
        out.push(`agent requests ${notes.misplaced.join(", ")} carry an oracle note ${where}`);
    }
    return out;
}

const CHUNK = 1 << 20;
/** A line longer than this is skipped unread, so one runaway line cannot hold the whole file. */
const MAX_LINE = 16 << 20;

/**
 * Calls `onLine` for each newline-terminated line, and the unterminated tail, from byte `from` of a
 * regular file the agent may have written: the file opens without following a link or blocking,
 * and an absent file reads as empty.
 */
export function eachLine(path: string, onLine: (line: string) => void, from = 0): void {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error(`${path} cannot be read as evidence: ${(caught as Error).message}`);
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) {
            throw new Error(`${path} is not a single-link regular file`);
        }
        const buf = Buffer.alloc(CHUNK);
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let skipping = false;
        for (let offset = from; ; ) {
            const n = readSync(fd, buf, 0, CHUNK, offset);
            offset += n;
            if (n === 0) break;
            let chunk = buf.subarray(0, n);
            let at = chunk.indexOf(0x0a);
            while (at !== -1) {
                if (!skipping)
                    onLine(Buffer.concat([...pending, chunk.subarray(0, at)]).toString());
                pending = [];
                pendingBytes = 0;
                skipping = false;
                chunk = chunk.subarray(at + 1);
                at = chunk.indexOf(0x0a);
            }
            if (skipping || chunk.length === 0) continue;
            pendingBytes += chunk.length;
            if (pendingBytes > MAX_LINE) {
                pending = [];
                pendingBytes = 0;
                skipping = true;
            } else {
                pending.push(Buffer.from(chunk));
            }
        }
        if (!skipping && pendingBytes > 0) onLine(Buffer.concat(pending).toString());
    } finally {
        closeSync(fd);
    }
}

/** The plugin log's length, the mark a session's own evidence starts from. */
export function logLength(path: string): number {
    return lstatSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/** Counts plugin boots by outcome and transform passes in one arm's plugin log, from byte `from`. */
export function readPluginLog(
    path: string,
    from = 0,
): Pick<ArmObservation, "boots" | "transform_passes" | "narrowing_passes" | "unsized_passes"> {
    const boots = {
        enabled: 0,
        transform_on: 0,
        transform_off: 0,
        transform_unknown: 0,
        disabled: [] as string[],
    };
    let transform_passes = 0;
    let narrowing_passes = 0;
    let unsized_passes = 0;
    eachLine(
        path,
        (line) => {
            if (line.includes("served_from=transform")) {
                transform_passes++;
                const counts = / in=(\d+) out=(\d+)/.exec(line);
                if (!counts) unsized_passes++;
                else if (Number(counts[2]) < Number(counts[1])) narrowing_passes++;
                return;
            }
            // Pi logs its tool registration once per process; OpenCode logs its conflict check.
            if (line.includes("[eidnara][pi] registered tools:")) {
                boots.enabled++;
                if (line.includes("compaction-off mode")) boots.transform_off++;
                else if (line.includes("eidnara_reduce")) boots.transform_on++;
                else boots.transform_unknown++;
                return;
            }
            if (
                /\[eidnara\] (no conflicts detected|configuration warning), plugin enabled/.test(
                    line,
                )
            ) {
                boots.enabled++;
                return;
            }
            const disabled =
                /\[eidnara\](?:\[pi\])? (disabled due to conflicts: .*|plugin DISABLED.*)$/.exec(
                    line,
                );
            if (disabled) boots.disabled.push((disabled[1] as string).slice(0, 500));
        },
        from,
    );
    return { boots, transform_passes, narrowing_passes, unsized_passes };
}

const FALLBACK =
    /the fused search route is unavailable \(([^)]*)\); results come from the legacy snapshot scan/;

/**
 * The `eidnara_search` results in Pi's session transcripts under `root/rel`, by answering route.
 * The agent can write below `root`, so every component of `rel` must be a real directory, and the
 * walk enters only real subdirectories; an absent directory holds no results.
 */
export function readPiSearches(root: string, rel: string): NonNullable<ArmObservation["search"]> {
    const search = { legacy_scan: [] as string[], fused: 0, errored: 0, contested: 0 };
    let sessionsDir = root;
    for (const part of rel.split("/")) {
        sessionsDir = join(sessionsDir, part);
        const stat = lstatSync(sessionsDir, { throwIfNoEntry: false });
        if (stat === undefined) return search;
        if (!stat.isDirectory()) {
            throw new Error(
                `${sessionsDir} is a link or not a directory; transcripts need a real one`,
            );
        }
    }
    const walk = (dir: string, depth: number) => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names.sort()) {
            const path = join(dir, name);
            const stat = lstatSync(path, { throwIfNoEntry: false });
            if (stat?.isDirectory() && depth > 0) walk(path, depth - 1);
            if (!stat?.isFile() || !name.endsWith(".jsonl")) continue;
            eachLine(path, (line) => {
                if (!line.includes('"eidnara_search"')) return;
                let entry: {
                    message?: {
                        role?: unknown;
                        toolName?: unknown;
                        content?: unknown;
                        isError?: unknown;
                    };
                };
                try {
                    entry = JSON.parse(line);
                } catch {
                    return;
                }
                const m = entry.message;
                if (m?.role !== "toolResult" || m.toolName !== "eidnara_search") return;
                const text = (Array.isArray(m.content) ? m.content : [])
                    .map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
                    .join("\n");
                // The plugin prepends the fallback note to every legacy-scan answer and to no
                // answer the fused route ranked; a refusal is an error result.
                if (/^Contested by /m.test(text)) search.contested++;
                const fallback = FALLBACK.exec(text);
                if (fallback) search.legacy_scan.push(fallback[1] as string);
                else if (m.isError === true || text.startsWith("Error")) search.errored++;
                else search.fused++;
            });
        }
    };
    walk(sessionsDir, 2);
    return search;
}

/** The source descriptors of a final Kernel store; null when the store is absent or unreadable. */
export function readDescriptors(
    kernelPath: string,
): Pick<SourceCaptureObservation, "descriptors" | "live"> {
    if (!lstatSync(kernelPath, { throwIfNoEntry: false })?.isFile()) {
        return { descriptors: null, live: null };
    }
    let db: Database | null = null;
    try {
        db = new Database(kernelPath, { readonly: true });
        const rows = db
            .query(
                `select source_kind as class, count(*) as n,
                    sum(invalidated_commit_seq is null) as live
                 from object_registry
                 where object_id glob 'srcdesc:*' and object_kind = 'observation'
                 group by source_kind`,
            )
            .all() as { class: string; n: number; live: number }[];
        // A descriptor whose commit the log lacks comes from a store a crash left partial.
        const orphans = db
            .query(
                `select count(*) as n from object_registry o
                 where o.object_id glob 'srcdesc:*' and o.object_kind = 'observation'
                   and (o.created_commit_seq is null
                     or o.created_commit_seq not in (select commit_seq from commit_log)
                     or (o.invalidated_commit_seq is not null
                         and o.invalidated_commit_seq not in (select commit_seq from commit_log)))`,
            )
            .get() as { n: number };
        if (orphans.n > 0) return { descriptors: null, live: null };
        return {
            descriptors: Object.fromEntries(rows.map((r) => [r.class, r.n])),
            live: rows.reduce((sum, r) => sum + r.live, 0),
        };
    } catch {
        return { descriptors: null, live: null };
    } finally {
        db?.close();
    }
}

/**
 * The accepted user statements of a final Kernel store: `stm_*` decisions, each naming its capture
 * session in the rationale of its JSON payload, with the live ones told apart from those an
 * invalidation retired. Null when the store is absent or unreadable.
 */
export function readStatements(kernelPath: string): StatementObservation {
    if (!lstatSync(kernelPath, { throwIfNoEntry: false })?.isFile()) return null;
    let db: Database | null = null;
    try {
        db = new Database(kernelPath, { readonly: true });
        const rows = db
            .query(
                `select decision_payload as p,
                        object_id in (select object_id from object_registry
                                      where invalidated_commit_seq is not null) as retired
                 from decisions
                 where object_id glob 'stm_*'
                   and created_commit_seq in (select commit_seq from commit_log)`,
            )
            .all() as { p: Uint8Array | string; retired: number }[];
        const sessions = new Set<string>();
        let unattributed = 0;
        let retired = 0;
        // A retired record approves nothing, so no later session owes its statement's block.
        for (const { p, retired: gone } of rows) {
            if (gone) {
                retired++;
                continue;
            }
            const session = rationaleOf(p)?.session;
            if (typeof session === "string") sessions.add(session);
            else unattributed++;
        }
        const lineages = db
            .query(
                `select o.source_id as source, count(*) as n from object_registry o
                 where o.object_id glob 'stm_*'
                   and o.created_commit_seq in (select commit_seq from commit_log)
                 group by o.source_id`,
            )
            .all() as { source: string; n: number }[];
        // A class name is a key read from the store, so the tally has no inherited keys.
        const lifetimes: Record<string, number> = Object.create(null);
        const facts = db
            .query(
                `select decision_payload as p from decisions
                 where object_id glob 'mem_*'
                   and created_commit_seq in (select commit_seq from commit_log)`,
            )
            .all() as { p: Uint8Array | string }[];
        let endedWork = 0;
        for (const { p } of facts) {
            const rationale = rationaleOf(p);
            const lifetime = rationale?.lifetime;
            if (typeof lifetime === "string") lifetimes[lifetime] = (lifetimes[lifetime] ?? 0) + 1;
            const end = rationale?.ended_by;
            const record = end !== null && typeof end === "object" && !Array.isArray(end);
            if (lifetime === "current_work" && record) endedWork++;
        }
        return {
            count: rows.length,
            sessions: [...sessions].sort(),
            unattributed,
            retired,
            error: null,
            lifetimes,
            ended_work: endedWork,
            lineages: {
                count: lineages.length,
                largest: Math.max(0, ...lineages.map((l) => l.n)),
                per_message: lineages
                    .filter((l) => PER_MESSAGE_LINEAGE.test(l.source))
                    .reduce((sum, l) => sum + l.n, 0),
            },
        };
    } catch (caught) {
        const error = (caught as Error).message;
        return { count: 0, sessions: [], unattributed: 0, error };
    } finally {
        db?.close();
    }
}

/**
 * The lifetime classes capture writes into a fact's rationale on a build with
 * `statement_lifetime`; a build with `current_work_delivery` also names `request`.
 */
const LIFETIME_CLASSES: readonly string[] = ["lasting", "current_work", "status", "unsettled"];
const lifetimeClasses = (caps: DaemonCapabilities): readonly string[] =>
    caps.current_work_delivery ? [...LIFETIME_CLASSES, "request"] : LIFETIME_CLASSES;

/** The rationale object a decision's JSON payload carries as a JSON string, or null when either fails to parse. */
function rationaleOf(payload: Uint8Array | string): Record<string, unknown> | null {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    try {
        const rationale = JSON.parse(String(JSON.parse(text)?.rationale ?? "null"));
        const named =
            rationale !== null && typeof rationale === "object" && !Array.isArray(rationale);
        return named ? rationale : null;
    } catch {
        return null;
    }
}

/** A per-message statement lineage: the shared prefix, a colon, and 32 hex digits of the capture job id. */
const PER_MESSAGE_LINEAGE = /^memory_capture_statement:[0-9a-f]{32}$/;

const ROUTE_LINE = /direct_host_fixture: search route production, embedding model ([^,\s]+)/;

/**
 * Reads `daemon.log` in order. `DaemonStack` appends each start's captured stdout, which holds the
 * ready record, before its captured stderr, which holds the fixture's route line, so a generation
 * opens at its ready record and counts as production when a route line follows before the next
 * ready record. `models` lists the embedding models every route line names.
 */
export function readDaemonRoutes(path: string): DaemonRouteObservation {
    const out: DaemonRouteObservation = { ready: 0, production: 0, models: [] };
    const models = new Set<string>();
    let open = false;
    eachLine(path, (line) => {
        if (line.startsWith("{") && line.includes('"status":"ready"')) {
            out.ready++;
            open = true;
            return;
        }
        const route = ROUTE_LINE.exec(line);
        if (route) {
            models.add(route[1] as string);
            if (open) out.production++;
            open = false;
        }
    });
    out.models = [...models].sort();
    return out;
}

const count = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/**
 * The daemon status readings in `resources.jsonl`: each sample of a live daemon, the
 * `process_memory` blocks, and the `progress` blocks of `search.lifecycle.status`, each counted
 * only in the shape Eidnara writes it (`processMemoryBlock`, `progressBlock`). A projection
 * counts as served in a sample when its lifecycle record is Current, its admission is `admitted`,
 * and it trails the kernel tip by at most `FIXTURE_READER_LAG_COMMITS` commits.
 */
export function readDaemonStatus(path: string): DaemonStatusObservation {
    const out: DaemonStatusObservation = {
        samples: 0,
        readings: 0,
        read_errors: 0,
        process_memory: 0,
        max_rss_anon_bytes: null,
        c_heap_releases: null,
        search_progress: {
            samples: 0,
            served: 0,
            max_lag_commits: null,
            last_lag_commits: null,
            rebuilds: null,
            blocked: 0,
        },
    };
    const progress = out.search_progress;
    eachLine(path, (line) => {
        let sample: {
            pid?: unknown;
            daemon_status?: {
                error?: unknown;
                process_memory?: Record<string, unknown> | null;
                search?: {
                    state?: unknown;
                    admission?: unknown;
                    progress?: Record<string, unknown> | null;
                } | null;
            } | null;
        };
        try {
            sample = JSON.parse(line);
        } catch {
            return;
        }
        if (typeof sample?.pid !== "number") return;
        out.samples++;
        const reading = sample.daemon_status;
        if (!reading || typeof reading !== "object") return;
        if (typeof reading.error === "string") {
            out.read_errors++;
            return;
        }
        out.readings++;
        const memory = processMemoryBlock(sample.daemon_status?.process_memory);
        if (memory) {
            out.process_memory++;
            const anon = count(memory.rss_anon_bytes);
            if (anon !== null) out.max_rss_anon_bytes = Math.max(out.max_rss_anon_bytes ?? 0, anon);
            out.c_heap_releases = count(memory.c_heap_releases) ?? out.c_heap_releases;
        }
        const search = sample.daemon_status?.search;
        const p = progressBlock(search?.progress);
        if (!search || !p) return;
        progress.samples++;
        const lag = p.lag_commits;
        progress.last_lag_commits = lag;
        if (lag !== null) progress.max_lag_commits = Math.max(progress.max_lag_commits ?? 0, lag);
        if (
            search.state === "current" &&
            search.admission === "admitted" &&
            lag !== null &&
            lag <= FIXTURE_READER_LAG_COMMITS
        ) {
            progress.served++;
        }
        if (p.blocked !== null) progress.blocked++;
        progress.rebuilds = p.rebuilds;
    });
    return out;
}

/** Counters every `metrics.source_capture` block carries (Eidnara docs/host-wire-protocol.md 7.9). */
const CAPTURE_COUNTERS = ["admitted", "completed"];

/**
 * Why a settled `source_capture` report is no counter evidence, or null: it must be an object
 * holding `admitted` and `completed`, and every value a non-negative integer, with `null` admitted
 * for `oldest_deferred_age_ms` alone, as the wire declares.
 */
export function captureCountersProblem(c: unknown): string | null {
    if (!c || typeof c !== "object" || Array.isArray(c)) return "no counters recorded";
    const counter = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    const values = c as Record<string, unknown>;
    const named = CAPTURE_COUNTERS.every((k) => counter(values[k]));
    const nullable = (k: string, v: unknown) => v === null && k === "oldest_deferred_age_ms";
    return named && Object.entries(values).every(([k, v]) => nullable(k, v) || counter(v))
        ? null
        : `malformed counters ${JSON.stringify(c)}`;
}

/** `<arm>/source-capture.json` beside the final store, as the driver wrote it before the stop. */
function readCaptureCounters(
    path: string,
): Pick<SourceCaptureObservation, "counters" | "counters_error" | "unread_generations"> {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
        return {
            counters: null,
            counters_error: "source-capture.json was not written",
            unread_generations: null,
        };
    }
    let unread_generations: number | null = null;
    const unread = (counters_error: string) => ({
        counters: null,
        counters_error,
        unread_generations,
    });
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
            counters?: unknown;
            error?: unknown;
            unread_generations?: unknown;
        };
        if (Number.isSafeInteger(raw.unread_generations) && Number(raw.unread_generations) >= 0) {
            unread_generations = raw.unread_generations as number;
        }
        const error = typeof raw.error === "string" ? raw.error : null;
        if (raw.counters === null || raw.counters === undefined) {
            return unread(error ?? "no counters recorded");
        }
        if (error !== null || raw.error !== null) {
            return unread(`the record also reports ${String(raw.error)}`);
        }
        const problem = captureCountersProblem(raw.counters);
        if (problem) return unread(problem);
        const counters = raw.counters as Record<string, number | null>;
        return { counters, counters_error: null, unread_generations };
    } catch (caught) {
        return unread(`source-capture.json: ${String(caught)}`);
    }
}

/**
 * Reads an arm's evidence after its host and daemon stopped: the plugin log at
 * `<armRoot>/eidnara.log`, Pi's transcripts, and the arm's call counts by component.
 */
export function observeArm(
    arm: string,
    host: "pi" | "opencode",
    armRoot: string,
    components: Record<string, number>,
): ArmObservation {
    return {
        arm,
        host,
        ...readPluginLog(join(armRoot, "eidnara.log")),
        search: host === "pi" ? readPiSearches(armRoot, "home/.pi/agent/sessions") : null,
        components: { ...components },
        source_capture: {
            ...readDescriptors(join(armRoot, "..", "final-store", "kernel.sqlite")),
            ...readCaptureCounters(join(armRoot, "..", "source-capture.json")),
        },
        statements: readStatements(join(armRoot, "..", "final-store", "kernel.sqlite")),
        daemon_routes: readDaemonRoutes(join(armRoot, "..", "daemon.log")),
        daemon_status: readDaemonStatus(join(armRoot, "..", "resources.jsonl")),
    };
}

/** Plugin boot evidence that contradicts the profile; checkable after any session ends. */
export function bootMismatches(profile: ArmProfile, o: Pick<ArmObservation, "boots">): string[] {
    const { boots } = o;
    if (!profile.plugin) {
        const booted = boots.enabled + boots.disabled.length;
        return booted > 0
            ? [`the Eidnara plugin booted ${booted} times on a ${profile.role} arm`]
            : [];
    }
    const out = boots.disabled.map((why) => `the Eidnara plugin disabled itself: ${why}`);
    if (boots.enabled === 0) out.push("the Eidnara plugin log records no enabled boot");
    if (profile.eidnara_compaction && boots.transform_off > 0) {
        out.push(
            `${boots.transform_off} Pi boots registered no transform, but the arm declares Eidnara compaction on`,
        );
    }
    if (boots.transform_unknown > 0) {
        out.push(
            `${boots.transform_unknown} Pi boots registered tools in no recognised transform mode`,
        );
    }
    if (!profile.eidnara_compaction && boots.transform_on > 0) {
        out.push(
            `${boots.transform_on} Pi boots registered the transform, but the arm declares Eidnara compaction off`,
        );
    }
    return out;
}

/**
 * Every difference between what the arm's profile declares and what its run evidence shows, read
 * against the capabilities the arm's daemon variant has on `build`, the audited build the run bound.
 */
export function armMismatches(
    o: ArmObservation,
    build: AuditedBuild = AUDITED_BUILDS[0],
): string[] {
    const profile = armProfile(o.arm);
    const caps = profile.daemon === null ? undefined : build.variants[profile.daemon];
    const out = [...bootMismatches(profile, o), ...deliveryMismatches(profile, o.delivery ?? null)];
    const count = (component: string) => o.components[component] ?? 0;
    if (!profile.plugin) {
        for (const c of EIDNARA_COMPONENTS) {
            if (count(c) > 0) out.push(`${count(c)} ${c} calls on a ${profile.role} arm`);
        }
        if (o.transform_passes > 0)
            out.push(`${o.transform_passes} transform passes on a ${profile.role} arm`);
        return out;
    }
    // The Pi plugin submits a pass on every request in either compaction mode, so the daemon's
    // memory reaches the model; with Eidnara compaction off the daemon serves it additively and
    // the host keeps its own history.
    if (count("agent") > 0 && o.transform_passes === 0) {
        out.push(
            `${count("agent")} agent calls and no transform pass, but the arm loads the Eidnara plugin`,
        );
    }
    if (!profile.eidnara_compaction) {
        if (o.narrowing_passes > 0) {
            out.push(
                `${o.narrowing_passes} transform passes served fewer messages than they took, but the arm declares Eidnara compaction off`,
            );
        }
        if (o.unsized_passes > 0) {
            out.push(
                `${o.unsized_passes} transform passes logged no message counts, so the arm's Eidnara compaction off is unverified for them`,
            );
        }
        if (count("history_summarizer") > 0) {
            out.push(
                `${count("history_summarizer")} history_summarizer calls, but the arm declares Eidnara compaction off`,
            );
        }
    }
    out.push(...captureMismatches(profile, o), ...memoryMismatches(profile, o));
    out.push(...routeMismatches(profile, o));
    if (caps) out.push(...buildMismatches(profile, o, caps, build.label));
    if (o.search) {
        if (profile.search !== "legacy-scan" && o.search.legacy_scan.length > 0) {
            const reasons = [...new Set(o.search.legacy_scan)].join(", ");
            out.push(
                `${o.search.legacy_scan.length} eidnara_search results came from the legacy snapshot scan (${reasons}), but the arm declares the ${profile.search} route`,
            );
        }
        if (profile.search !== "fused" && o.search.fused > 0) {
            out.push(
                `${o.search.fused} eidnara_search results came from the fused route, but the arm declares ${profile.search}`,
            );
        }
    }
    return out;
}

/** The background cache-point layout a Pi arm's daemon variant has on `build`; undefined for another host or an arm without a daemon. */
function backgroundOf(
    o: ArmObservation,
    build: AuditedBuild | undefined,
): { layout: BackgroundCachePoints; label: string } | undefined {
    const variant = armProfile(o.arm).daemon;
    const caps = variant === null ? undefined : build?.variants[variant];
    if (o.host !== "pi" || !caps || !build) return undefined;
    return { layout: caps.background_cache_points, label: build.label };
}

/**
 * The arm's `capabilities.json`: its profile, the build the run bound (`eidnaraBuild`, as the
 * manifest records it), the run's prompt-caching condition, what the evidence shows, and every
 * difference between the two.
 */
export function capabilityRecord<B>(
    observed: ArmObservation,
    eidnaraBuild: B,
    build: AuditedBuild | undefined,
    caching: PromptCaching,
) {
    return {
        profile: armProfile(observed.arm),
        eidnara_build: eidnaraBuild,
        prompt_caching: caching,
        observed,
        mismatches: [
            ...armMismatches(observed, build),
            ...cachingMismatches(caching, observed.prompt_caching, backgroundOf(observed, build)),
        ],
    };
}

/**
 * The share of owing sessions an automatic arm must cover: every one. Automatic delivery serves the
 * statements captured in earlier sessions of a project in the `<project-memory>` block of each
 * later session's passes, so each session that owes a block carries it in some owing request.
 */
export const REQUIRED_MEMORY_COVERAGE = 1;

/**
 * Once a user statement captured in one session meets an agent request of a later session, an
 * automatic arm must have carried a `<project-memory>` block in every session that owes one (at
 * least `REQUIRED_MEMORY_COVERAGE` of them) and an explicit-search arm must have called
 * `eidnara_search`. An Eidnara arm whose agent worked in two sessions must also show its
 * capture calls in the proxy records, since every side call goes through the proxy.
 */
function memoryMismatches(profile: ArmProfile, o: ArmObservation): string[] {
    const d = o.delivery;
    if (!d || d.memory_due === undefined) return [];
    const out: string[] = [];
    if (o.statements?.error && (o.components.agent ?? 0) > 0) {
        out.push(`the final store's user statements cannot be read: ${o.statements.error}`);
    }
    const mode = deliveryOf(profile);
    const statements = (o.statements?.count ?? 0) - (o.statements?.retired ?? 0);
    if (d.memory_due && mode === "automatic" && (d.due_blocks ?? d.memory_blocks) === 0) {
        out.push(
            `the final store holds ${statements} user statements captured before later sessions' agent requests, but none of those requests carried a <project-memory> block`,
        );
    } else if (d.memory_due && mode === "automatic" && d.due_sessions !== undefined) {
        const covered = d.covered_sessions ?? 0;
        if (covered < REQUIRED_MEMORY_COVERAGE * d.due_sessions) {
            const missed = d.uncovered_sessions ?? [];
            const shown = missed.slice(0, 20).join(", ");
            const more = missed.length > 20 ? ` and ${missed.length - 20} more` : "";
            out.push(
                `${covered} of ${d.due_sessions} sessions that owe a <project-memory> block carried one (coverage ${(covered / d.due_sessions).toFixed(3)}, required ${REQUIRED_MEMORY_COVERAGE}); none in ${shown}${more}`,
            );
        }
    }
    const searches = o.search
        ? o.search.legacy_scan.length + o.search.fused + o.search.errored
        : null;
    if (d.memory_due && mode === "explicit-search" && searches === 0) {
        out.push(
            `the final store holds ${statements} user statements captured before later sessions' agent requests, but the agent never called eidnara_search on an arm that declares explicit search`,
        );
    }
    if ((d.sessions ?? 0) >= 2 && (o.components.memory_capture ?? 0) === 0) {
        out.push(
            `agent requests in ${d.sessions} sessions and no memory_capture call in the proxy records`,
        );
    }
    return out;
}

/**
 * Every daemon start of a fused-route arm logs the fixture's production search route over the
 * embedding model the arm requires; a daemon of any other arm logs none.
 */
function routeMismatches(profile: ArmProfile, o: ArmObservation): string[] {
    const r = o.daemon_routes;
    if (!r || profile.daemon === null) return [];
    if (profile.search !== "fused") {
        return r.models.length > 0
            ? [
                  `the daemon logged the production search route (${r.models.join(", ")}), but the arm declares ${profile.search}`,
              ]
            : [];
    }
    const out: string[] = [];
    if ((o.components.agent ?? 0) > 0 && r.ready === 0) {
        out.push(
            "daemon.log records no ready daemon, so the production search route is unverified",
        );
    }
    if (r.production < r.ready) {
        out.push(
            `${r.ready - r.production} of ${r.ready} daemon starts logged no production search route`,
        );
    }
    const wanted = profile.requires.embeddings;
    const other = r.models.filter((m) => m !== wanted);
    if (other.length > 0) {
        out.push(
            `the production search route ran embedding model ${other.join(", ")}, but the arm requires ${wanted}`,
        );
    }
    const share = fusedAnswerShare(o.search);
    if (o.search && share !== null && share <= MIN_FUSED_ANSWER_SHARE) {
        const total = o.search.fused + o.search.errored;
        out.push(
            `${o.search.errored} of ${total} eidnara_search results errored on the fused route (answered share ${share.toFixed(3)}, required above ${MIN_FUSED_ANSWER_SHARE})`,
        );
    }
    return out;
}

/**
 * The share of a fused arm's `eidnara_search` results the fused route must exceed: one half. The
 * arm declares the fused route as its search path (`search: "fused"`), and an errored search
 * carries no ranking from any route. The fused route is the arm's search path while it answers
 * more of the arm's searches than it refuses; at one half or below, the arm's usual search has no
 * answer, which is the `none` route's evidence. The bound follows from that declaration alone.
 */
export const MIN_FUSED_ANSWER_SHARE = 0.5;

/** The share of fused-route searches (answered plus errored) the route answered; null with none. */
export function fusedAnswerShare(search: ArmObservation["search"]): number | null {
    if (!search) return null;
    const total = search.fused + search.errored;
    return total === 0 ? null : search.fused / total;
}

/**
 * Evidence that contradicts what the bound build's variant declares for the behaviours that
 * differ by build: the lineage of each statement record and the `decisions_approval_refused`
 * counter, the lifetime classes of captured facts, the `<CURRENT_WORK>` element and ended work,
 * contested statements in the block and in search results, waiting lines outside a history
 * block's newest summarized segment, the `process_memory` block in the daemon's status, and the
 * lifecycle progress block on the fused route.
 */
function buildMismatches(
    profile: ArmProfile,
    o: ArmObservation,
    caps: DaemonCapabilities,
    label: string,
): string[] {
    const out: string[] = [];
    const answered = (o.components.agent ?? 0) > 0;
    const lineages = o.statements?.lineages;
    const statements = o.statements?.count ?? 0;
    if (lineages && statements > 0) {
        const shared = statements - lineages.per_message;
        if (caps.statement_lineage === "per-message" && shared > 0) {
            out.push(
                `${shared} of ${statements} user statements sit on a lineage shared across messages, but ${label} declares one lineage per user message`,
            );
        }
        if (caps.statement_lineage === "shared" && lineages.per_message > 0) {
            out.push(
                `${lineages.per_message} of ${statements} user statements sit on a per-message lineage, but ${label} declares one shared lineage`,
            );
        } else if (caps.statement_lineage === "shared" && lineages.count > 1) {
            out.push(
                `${statements} user statements sit on ${lineages.count} lineages, but ${label} declares one shared lineage`,
            );
        }
    }
    const counters = o.source_capture?.counters;
    if (profile.source_capture && counters) {
        const counted = Object.hasOwn(counters, "decisions_approval_refused");
        if (caps.statement_lineage === "per-message" && !counted) {
            out.push(
                `the source capture counters hold no decisions_approval_refused, which ${label} declares with its per-message statement lineage`,
            );
        }
        if (caps.statement_lineage === "shared" && counted) {
            out.push(
                `the source capture counters hold decisions_approval_refused, which ${label} does not declare`,
            );
        }
    }
    const lifetimes = Object.entries(o.statements?.lifetimes ?? {});
    const classed = lifetimes.reduce((sum, [, n]) => sum + n, 0);
    if (!caps.statement_lifetime && classed > 0) {
        out.push(
            `${classed} captured facts name a lifetime class in their rationale, which ${label} does not declare`,
        );
    }
    const classes = lifetimeClasses(caps);
    const unknown = lifetimes.filter(([name]) => !classes.includes(name));
    if (caps.statement_lifetime && unknown.length > 0) {
        out.push(
            `${unknown.reduce((sum, [, n]) => sum + n, 0)} captured facts name a lifetime class outside ${classes.join(", ")}: ${unknown.map(([name]) => name).join(", ")}`,
        );
    }
    const workBlocks = o.delivery?.work_blocks ?? 0;
    const endedWork = o.statements?.ended_work ?? 0;
    if (!caps.current_work_delivery && workBlocks + endedWork > 0) {
        out.push(
            `${workBlocks} agent requests carry a <CURRENT_WORK> element in <project-memory> and ${endedWork} captured facts record the statement that ended them, which ${label} does not declare`,
        );
    }
    const contested = (o.delivery?.contested_blocks ?? 0) + (o.search?.contested ?? 0);
    if (!caps.contested_statements && contested > 0) {
        out.push(
            `${o.delivery?.contested_blocks ?? 0} agent requests and ${o.search?.contested ?? 0} eidnara_search results render a contested statement, which ${label} does not declare`,
        );
    }
    const items = o.delivery?.open_items;
    if (caps.keyed_open_items && items && items.stale_waiting_blocks > 0) {
        out.push(
            `${items.stale_waiting_blocks} of ${items.blocks} rendered history blocks hold a waiting line before a later summarized segment (first requests ${items.stale_requests.join(", ")}), but ${label} declares waiting lines in the newest segment alone`,
        );
    }
    // A status read returns after the sample that started it, so a short arm can end with samples
    // and no reading; only readings that returned are evidence of what the answer carries.
    const status = o.daemon_status;
    if (status && answered && status.readings > 0) {
        if (caps.process_memory && status.process_memory === 0) {
            out.push(
                `none of ${status.readings} daemon status readings carries the process_memory block, which ${label} declares`,
            );
        }
        if (!caps.process_memory && status.process_memory > 0) {
            out.push(
                `${status.process_memory} daemon status readings carry a process_memory block, which ${label} does not declare`,
            );
        }
        if (
            caps.search_progress &&
            profile.search === "fused" &&
            status.search_progress.samples === 0
        ) {
            out.push(
                `none of ${status.readings} daemon status readings carries a search.lifecycle.status progress block, which ${label} declares for the fused route`,
            );
        }
    } else if (status && answered && status.read_errors > 0) {
        out.push(
            `all ${status.read_errors} daemon status reads failed, so the status ${label} declares is unverified`,
        );
    }
    return out;
}

/**
 * An arm that consents to source capture and answered agent calls must leave message descriptors
 * in its final store and report its counter total; an arm without the consent must
 * leave no descriptor.
 */
function captureMismatches(profile: ArmProfile, o: ArmObservation): string[] {
    const c = o.source_capture;
    if (!c) return [];
    if (profile.daemon === null) return [];
    const total = Object.values(c.descriptors ?? {}).reduce((a, b) => a + b, 0);
    const answered = (o.components.agent ?? 0) > 0;
    if (!profile.source_capture) {
        if (total > 0) {
            return [
                `${total} source descriptors in the final store, but the arm declares source capture off`,
            ];
        }
        return answered && c.descriptors === null
            ? [
                  "the final Kernel store is absent or unreadable, so source capture off is unverified",
              ]
            : [];
    }
    if (!answered) return [];
    const out: string[] = [];
    if (c.descriptors === null) {
        out.push("the final Kernel store is absent or unreadable, so source capture is unverified");
    } else if ((c.descriptors.messages ?? 0) === 0) {
        out.push(
            `the final store holds no message source descriptor (${JSON.stringify(c.descriptors)}), but the arm declares source capture on`,
        );
    }
    if (c.counters === null) out.push(`source capture counters unread: ${c.counters_error}`);
    return out;
}

/**
 * Binds the run to the audited build its clone holds: the first registered build whose commit the
 * clone has, whose table registers every daemon variant the arms run, and whose copies of every
 * source that fixes those variants' capabilities match the clone's working tree. With no such
 * build the recorded capabilities may describe another daemon than the one built, and the run
 * stops before it starts one. A run whose arms use no daemon binds none.
 */
export function requireAuditedVariants(
    checkout: string,
    arms: readonly string[],
    builds: readonly AuditedBuild[] = AUDITED_BUILDS,
): AuditedBuild | null {
    const variants = [
        ...new Set(arms.map((a) => armProfile(a).daemon).filter((v) => v !== null)),
    ] as DaemonVariant[];
    if (variants.length === 0) return null;
    const git = (args: string[]) =>
        Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
    const refusal = (build: AuditedBuild): string | null => {
        if (git(["cat-file", "-e", `${build.commit}^{commit}`]).exitCode !== 0) {
            return `${checkout} lacks commit ${build.commit} (${build.label}), whose source the daemon capabilities in src/hosts/profiles.ts were read from`;
        }
        for (const variant of variants) {
            const record = build.variants[variant];
            if (!record) return `${build.label} (${build.commit}) registers no ${variant} variant`;
            // Against the working tree, so an uncommitted edit to a source counts as a change too.
            const diff = git(["diff", "--name-only", build.commit, "--", ...record.sources]);
            const changed = diff.stdout.toString().trim().split("\n").join(", ");
            if (diff.exitCode !== 0 || changed !== "") {
                return `${variant} capabilities were read at ${build.commit} (${build.label}), and ${changed || "the comparison"} ${changed ? "changed" : "failed"} since; read them again in src/hosts/profiles.ts`;
            }
        }
        return null;
    };
    const refusals: string[] = [];
    for (const build of builds) {
        const why = refusal(build);
        if (why !== null) {
            refusals.push(why);
            continue;
        }
        const manifest = payloadManifest(checkout);
        if (variants.includes("direct-host-fixture-fused") && !existsSync(manifest)) {
            throw new Error(
                `direct-host-fixture-fused loads the payload's embedding lane, and ${manifest} is absent; build the development payload (bun run payload:dev) in the build clone`,
            );
        }
        return build;
    }
    throw new Error(refusals.join("; "));
}
