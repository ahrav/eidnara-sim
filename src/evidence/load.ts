import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GradeRefused } from "../grade/artefacts";
import { GradeLog, type GradeRecord } from "../grade/probes";
import type { ConverseBody } from "../proxy/classify";
import { type CallRecord, recordProblems } from "../proxy/records";
import { type RequestPart, readRequestParts, rebuildRequest } from "../proxy/requests";
import { type Entry, readJournal, readJsonl } from "../run/journal";
import { scenarioHash } from "../scenario/compile";

/** The scenario fields the evidence path reads. */
export interface EvidenceScenario {
    events: Array<{
        id: string;
        kind: string;
        session?: string;
        project?: string;
        path?: string;
        content?: string;
        text?: string;
        remove?: boolean;
        probe?: string;
    }>;
    probes: Array<{
        id: string;
        type: string;
        event?: string;
        session?: string;
        project?: string;
        fact?: string;
        text?: string;
        ground_truth?: {
            expect?: string;
            present?: string[][];
            absent?: string[];
            stale?: string[];
            sources?: string[];
        };
    }>;
    sessions: Array<{ id: string; project: string; forced_p90?: boolean }>;
    faults?: Array<{ id: string; type: string }>;
}

export interface ArmProfileView {
    plugin?: boolean;
    host_compaction?: boolean;
    eidnara_compaction?: boolean;
    search?: string;
    role?: string;
}

export interface ToolRun {
    line: number;
    turn: string | null;
    command: string;
    exit: number | null;
    call?: string;
}

/** A tool result the host transcript recorded: what the tool returned to the host. */
export interface TranscriptResult {
    file: string;
    toolCallId: string;
    toolName: string;
    text: string;
    isError: boolean;
}

/** A memory object the final store holds, with its creation and retirement on the daemon clock. */
export interface StoreObject {
    store: "kernel" | "notes" | "user_memories";
    id: string;
    text: string;
    /** `project:<key>` for a kernel object, the note's project path, or null. */
    scope: string | null;
    created_ms: number | null;
    retired_ms: number | null;
    superseded_by: string | null;
}

export interface CaptureJob {
    session: string;
    project: string;
    created_ms: number;
    committed_ms: number | null;
    abandoned_ms: number | null;
}

export interface ArmData {
    arm: string;
    profile: ArmProfileView | null;
    tools: ToolRun[] | null;
    transcripts: Map<string, TranscriptResult> | null;
    pluginLog: string[] | null;
    objects: StoreObject[] | null;
    captures: CaptureJob[] | null;
}

export interface RunData {
    dir: string;
    host: string;
    contextLimit: number;
    scenario: EvidenceScenario;
    journal: Entry[];
    calls: CallRecord[];
    /** The fault schedule the run used: the manifest's override, else the scenario's. */
    faults: Array<{ id: string; type: string }>;
    /** The request part log, or null for a run recorded before the proxy stored bodies. */
    parts: Map<string, RequestPart> | null;
    grades: GradeRecord[];
    arms: Map<string, ArmData>;
}

function readJsonFile<T>(path: string): T | null {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Pi's session transcripts under the arm's home: every tool result keyed by its call id. */
export function readPiTranscripts(sessionsDir: string): Map<string, TranscriptResult> | null {
    const stat = lstatSync(sessionsDir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return null;
    const out = new Map<string, TranscriptResult>();
    const walk = (dir: string, depth: number) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            const s = lstatSync(path, { throwIfNoEntry: false });
            if (s?.isDirectory() && depth > 0) walk(path, depth - 1);
            if (!s?.isFile() || !name.endsWith(".jsonl")) continue;
            for (const line of readFileSync(path, "utf8").split("\n")) {
                if (!line.includes('"toolResult"')) continue;
                let entry: { message?: Record<string, unknown> };
                try {
                    entry = JSON.parse(line);
                } catch {
                    continue;
                }
                const m = entry.message;
                if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
                // Retrieval reads Eidnara's own tools only; other results stay unread.
                if (typeof m.toolName !== "string" || !m.toolName.startsWith("eidnara_")) continue;
                const text = (Array.isArray(m.content) ? m.content : [])
                    .map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
                    .join("\n");
                out.set(m.toolCallId, {
                    file: path,
                    toolCallId: m.toolCallId,
                    toolName: typeof m.toolName === "string" ? m.toolName : "",
                    text,
                    isError: m.isError === true,
                });
            }
        }
    };
    walk(sessionsDir, 2);
    return out;
}

