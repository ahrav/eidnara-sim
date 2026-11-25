import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import type { Entry } from "../run/journal";

/** The producers of the memory reviewer's receipts in the Kernel store. */
export const PRODUCER_DISPUTE = "eidnara-daemon/memory-reviewer-contest";
export const PRODUCER_CONTEST = "eidnara-daemon/memory-reviewer-later-statement";
export const PRODUCER_SETTLEMENT = "eidnara-kernel/memory-reviewer-settlement";

export const CHANGE_KINDS = ["disputed", "contested", "retired", "revised", "created"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const TARGET_KINDS = [
    "user statement",
    "work in progress",
    "assistant report",
    "agent note",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** One passage a proposal cites against its memory: a reference alias and a byte range of its text. */
export interface CitedSpan {
    alias: string;
    start: number | null;
    end: number | null;
}

/**
 * One written change of the memory reviewer, read from its receipts in an arm's final store. Times
 * are the daemon's clock, as `commit_log.recorded_at` holds them.
 */
export interface ReviewerChange {
    kind: ChangeKind;
    /** The review job: the first 16 hex digits of its causal identity. */
    job: string;
    /** The memory the change targets. */
    target: string;
    /** The target's text as the store holds it. */
    text: string;
    target_kind: TargetKind;
    /** Whether the target is a statement of the user: its text opens `User stated`, or a statement record names it. */
    user_statement: boolean;
    commit_seq: number;
    recorded_ms: number;
    /** When the target row was stored: the time of its creating commit; null when the log lacks it. */
    stored_ms: number | null;
    /** The target's visibility by its last admission decision before the change, and by the change's own. */
    delivery: { before: string | null; after: string | null };
    /** The project the review job ran in: the last segment of its workspace path. */
    project: string | null;
    /** The proposal the change applied: its action, the text a revision gives, and the passages cited against the memory. */
    proposal: { action: string; new_text: string | null; contradictions: CitedSpan[] } | null;
    /** A contested mark's later statement: the memory the mark names, with its text. */
    contested_by: { memory: string; text: string } | null;
}

/** Whether a change took its target out of automatic delivery, by the store's admission decisions. */
export const leftAutomatic = (c: Pick<ReviewerChange, "delivery">): boolean =>
    c.delivery.before === "automatic" && c.delivery.after !== "automatic";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const parsed = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/** A decision row's summary and its rationale, which capture writes as a JSON object. */
function rowOf(payload: string): { summary: string; rationale: Obj } {
    const p = parsed(payload);
    if (!isObj(p)) return { summary: "", rationale: {} };
    const raw = p.rationale;
    const rationale = typeof raw === "string" && raw.startsWith("{") ? parsed(raw) : null;
    return {
        summary: typeof p.summary === "string" ? p.summary : "",
        rationale: isObj(rationale) ? rationale : {},
    };
}

const isSqliteError = (e: unknown) =>
    e instanceof Error &&
    (e.name === "SQLiteError" || /^SQLITE_/.test(String((e as { code?: unknown }).code)));

/** The rows of one query; an empty list when the store lacks the table or a column. */
function rows<T>(db: Database, sql: string, ...args: (string | number)[]): T[] {
    try {
        return db.query(sql).all(...args) as T[];
    } catch (caught) {
        if (isSqliteError(caught)) return [];
        throw caught;
    }
}

/** The kind of a target row by its writer: the creating commit's producer, the rationale, and the text. */
function targetKind(text: string, rationale: Obj, producer: string | undefined): TargetKind {
    if (producer === "plugin") return "agent note";
    if (text.startsWith("Assistant reported")) return "assistant report";
    if (rationale.lifetime === "current_work") return "work in progress";
    if (text.startsWith("User stated") || rationale.speaker === "user") return "user statement";
    return "assistant report";
}

const spans = (list: unknown): CitedSpan[] =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
        const span = isObj(entry) ? entry.span : null;
        if (!isObj(span) || typeof span.alias !== "string") return [];
        const at = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);
        return [{ alias: span.alias, start: at(span.start), end: at(span.end) }];
    });

