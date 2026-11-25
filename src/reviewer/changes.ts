import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { isSqliteError } from "../evidence/load";
import type { Entry } from "../run/journal";

/** The producers of the memory reviewer's receipts in the Kernel store. */
export const PRODUCER_DISPUTE = "eidnara-daemon/memory-reviewer-contest";
export const PRODUCER_CONTEST = "eidnara-daemon/memory-reviewer-later-statement";
export const PRODUCER_SETTLEMENT = "eidnara-kernel/memory-reviewer-settlement";

export type ChangeKind = "disputed" | "contested" | "retired" | "revised" | "created";
export type TargetKind = "user statement" | "work in progress" | "assistant report" | "agent note";

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
    /**
     * The visibility of the statement by its last admission decision before the change, and by
     * the change's own: the target's for a dispute or a retirement, the marked row's for a
     * contest mark, and the successor row's for a revision, each of which supersedes its target.
     */
    delivery: { before: string | null; after: string | null };
    /** The project the review job ran in: the last segment of its workspace path. */
    project: string | null;
    /** The proposal the change applied: its action, the text a revision gives, and the passages cited against the memory. */
    proposal: { action: string; new_text: string | null; contradictions: CitedSpan[] } | null;
    /** A contested mark's later statement: the memory the mark names, with its text. */
    contested_by: { memory: string; text: string } | null;
    /**
     * The job's last model attempt, which made the applied proposal: when the daemon committed it
     * and when it ended, on the daemon's clock. The stage-2 request of the change lies inside it.
     */
    attempt: { committed_ms: number; terminal_ms: number } | null;
}

/** Whether a change took its statement out of automatic delivery, by the store's admission decisions. */
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
function rowOf(payload: string | null | undefined): { summary: string; rationale: Obj } {
    const p = parsed(payload ?? "");
    if (!isObj(p)) return { summary: "", rationale: {} };
    const raw = p.rationale;
    const rationale = typeof raw === "string" && raw.startsWith("{") ? parsed(raw) : null;
    return {
        summary: typeof p.summary === "string" ? p.summary : "",
        rationale: isObj(rationale) ? rationale : {},
    };
}

/** The database at `path` opened for reading; null when nothing stands there, and refused when a link or another kind of entry does. */
function openReadonly(path: string): Database | null {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return null;
    if (!entry.isFile()) throw new Error(`${path} is no regular file`);
    return new Database(path, { readonly: true });
}

/**
 * The rows of one query. A store from before a table or column existed reads as holding no such
 * rows; any other SQLite error (a file that is no database, a damaged page) is thrown, so damaged
 * evidence never reads as a reviewer that wrote nothing.
 */
function rows<T>(db: Database, sql: string, ...args: (string | number)[]): T[] {
    try {
        return db.query(sql).all(...args) as T[];
    } catch (caught) {
        if (isSqliteError(caught) && /no such (?:table|column)/.test((caught as Error).message)) {
            return [];
        }
        throw caught;
    }
}

/** The kind of a target row by its writer: the creating commit's producer, the text, and the rationale. */
function targetKind(
    text: string,
    rationale: Obj,
    producer: string | undefined,
    statement: boolean,
): TargetKind {
    if (producer === "plugin") return "agent note";
    if (text.startsWith("Assistant reported")) return "assistant report";
    if (rationale.lifetime === "current_work") return "work in progress";
    if (statement || rationale.speaker === "user") return "user statement";
    return "assistant report";
}

const spans = (list: unknown): CitedSpan[] =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
        const span = isObj(entry) ? entry.span : null;
        if (!isObj(span) || typeof span.alias !== "string") return [];
        const at = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : null);
        return [{ alias: span.alias, start: at(span.start), end: at(span.end) }];
    });

interface Receipt {
    producer: string;
    key: string;
    seq: number | null;
    result: string | null;
}
interface Decision {
    id: string;
    payload: string | null;
    created: number;
    invalidated: number | null;
    superseded: string | null;
}
interface Commit {
    seq: number;
    at: number;
    key: string;
    producer: string;
}
/** A written change as its receipt names it, before the target row and the proposal are read. */
interface Written {
    kind: ChangeKind;
    /** The job's causal identity, whole or its opening hex digits. */
    identity: string;
    target: string;
    seq: number;
    /** The commit's time on the daemon's clock. */
    at: number;
    /**
     * The row whose admission the change's commit made, when it is another row than the target:
     * the marked row of a contest mark, the successor row of a revision.
     */
    successor?: string;
}

/**
 * The changes the reviewer's receipts name, in receipt order. A dispute names its target through
 * the `mark_disputed` admission decision of its commit, and a dispute whose commit holds none is
 * damaged evidence and refuses the read. A later-statement receipt whose result is
 * a row id is a contested mark: its target is the statement that commit superseded by the result
 * row (a mark whose commit superseded no row is damaged evidence and refuses the read), and an
 * empty result is a statement left standing. A settlement's result names the target
 * and the effect; `retired`, `revised` and `created` are changes, a created row is named by the
 * effect, and the job is the one whose receipt selected the settled proposal. A receipt names a
 * commit of the log; one that names another is damaged evidence and refuses the read.
 */