/** Transcript pointers relative to the run directory, so a copied run keeps them valid. */
function relativeFiles(
    dir: string,
    results: Map<string, TranscriptResult> | null,
): Map<string, TranscriptResult> | null {
    if (!results) return null;
    for (const r of results.values()) r.file = relative(dir, r.file);
    return results;
}

const blobText = (v: unknown): string =>
    v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : typeof v === "string" ? v : "";

class StoreUnreadable extends Error {}

const isSqliteError = (e: unknown) =>
    e instanceof Error &&
    (e.name === "SQLiteError" || /^SQLITE_/.test(String((e as { code?: unknown }).code)));

function openStore(path: string): Database | null {
    try {
        return new Database(path, { readonly: true });
    } catch (caught) {
        if (isSqliteError(caught)) return null;
        throw caught;
    }
}

/** The final store's memory objects and capture jobs; null parts when a database is absent. */
export function readStore(dir: string): Pick<ArmData, "objects" | "captures"> {
    const kernelPath = join(dir, "kernel.sqlite");
    const storePath = join(dir, "store.db");
    const objects: StoreObject[] = [];
    let captures: CaptureJob[] | null = null;
    const commits = new Map<number, number>();
    let kernelRead = false;
    if (lstatSync(kernelPath, { throwIfNoEntry: false })?.isFile()) {
        const db = openStore(kernelPath);
        try {
            if (!db) throw new StoreUnreadable();
            for (const r of db.query("select commit_seq, recorded_at from commit_log").all() as {
                commit_seq: number;
                recorded_at: number;
            }[]) {
                commits.set(r.commit_seq, r.recorded_at);
            }
            const rows = db
                .query(
                    `select o.object_id as id, o.created_commit_seq as created,
                        o.invalidated_commit_seq as invalidated, o.superseded_by as superseded,
                        d.decision_payload as payload, d.scope_id as scope
                     from object_registry o join decisions d using (object_id)
                     union all
                     select o.object_id, o.created_commit_seq, o.invalidated_commit_seq,
                        o.superseded_by, p.value, p.scope_id
                     from object_registry o join propositions p using (object_id)`,
                )
                .all() as {
                id: string;
                created: number;
                invalidated: number | null;
                superseded: string | null;
                payload: unknown;
                scope: string | null;
            }[];
            for (const r of rows) {
                // A creation commit the log lacks leaves the store's timeline unknown.
                if (!commits.has(r.created)) throw new StoreUnreadable();
                objects.push({
                    store: "kernel",
                    id: r.id,
                    text: blobText(r.payload),
                    scope: r.scope,
                    created_ms: commits.get(r.created) as number,
                    // An invalidation whose commit row is missing retired the object at an
                    // unknown time, read as before any probe.
                    retired_ms: r.invalidated === null ? null : (commits.get(r.invalidated) ?? 0),
                    superseded_by: r.superseded,
                });
            }
            kernelRead = true;
        } catch (caught) {
            // A store a crash or fault left half-written reads as unobserved.
            if (!(caught instanceof StoreUnreadable) && !isSqliteError(caught)) throw caught;
            objects.length = 0;
        } finally {
            db?.close();
        }
    }
    let storeRead = false;
    if (lstatSync(storePath, { throwIfNoEntry: false })?.isFile()) {
        const db = openStore(storePath);
        const kept = objects.length;
        try {
            if (!db) throw new StoreUnreadable();
            const has = (t: string) =>
                db.query("select 1 from sqlite_master where type='table' and name=?").get(t) !==
                null;
            if (has("notes")) {
                for (const r of db
                    .query(
                        "select id, content, project_path, status, created_at_ms, dismissed_at from notes",
                    )
                    .all() as {
                    id: number;
                    content: string;
                    project_path: string;
                    status: string;
                    created_at_ms: number;
                    dismissed_at: number | null;
                }[]) {
                    objects.push({
                        store: "notes",
                        id: `note:${r.id}`,
                        text: r.content,
                        scope: r.project_path,
                        created_ms: r.created_at_ms || null,
                        retired_ms: r.status === "dismissed" ? (r.dismissed_at ?? 0) : null,
                        superseded_by: null,
                    });
                }
            }
            if (has("user_memories")) {
                for (const r of db
                    .query("select id, content, status, created_at, updated_at from user_memories")
                    .all() as {
                    id: number;
                    content: string;
                    status: string;
                    created_at: number;
                    updated_at: number;
                }[]) {
                    objects.push({
                        store: "user_memories",
                        id: `user_memory:${r.id}`,
                        text: r.content,
                        scope: null,
                        created_ms: r.created_at || null,
                        retired_ms: r.status === "active" ? null : r.updated_at,
                        superseded_by: null,
                    });
                }
            }
            if (has("memory_capture_jobs")) {
                captures = (
                    db
                        .query(
                            "select session_id, project, created_at_ms, commit_seq, abandoned_at_ms from memory_capture_jobs",
                        )
                        .all() as {
                        session_id: string;
                        project: string;
                        created_at_ms: number;
                        commit_seq: number | null;
                        abandoned_at_ms: number | null;
                    }[]
                ).map((r) => ({
                    session: r.session_id.replace(/^sim-/, ""),
                    project: r.project,
                    created_ms: r.created_at_ms,
                    committed_ms:
                        r.commit_seq === null ? null : (commits.get(r.commit_seq) ?? null),
                    abandoned_ms: r.abandoned_at_ms,
                }));
            }
            storeRead = true;
        } catch (caught) {
            if (!(caught instanceof StoreUnreadable) && !isSqliteError(caught)) throw caught;
            objects.length = kept;
            captures = null;
        } finally {
            db?.close();
        }
    }
    // A negative answer needs every store: one database alone leaves the stage unobserved.
    return { objects: kernelRead && storeRead ? objects : null, captures };
}