/**
 * The reviewer's written changes in the final store under `storeDir`, in commit order; null when
 * the Kernel store is absent or unreadable.
 *
 * A dispute receipt names its target through the `mark_disputed` admission decision of its commit.
 * A later-statement receipt whose result is a row id is a contested mark: its target is the
 * statement that commit superseded by the result row. A settlement receipt's result names the
 * target and the effect; `retired`, `revised` and `created` are changes. The proposal a change
 * applied is the selected candidate of its job's receipt in `store.db`.
 */
export function readChanges(storeDir: string): ReviewerChange[] | null {
    const kernelPath = join(storeDir, "kernel.sqlite");
    if (!lstatSync(kernelPath, { throwIfNoEntry: false })?.isFile()) return null;
    let kernel: Database;
    try {
        kernel = new Database(kernelPath, { readonly: true });
    } catch (caught) {
        if (isSqliteError(caught)) return null;
        throw caught;
    }
    const storePath = join(storeDir, "store.db");
    let store: Database | null = null;
    try {
        if (lstatSync(storePath, { throwIfNoEntry: false })?.isFile()) {
            store = new Database(storePath, { readonly: true });
        }
    } catch (caught) {
        if (!isSqliteError(caught)) throw caught;
    }
    try {
        const receipts = rows<{
            producer: string;
            key: string;
            seq: number | null;
            result: string | null;
            created: number;
        }>(
            kernel,
            `select producer, operation_key as key, commit_seq as seq,
                cast(result_payload as text) as result, created_at as created
             from operation_receipts where producer in (?, ?, ?) order by commit_seq, created_at`,
            PRODUCER_DISPUTE,
            PRODUCER_CONTEST,
            PRODUCER_SETTLEMENT,
        );
        const decisions = new Map(
            rows<{
                id: string;
                payload: string | null;
                created: number;
                invalidated: number | null;
                superseded: string | null;
            }>(
                kernel,
                `select object_id as id, cast(decision_payload as text) as payload,
                    created_commit_seq as created, invalidated_commit_seq as invalidated,
                    superseded_by as superseded from decisions`,
            ).map((d) => [d.id, d]),
        );
        const commits = new Map(
            rows<{ seq: number; at: number; key: string; producer: string }>(
                kernel,
                "select commit_seq as seq, recorded_at as at, operation_key as key, producer from commit_log",
            ).map((c) => [c.seq, c]),
        );
        const disputed = new Map(
            rows<{ seq: number; id: string }>(
                kernel,
                `select commit_seq as seq, subject_object_id as id from admission_decisions
                 where event_kind = 'mark_disputed'`,
            ).map((r) => [r.seq, r.id]),
        );
        // A statement record (`stm_`) names the memory that holds a user's statement.
        const statements = new Set<unknown>();
        for (const [id, d] of decisions) {
            if (id.startsWith("stm_")) statements.add(rowOf(d.payload ?? "").rationale.memory);
        }
        const out: ReviewerChange[] = [];
        const add = (
            kind: ChangeKind,
            job: string,
            target: string,
            seq: number,
            at: number,
            contestedBy: ReviewerChange["contested_by"] = null,
        ) => {
            const decision = decisions.get(target);
            const { summary, rationale } = rowOf(decision?.payload ?? "");
            const created = decision ? commits.get(decision.created) : undefined;
            const admissions = rows<{ seq: number; visibility: string }>(
                kernel,
                `select commit_seq as seq, visibility from admission_decisions
                 where subject_object_id = ? order by commit_seq, decided_at, admission_decision_id`,
                target,
            );
            const receipt = store
                ? rows<{ candidate: string | null }>(
                      store,
                      `select selected_candidate_id as candidate from memory_reviewer_receipts
                       where substr(causal_identity, 1, 16) = ?`,
                      job,
                  )[0]
                : undefined;
            const project = store
                ? rows<{ project: string }>(
                      store,
                      "select project from memory_reviewer_jobs where substr(causal_identity, 1, 16) = ?",
                      job,
                  )[0]?.project
                : undefined;
            const candidate = receipt?.candidate
                ? rows<{ payload: string }>(
                      kernel,
                      "select cast(payload as text) as payload from candidates where candidate_id = ?",
                      receipt.candidate,
                  )[0]
                : undefined;
            const wrapped = candidate ? parsed(candidate.payload) : null;
            const body = isObj(wrapped) && isObj(wrapped.body) ? wrapped.body : null;
            out.push({
                kind,
                job,
                target,
                text: summary,
                target_kind: targetKind(summary, rationale, created?.producer),
                user_statement: summary.startsWith("User stated") || statements.has(target),
                commit_seq: seq,
                recorded_ms: commits.get(seq)?.at ?? at,
                stored_ms: created?.at ?? null,
                delivery: {
                    before: admissions.filter((a) => a.seq < seq).at(-1)?.visibility ?? null,
                    after: admissions.filter((a) => a.seq === seq).at(-1)?.visibility ?? null,
                },
                project: project ? basename(project) : null,
                proposal:
                    body && typeof body.action === "string"
                        ? {
                              action: body.action,
                              new_text: typeof body.new_text === "string" ? body.new_text : null,
                              contradictions: spans(body.contradictions),
                          }
                        : null,
                contested_by: contestedBy,
            });
        };
        for (const r of receipts) {
            if (r.seq === null) continue;
            const job = (r.key.split("#").at(-1) ?? "").slice(0, 16);
            const result =
                r.result === null || r.result === '""' || r.result === "null" ? "" : r.result;
            if (r.producer === PRODUCER_DISPUTE) {
                const target = disputed.get(r.seq);
                if (target) add("disputed", job, target, r.seq, r.created);
            } else if (r.producer === PRODUCER_CONTEST) {
                // An empty result is a statement left standing: the reviewer wrote nothing.
                if (result === "") continue;
                const superseded = [...decisions.values()].find(
                    (d) => d.invalidated === r.seq && d.superseded === result,
                );
                const by = rowOf(decisions.get(result)?.payload ?? "").rationale.contested_by;
                const memory = isObj(by) && typeof by.memory === "string" ? by.memory : null;
                add(
                    "contested",
                    job,
                    superseded?.id ?? result,
                    r.seq,
                    r.created,
                    memory
                        ? { memory, text: rowOf(decisions.get(memory)?.payload ?? "").summary }
                        : null,
                );
            } else {
                const settled = parsed(result);
                if (!isObj(settled)) continue;
                const effect = isObj(settled.effect) ? settled.effect.kind : settled.effect;
                const name = String(effect).toLowerCase();
                const target = isObj(settled.target) ? settled.target.object_id : null;
                if (
                    (name === "retired" || name === "revised" || name === "created") &&
                    typeof target === "string"
                ) {
                    const named = (commits.get(r.seq)?.key ?? "").split("#")[1];
                    add(name, (named ?? job).slice(0, 16), target, r.seq, r.created);
                }
            }
        }
        return out;
    } finally {
        kernel.close();
        store?.close();
    }
}