function writtenChanges(
    receipts: readonly Receipt[],
    decisions: ReadonlyMap<string, Decision>,
    commits: ReadonlyMap<number, Commit>,
    disputed: ReadonlyMap<number, string>,
    identityOf: (proposal: string) => string | undefined,
): Written[] {
    const out: Written[] = [];
    for (const r of receipts) {
        const made = r.seq === null ? undefined : commits.get(r.seq);
        if (!made) {
            throw new Error(
                `a reviewer receipt names commit ${String(r.seq)}, which the log lacks`,
            );
        }
        const { seq, at } = made;
        const keyed = r.key.split("#").at(-1) ?? "";
        const result =
            r.result === null || r.result === '""' || r.result === "null" ? "" : r.result;
        if (r.producer === PRODUCER_DISPUTE) {
            const target = disputed.get(seq);
            if (!target) {
                throw new Error(`the dispute of commit ${seq} marks no stored row`);
            }
            out.push({ kind: "disputed", identity: keyed, target, seq, at });
        } else if (r.producer === PRODUCER_CONTEST) {
            if (result === "") continue;
            const superseded = [...decisions.values()].find(
                (d) => d.invalidated === seq && d.superseded === result,
            );
            if (!superseded) {
                throw new Error(`the contest mark of commit ${seq} supersedes no stored row`);
            }
            out.push({
                kind: "contested",
                identity: keyed,
                target: superseded.id,
                seq,
                at,
                successor: result,
            });
        } else {
            const settled = parsed(result);
            if (!isObj(settled)) continue;
            const effect = isObj(settled.effect) ? settled.effect : {};
            const name = String(effect.kind ?? settled.effect).toLowerCase();
            if (name !== "retired" && name !== "revised" && name !== "created") continue;
            const named = isObj(settled.target) ? settled.target.object_id : undefined;
            const target = typeof named === "string" ? named : effect.object_id;
            if (typeof target !== "string") continue;
            const proposal = typeof settled.proposal_id === "string" ? settled.proposal_id : "";
            const identity = identityOf(proposal) ?? made.key.split("#")[1] ?? keyed;
            const successor = name === "revised" ? effect.object_id : undefined;
            out.push({
                kind: name,
                identity,
                target,
                seq,
                at,
                ...(typeof successor === "string" ? { successor } : {}),
            });
        }
    }
    return out;
}

/**
 * The reviewer's written changes in the final store under `storeDir`, in receipt order; null when
 * no Kernel store stands there. Each change carries its target row, the row's writer kind, its
 * delivery before and after the change, and the proposal the change applied: the selected
 * candidate of the job's receipt in `store.db`.
 */