/**
 * The latest grade of each item, arm, and opponent. For a legacy run, a log the current grader
 * refuses (an earlier grader schema) is read line by line for the fields the evidence path
 * uses, so the run can be attributed without being regraded.
 */
export function readGrades(path: string, legacy: boolean): GradeRecord[] {
    try {
        return new GradeLog(path).latest();
    } catch (caught) {
        // A current run's refused log is damaged or tampered, and its refusal stands.
        if (!legacy || !(caught instanceof GradeRefused)) throw caught;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) {
        throw new GradeRefused(`grade log ${path} is a link, not a regular file`);
    }
    const latest = new Map<string, GradeRecord>();
    for (const g of readJsonl<GradeRecord>(path)) {
        if (typeof g?.item !== "string" || typeof g.arm !== "string") continue;
        if (typeof g.verdict !== "string") continue;
        const key = `${g.item}/${g.arm}/${g.against ?? ""}`;
        const prior = latest.get(key);
        if (!prior || (g.version ?? 0) >= (prior.version ?? 0)) latest.set(key, g);
    }
    return [...latest.values()];
}

/**
 * Reads a run directory for the evidence path. Every read opens a file without writing it; a
 * missing artefact reads as null, and the stage that needs it reports `unobserved`.
 */
export function loadRun(dir: string): RunData {
    const manifest = readJsonFile<{
        scenario_hash?: string;
        fault_override?: Array<{ id: string; type: string }> | null;
        host?: string;
        context_limit?: number;
        order?: string[];
        arms?: Record<string, { profile?: ArmProfileView }>;
    }>(join(dir, "manifest.json"));
    if (!manifest) throw new Error(`${dir}: no manifest.json`);
    const scenario = readJsonFile<EvidenceScenario>(join(dir, "scenario.json"));
    if (!scenario) throw new Error(`${dir}: no scenario.json`);
    const digest = scenarioHash(scenario as unknown as Record<string, unknown>);
    if (digest !== manifest.scenario_hash) {
        throw new Error(
            `${dir}: scenario_hash ${digest} differs from the manifest's ${manifest.scenario_hash}`,
        );
    }
    const requestsPath = join(dir, "requests.jsonl");
    // A scenario without ground truth predates the current generator and grader.
    const legacy = !scenario.probes.some((p) => p.ground_truth !== undefined);
    const grades = existsSync(join(dir, "grades.jsonl"))
        ? readGrades(join(dir, "grades.jsonl"), legacy)
        : [];
    const arms = new Map<string, ArmData>();
    for (const arm of manifest.order ?? Object.keys(manifest.arms ?? {})) {
        // An arm is one directory of this run; a name or link that leaves it is refused.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(arm)) {
            throw new Error(`${dir}: arm ${JSON.stringify(arm)} is not a directory name`);
        }
        const root = join(dir, arm);
        if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
            throw new Error(`${root} is a link; an arm directory must be the run's own`);
        }
        const toolsPath = join(root, "tools.jsonl");
        const tools = lstatSync(toolsPath, { throwIfNoEntry: false })?.isFile()
            ? readTools(toolsPath)
            : null;
        const logPath = join(root, "r", "eidnara.log");
        const pluginLog = lstatSync(logPath, { throwIfNoEntry: false })?.isFile()
            ? readFileSync(logPath, "utf8").split("\n")
            : null;
        const capabilities = readJsonFile<{ profile?: ArmProfileView }>(
            join(root, "capabilities.json"),
        );
        arms.set(arm, {
            arm,
            profile: manifest.arms?.[arm]?.profile ?? capabilities?.profile ?? null,
            tools,
            transcripts:
                manifest.host === "pi"
                    ? relativeFiles(
                          dir,
                          readPiTranscripts(join(root, "r", "home", ".pi", "agent", "sessions")),
                      )
                    : null,
            pluginLog,
            ...readStore(join(root, "final-store")),
        });
    }
    return {
        dir,
        host: manifest.host ?? "pi",
        contextLimit: manifest.context_limit ?? 200_000,
        scenario,
        faults: manifest.fault_override ?? scenario.faults ?? [],
        journal: readJournal(join(dir, "journal.jsonl")),
        calls: readCalls(join(dir, "calls.jsonl")),
        parts: lstatSync(requestsPath, { throwIfNoEntry: false })?.isFile()
            ? readRequestParts(requestsPath)
            : null,
        grades,
        arms,
    };
}