/** One span of the daemon's clock: from `start` on it reads the real clock plus `offset`. */
interface ClockSpan {
    /** The daemon's time at which the span begins. */
    start: number;
    wall: number;
    scenario: number;
    offset: number;
}

/**
 * The daemon's clock of one arm, from the journal's `ClockOffset` entries: the daemon reads the
 * real clock plus the offset in effect. `real` gives the wall time of a daemon time, `daemon`
 * the daemon's reading at a wall time, and `scenario` the scenario time of a daemon time (null
 * before the first entry when the manifest names no base).
 */
export function daemonClock(entries: readonly Entry[], arm: string, baseWallMs: number | null) {
    const spanList: ClockSpan[] = entries
        .filter((e) => e.kind === "ClockOffset" && (e.arm === arm || e.arm === null))
        .map((e) => {
            const offset = (Number(e.offset_s) || 0) * 1000;
            return { start: e.wall_ms + offset, wall: e.wall_ms, scenario: e.scenario_ms, offset };
        })
        .sort((a, b) => a.start - b.start);
    const at = (daemonMs: number) => spanList.filter((s) => s.start <= daemonMs).at(-1);
    return {
        real: (daemonMs: number): number => daemonMs - (at(daemonMs)?.offset ?? 0),
        daemon: (wallMs: number): number =>
            wallMs +
            ([...spanList]
                .sort((a, b) => a.wall - b.wall)
                .filter((s) => s.wall <= wallMs)
                .at(-1)?.offset ?? 0),
        scenario: (daemonMs: number): number | null => {
            const span = at(daemonMs);
            if (span) return span.scenario + (daemonMs - span.offset - span.wall);
            return baseWallMs === null ? null : daemonMs - baseWallMs;
        },
    };
}
export type DaemonClock = ReturnType<typeof daemonClock>;