export function readChanges(storeDir: string): ReviewerChange[] | null {
    const kernel = openReadonly(join(storeDir, "kernel.sqlite"));
    if (!kernel) return null;
    let store: Database | null = null;
    try {
        store = openReadonly(join(storeDir, "store.db"));
        const daemon = store;
        const receipts = rows<Receipt>(
            kernel,
            `select producer, operation_key as key, commit_seq as seq,
                cast(result_payload as text) as result
             from operation_receipts where producer in (?, ?, ?) order by commit_seq, created_at`,
            PRODUCER_DISPUTE,
            PRODUCER_CONTEST,
            PRODUCER_SETTLEMENT,
        );
        const decisions = new Map(
            rows<Decision>(
                kernel,
                `select object_id as id, cast(decision_payload as text) as payload,
                    created_commit_seq as created, invalidated_commit_seq as invalidated,
                    superseded_by as superseded from decisions`,
            ).map((d) => [d.id, d]),
        );
        const commits = new Map(
            rows<Commit>(
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
            if (id.startsWith("stm_")) statements.add(rowOf(d.payload).rationale.memory);
        }
        const identityOf = (proposal: string) =>
            daemon && proposal !== ""
                ? rows<{ identity: string }>(
                      daemon,
                      `select causal_identity as identity from memory_reviewer_receipts
                       where selected_candidate_id = ?`,
                      proposal,
                  )[0]?.identity
                : undefined;
        const visibility = (id: string) =>
            rows<{ seq: number; visibility: string }>(
                kernel,
                `select commit_seq as seq, visibility from admission_decisions
                 where subject_object_id = ? order by commit_seq, decided_at, admission_decision_id`,
                id,
            );
        return writtenChanges(receipts, decisions, commits, disputed, identityOf).map((w) => {
            const job = w.identity.slice(0, 16);
            const decision = decisions.get(w.target);
            const { summary, rationale } = rowOf(decision?.payload);
            const created = decision ? commits.get(decision.created) : undefined;
            const statement = summary.startsWith("User stated") || statements.has(w.target);
            const before = visibility(w.target).filter((a) => a.seq < w.seq);
            const after = visibility(w.successor ?? w.target).filter((a) => a.seq === w.seq);
            const receipt = daemon
                ? rows<{ candidate: string | null; project: string | null }>(
                      daemon,
                      `select r.selected_candidate_id as candidate, j.project as project
                       from memory_reviewer_receipts r
                       left join memory_reviewer_jobs j on j.causal_identity = r.causal_identity
                       where substr(r.causal_identity, 1, 16) = ?`,
                      job,
                  )[0]
                : undefined;
            const attempt = daemon
                ? rows<{ committed: number; terminal: number | null }>(
                      daemon,
                      `select committed_at_ms as committed, terminal_at_ms as terminal
                       from memory_reviewer_attempts where substr(causal_identity, 1, 16) = ?
                       order by generation desc, attempt_index desc limit 1`,
                      job,
                  )[0]
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
            const by =
                w.kind === "contested" && w.successor
                    ? rowOf(decisions.get(w.successor)?.payload).rationale.contested_by
                    : null;
            const later = isObj(by) && typeof by.memory === "string" ? by.memory : null;
            return {
                kind: w.kind,
                job,
                target: w.target,
                text: summary,
                target_kind: targetKind(summary, rationale, created?.producer, statement),
                user_statement: statement,
                commit_seq: w.seq,
                recorded_ms: w.at,
                stored_ms: created?.at ?? null,
                delivery: {
                    before: before.at(-1)?.visibility ?? null,
                    after: after.at(-1)?.visibility ?? null,
                },
                project: receipt?.project ? basename(receipt.project) : null,
                proposal:
                    body && typeof body.action === "string"
                        ? {
                              action: body.action,
                              new_text: typeof body.new_text === "string" ? body.new_text : null,
                              contradictions: spans(body.contradictions),
                          }
                        : null,
                contested_by: later
                    ? { memory: later, text: rowOf(decisions.get(later)?.payload).summary }
                    : null,
                attempt:
                    attempt && attempt.terminal !== null
                        ? { committed_ms: attempt.committed, terminal_ms: attempt.terminal }
                        : null,
            };
        });
    } finally {
        kernel.close();
        store?.close();
    }
}

/** One offset of an arm's clock: from wall time `wall` on the daemon reads the wall clock plus `offset`. */
interface ClockSpan {
    wall: number;
    offset: number;
    scenario: number;
    /** The daemon's reading at the journal entry that recorded the offset. */
    start: number;
}

/**
 * The daemon's clock of one arm, from the journal's `ClockOffset` entries: the daemon reads the
 * wall clock plus the offset in effect.
 *
 * `wall` takes a daemon time back to wall time through the offset in effect when it was read. An
 * offset smaller than the one before it (a resume, or a jump shorter than the idle time before
 * it) steps the daemon's clock back, so two offsets can claim one daemon time; `wall` is null for
 * such a time and for one no offset claims. `daemon` gives the daemon's reading at a wall time.
 * `scenario` is the registered R1 reader's scenario time of a daemon time: the last offset whose
 * first daemon reading is at or before it, or the manifest's base without one.
 */
export function daemonClock(entries: readonly Entry[], arm: string, baseWallMs: number | null) {
    const list: ClockSpan[] = entries
        .filter((e) => e.kind === "ClockOffset" && e.arm === arm)
        .map((e) => {
            const offset = (Number(e.offset_s) || 0) * 1000;
            const set = e.offset_wall_ms;
            return {
                wall: typeof set === "number" && Number.isFinite(set) ? set : e.wall_ms,
                offset,
                scenario: e.scenario_ms,
                start: e.wall_ms + offset,
            };
        })
        .sort((a, b) => a.wall - b.wall);
    const byStart = [...list].sort((a, b) => a.start - b.start);
    return {
        wall: (daemonMs: number): number | null => {
            const walls = new Set(
                list.flatMap((span, i) => {
                    const wall = daemonMs - span.offset;
                    const until = list[i + 1]?.wall ?? Number.POSITIVE_INFINITY;
                    return wall >= span.wall && wall < until ? [wall] : [];
                }),
            );
            if (list.length === 0) return daemonMs;
            return walls.size === 1 ? ([...walls][0] as number) : null;
        },
        daemon: (wallMs: number): number =>
            wallMs + (list.filter((s) => s.wall <= wallMs).at(-1)?.offset ?? 0),
        scenario: (daemonMs: number): number | null => {
            const span = byStart.filter((s) => s.start <= daemonMs).at(-1);
            if (span) return span.scenario + (daemonMs - span.start);
            return baseWallMs === null ? null : daemonMs - baseWallMs;
        },
    };
}
export type DaemonClock = ReturnType<typeof daemonClock>;