/** The tool ledger, each row checked as the grader checks it: an integer or null exit. */
export function readTools(path: string): ToolRun[] {
    return readJsonl<Record<string, unknown>>(path).map((r, i) => {
        const { turn, command, exit, scenario_ms, call } = r;
        if (
            (turn !== null && typeof turn !== "string") ||
            typeof command !== "string" ||
            !(exit === null || Number.isInteger(exit)) ||
            typeof scenario_ms !== "number" ||
            !Number.isFinite(scenario_ms) ||
            (call !== undefined && typeof call !== "string")
        ) {
            throw new Error(`${path} line ${i + 1} is not a tool run`);
        }
        return {
            line: i + 1,
            turn,
            command,
            exit: exit as number | null,
            ...(call === undefined ? {} : { call }),
        };
    });
}

/** The call log, each record checked for its fields and its position. */
export function readCalls(path: string): CallRecord[] {
    const calls = readJsonl<CallRecord>(path);
    calls.forEach((c, i) => {
        const problems = recordProblems(c);
        if (problems.length > 0) {
            throw new Error(`${path} line ${i + 1}: ${problems.join(", ")}`);
        }
        if (c.seq !== i) throw new Error(`${path} line ${i + 1}: seq ${c.seq} at position ${i}`);
    });
    return calls;
}

/** A recorded request body, or null when the run kept none for that call. */
export function requestOf(run: RunData, call: CallRecord): ConverseBody | null {
    if (!run.parts || !call.request) return null;
    return rebuildRequest(call.request, run.parts);
}
