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
import { payloadManifest } from "../hosts/arms";
import {
    type ArmProfile,
    AUDITED_EIDNARA,
    armProfile,
    DAEMON_VARIANTS,
    type DaemonVariant,
    deliveryOf,
} from "../hosts/profiles";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord } from "../proxy/records";
import { type PartLookup, rebuildRequest } from "../proxy/requests";
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
    search: { legacy_scan: string[]; fused: number; errored: number } | null;
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
}

/**
 * The committed user statements (`stm_*` decisions whose commit the log holds) in
 * `final-store/kernel.sqlite`, with the sessions their capture rationale names and the count of
 * those whose payload names none; null when the store is absent, and an `error` when its
 * decisions cannot be read.
 */
export type StatementObservation = {
    count: number;
    sessions: string[];
    unattributed: number;
    /** Why the store's decisions could not be read, or null. */
    error: string | null;
} | null;

/**
 * The daemon generations `daemon.log` records: ready records, and the fixture's production search
 * route lines with the embedding models they name.
 */
export interface DaemonRouteObservation {
    ready: number;
    /** Ready generations whose route line came after the previous ready record. */
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
 * rebuilt, how many carry a block the Eidnara plugin writes, which owed oracle notes reached the
 * prompt of their own turn, and which requests carry a note outside its session or before its
 * turn, or an opening that matches no owed note.
 */
export interface DeliveryObservation {
    requests: number;
    unreadable: number;
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
}

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

export function observeDelivery(
    calls: readonly (Pick<CallRecord, "seq" | "component" | "session" | "turn" | "request"> &
        Partial<Pick<CallRecord, "started_wall_ms" | "wall_ms">>)[],
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
    };
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
        if (call.component === "memory_capture" && session !== null) {
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
        if (injectedBlocks(text).length > 0) out.injected_blocks++;
        const given = bodyText({
            system: body.system,
            messages: (body.messages ?? []).filter((m) => m?.role === "user"),
        });
        if (injectedBlocks(given).some((b) => b.tag === "project-memory")) {
            memoryBlocks++;
            agent.block = true;
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
    out.sessions = new Set(agentCalls.map((c) => c.session)).size;
    const owed = owingRequests(agentCalls, lastCapture, lastCall, statementSessions, projectOf);
    out.memory_due = owed.length > 0;
    out.due_blocks = owed.filter((c) => c.block).length;
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
            `${o.injected_blocks} agent requests carry an Eidnara injected block, but the arm declares explicit search alone`,
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
    const search = { legacy_scan: [] as string[], fused: 0, errored: 0 };
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
 * session in the rationale of its JSON payload. Null when the store is absent or unreadable.
 */
export function readStatements(kernelPath: string): StatementObservation {
    if (!lstatSync(kernelPath, { throwIfNoEntry: false })?.isFile()) return null;
    let db: Database | null = null;
    try {
        db = new Database(kernelPath, { readonly: true });
        const rows = db
            .query(
                `select decision_payload as p from decisions
                 where object_id glob 'stm_*'
                   and created_commit_seq in (select commit_seq from commit_log)`,
            )
            .all() as { p: Uint8Array | string }[];
        const sessions = new Set<string>();
        let unattributed = 0;
        for (const { p } of rows) {
            const text = typeof p === "string" ? p : new TextDecoder().decode(p);
            let session: unknown = null;
            try {
                session = JSON.parse(String(JSON.parse(text)?.rationale ?? "null"))?.session;
            } catch {
                session = null;
            }
            if (typeof session === "string") sessions.add(session);
            else unattributed++;
        }
        return { count: rows.length, sessions: [...sessions].sort(), unattributed, error: null };
    } catch (caught) {
        const error = (caught as Error).message;
        return { count: 0, sessions: [], unattributed: 0, error };
    } finally {
        db?.close();
    }
}

const ROUTE_LINE = /direct_host_fixture: search route production, embedding model ([^,\s]+)/;

/**
 * Reads `daemon.log` in order: each ready record closes one daemon generation, which counts as
 * production when a route line came after the previous ready record. `models` lists the embedding
 * models every route line names.
 */
export function readDaemonRoutes(path: string): DaemonRouteObservation {
    const out: DaemonRouteObservation = { ready: 0, production: 0, models: [] };
    const models = new Set<string>();
    let routed = false;
    eachLine(path, (line) => {
        if (line.startsWith("{") && line.includes('"status":"ready"')) {
            out.ready++;
            if (routed) out.production++;
            routed = false;
            return;
        }
        const route = ROUTE_LINE.exec(line);
        if (route) {
            routed = true;
            models.add(route[1] as string);
        }
    });
    out.models = [...models].sort();
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

/** Every difference between what the arm's profile declares and what its run evidence shows. */
export function armMismatches(o: ArmObservation): string[] {
    const profile = armProfile(o.arm);
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

/**
 * Once a user statement captured in one session meets an agent request of a later session, an
 * automatic arm must have carried a `<project-memory>` block and an explicit-search arm must have
 * called `eidnara_search`. An Eidnara arm whose agent worked in two sessions must also show its
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
    const statements = o.statements?.count ?? 0;
    if (d.memory_due && mode === "automatic" && (d.due_blocks ?? d.memory_blocks) === 0) {
        out.push(
            `the final store holds ${statements} user statements captured before later sessions' agent requests, but none of those requests carried a <project-memory> block`,
        );
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
    if (
        o.search &&
        o.search.fused === 0 &&
        o.search.legacy_scan.length === 0 &&
        o.search.errored > 0
    ) {
        out.push(`all ${o.search.errored} eidnara_search results errored on the fused route`);
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
 * The build clone's copies of every source that fixes a variant's capabilities match those at
 * `AUDITED_EIDNARA`, for each daemon variant the arms run; otherwise the recorded capabilities may
 * describe another daemon than the one built, and the run stops before it starts one.
 */
export function requireAuditedVariants(
    checkout: string,
    arms: readonly string[],
    audited = AUDITED_EIDNARA,
): void {
    const variants = [
        ...new Set(arms.map((a) => armProfile(a).daemon).filter((v) => v !== null)),
    ] as DaemonVariant[];
    if (variants.length === 0) return;
    const git = (args: string[]) =>
        Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
    if (git(["cat-file", "-e", `${audited}^{commit}`]).exitCode !== 0) {
        throw new Error(
            `${checkout} lacks commit ${audited}, whose source the daemon capabilities in src/hosts/profiles.ts were read from`,
        );
    }
    const manifest = payloadManifest(checkout);
    if (variants.includes("direct-host-fixture-fused") && !existsSync(manifest)) {
        throw new Error(
            `direct-host-fixture-fused loads the payload's embedding lane, and ${manifest} is absent; build the development payload (bun run payload:dev) in the build clone`,
        );
    }
    for (const variant of variants) {
        const { sources } = DAEMON_VARIANTS[variant];
        // Against the working tree, so an uncommitted edit to a source counts as a change too.
        const diff = git(["diff", "--name-only", audited, "--", ...sources]);
        const changed = diff.stdout.toString().trim();
        if (diff.exitCode !== 0 || changed !== "") {
            throw new Error(
                `${variant} capabilities were read at ${audited}, and ${changed || "the comparison"} ${changed ? "changed" : "failed"} since; read them again in src/hosts/profiles.ts`,
            );
        }
    }
}
