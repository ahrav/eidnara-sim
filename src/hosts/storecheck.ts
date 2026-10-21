import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/** The check format whose ranges carry content digests; checks recorded before it have no format. */
export const DIGEST_FORMAT = 2;

export interface StoreCheck {
    /** The check's format; `DIGEST_FORMAT` once ranges carry digests, absent on earlier checks. */
    format?: number;
    /** SQLite's `integrity_check` result, followed by any segment whose own bounds are inverted. */
    integrity: string;
    segments: number;
    overlaps: { session: string; first: number; second: number }[];
    /**
     * Each segment as `[session, sequence, start_message, end_message, digest]`, the digest over
     * its message ids, title, and content, so a segment rewritten within the same bounds reads
     * as changed.
     */
    ranges: [string, number, number, number, string][];
}

interface Segment {
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
}

/** Each field length-prefixed, so fields holding any byte, NUL included, hash unambiguously. */
function digest(g: Segment): string {
    const hash = createHash("sha256");
    for (const part of [g.start_message_id, g.end_message_id, g.title, g.content]) {
        hash.update(`${Buffer.byteLength(part)}:`).update(part);
    }
    return hash.digest("hex").slice(0, 16);
}

/** A segment coordinate as the store holds it: a non-negative safe integer. */
const isCoordinate = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The digest `inspect` emits: the first sixteen hex characters of a SHA-256. */
const DIGEST = /^[0-9a-f]{16}$/;

const isRange = (r: unknown): r is StoreCheck["ranges"][number] =>
    Array.isArray(r) &&
    (r.length === 4 || r.length === 5) &&
    typeof r[0] === "string" &&
    isCoordinate(r[1]) &&
    isCoordinate(r[2]) &&
    isCoordinate(r[3]) &&
    (r.length === 4 || (typeof r[4] === "string" && DIGEST.test(r[4])));

const isOverlap = (o: unknown): o is StoreCheck["overlaps"][number] =>
    typeof o === "object" &&
    o !== null &&
    typeof (o as { session: unknown }).session === "string" &&
    isCoordinate((o as { first: unknown }).first) &&
    isCoordinate((o as { second: unknown }).second);

type Bounds = Pick<Segment, "session_id" | "sequence" | "start_message" | "end_message">;

/**
 * The facts a check derives from its ranges, in range order: segments of one session whose
 * message ranges overlap, and segments whose own bounds are inverted.
 */
function derive(ranges: Iterable<Bounds>): {
    overlaps: StoreCheck["overlaps"];
    inverted: string[];
} {
    const overlaps: StoreCheck["overlaps"] = [];
    const inverted: string[] = [];
    type Reach = Pick<Segment, "session_id" | "sequence" | "end_message">;
    let reach = null as Reach | null;
    for (const next of ranges) {
        // The schema has no constraint on the bounds, so an inverted range passes the pragma.
        if (next.start_message > next.end_message) {
            inverted.push(`inverted range ${next.session_id}/${next.sequence}`);
        }
        const same: Reach | null = reach?.session_id === next.session_id ? reach : null;
        if (same && next.start_message <= same.end_message) {
            overlaps.push({
                session: next.session_id,
                first: same.sequence,
                second: next.sequence,
            });
        }
        reach =
            same && same.end_message >= next.end_message
                ? same
                : {
                      session_id: next.session_id,
                      sequence: next.sequence,
                      end_message: next.end_message,
                  };
    }
    return { overlaps, inverted };
}

/**
 * A recorded store check, read back with its shape checked and its derived facts recomputed from
 * its ranges, so a malformed or inconsistent artifact refuses the run rather than certifying it.
 * Ranges recorded before digests have four elements.
 */
export function parseStoreCheck(value: unknown, where: string): StoreCheck {
    const v = value as Partial<Record<keyof StoreCheck, unknown>> | null;
    const sound =
        typeof v === "object" &&
        v !== null &&
        typeof v.integrity === "string" &&
        Array.isArray(v.overlaps) &&
        v.overlaps.every(isOverlap) &&
        Array.isArray(v.ranges) &&
        v.ranges.every(isRange) &&
        Number.isInteger(v.segments) &&
        v.segments === v.ranges.length &&
        (v.format === undefined || v.format === DIGEST_FORMAT);
    if (!sound) throw new Error(`${where}: store check has an unexpected shape`);
    const check = v as StoreCheck;
    // A check's format states what its ranges carry: digests on every range in the digest
    // format, bounds alone before it.
    const digested = check.ranges.filter((r) => r.length === 5).length;
    const expected = check.format === DIGEST_FORMAT ? check.ranges.length : 0;
    if (digested !== expected) {
        throw new Error(`${where}: store check's ranges disagree with its format`);
    }
    // Derived in the live check's order, whatever order the artifact lists its ranges in.
    const bounds = check.ranges
        .map(([session_id, sequence, start_message, end_message]) => ({
            session_id,
            sequence,
            start_message,
            end_message,
        }))
        .sort(
            (a, b) =>
                // SQLite's BINARY collation: byte order, which places "Z" before "a".
                Buffer.compare(Buffer.from(a.session_id), Buffer.from(b.session_id)) ||
                a.start_message - b.start_message ||
                a.end_message - b.end_message ||
                a.sequence - b.sequence,
        );
    // The store keys segments by (session, sequence); a check that lists one twice is malformed.
    const identities = new Set(bounds.map((b) => `${b.session_id}\0${b.sequence}`));
    if (identities.size !== bounds.length) {
        throw new Error(`${where}: store check lists a segment identity twice`);
    }
    // The integrity text opens with the pragma's non-empty result and lists exactly the
    // inverted ranges the recorded ranges derive.
    const derived = derive(bounds);
    const parts = check.integrity.split("; ");
    const claimed = parts.filter((part) => part.startsWith("inverted range "));
    const agrees =
        (parts[0] ?? "") !== "" &&
        !(parts[0] as string).startsWith("inverted range ") &&
        JSON.stringify(derived.overlaps) === JSON.stringify(check.overlaps) &&
        JSON.stringify(claimed) === JSON.stringify(derived.inverted);
    if (!agrees) throw new Error(`${where}: store check disagrees with its own ranges`);
    return check;
}

export function checkStore(path: string): StoreCheck {
    const empty = { format: DIGEST_FORMAT, segments: 0, overlaps: [], ranges: [] };
    if (!existsSync(path)) return { ...empty, integrity: "missing" };
    try {
        return inspect(path);
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return { ...empty, integrity: `error: ${message}` };
    }
}

function inspect(path: string): StoreCheck {
    const db = new Database(path, { readonly: true });
    try {
        const pragma = db.query("pragma integrity_check").all() as { integrity_check: string }[];
        const checks = pragma.map((r) => r.integrity_check);
        // Rows stream one at a time: the digest is taken and the text dropped before the next row.
        const rows = db
            .query<Segment, []>(
                "select session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content from history_segments order by session_id, start_message, end_message, sequence",
            )
            .iterate();
        const ranges: StoreCheck["ranges"] = [];
        const bounds: Bounds[] = [];
        const malformed: string[] = [];
        for (const next of rows) {
            // A row whose coordinates are not counts is an integrity failure the check reports
            // and leaves out of its ranges, so the check stays readable.
            if (![next.sequence, next.start_message, next.end_message].every(isCoordinate)) {
                malformed.push(
                    `segment ${next.session_id}/${next.sequence} has a coordinate that is not a count`,
                );
                continue;
            }
            bounds.push({
                session_id: next.session_id,
                sequence: next.sequence,
                start_message: next.start_message,
                end_message: next.end_message,
            });
            ranges.push([
                next.session_id,
                next.sequence,
                next.start_message,
                next.end_message,
                digest(next),
            ]);
        }
        const { overlaps, inverted } = derive(bounds);
        checks.push(...inverted, ...malformed);
        return {
            format: DIGEST_FORMAT,
            integrity: checks.join("; "),
            segments: ranges.length,
            overlaps,
            ranges,
        };
    } finally {
        db.close();
    }
}

export interface MemoryNote {
    id: number;
    content: string;
    status: string;
    deliveries: number;
    first_delivery_ms: number | null;
}

/** Object counts by kind in a Kernel registry; null when the file is absent or unreadable. */
export function kernelObjects(path: string): Record<string, number> | null {
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
        const rows = db
            .query(
                "select object_kind as kind, count(*) as n from object_registry group by object_kind",
            )
            .all() as { kind: string; n: number }[];
        return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    } catch {
        return null;
    } finally {
        db.close();
    }
}

export function memoryNotes(path: string): MemoryNote[] | null {
    if (!existsSync(path)) return null;
    let db: Database | null = null;
    try {
        db = new Database(path, { readonly: true });
        return db
            .query(
                "select n.id, n.content, n.status, (select count(*) from note_deliveries d where d.note_id = n.id) as deliveries, (select min(d.created_at_ms) from note_deliveries d where d.note_id = n.id) as first_delivery_ms from notes n order by n.id",
            )
            .all() as MemoryNote[];
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

export interface Deletion {
    deleted: number[];
    remaining: number;
}

const words = (text: string) => text.toLowerCase().match(/[\w[\]-]+/g) ?? [];
const unbracket = (t: string) => t.replace(/[[\]]/g, "");
const runsOf = (text: string, size: number) => {
    const w = words(text).map(unbracket);
    return new Set(
        w.slice(0, Math.max(0, w.length - size + 1)).map((_, i) => w.slice(i, i + size).join(" ")),
    );
};

/**
 * Notes carry a fact when they share a run of `size` words with its statement that no other
 * fact's statement holds, or name one of its distinctive values (a bracketed token, or one of
 * four or more characters with a digit or underscore, that no other statement holds) as a
 * whole word.
 */
export function factMatcher(statement: string, others: readonly string[], size: number) {
    const shared = new Set(others.flatMap((o) => [...runsOf(o, size)]));
    const sharedWords = new Set(others.flatMap(words).map(unbracket));
    const runs = [...runsOf(statement, size)].filter((r) => !shared.has(r));
    const values = words(statement)
        .filter((t) => /^\[.+\]$/.test(t) || (t.length >= 4 && /[\d_]/.test(t)))
        .map(unbracket)
        .filter((t) => !sharedWords.has(t));
    return (content: string) => {
        const tokens = new Set(words(content).map(unbracket));
        const own = runsOf(content, size);
        return runs.some((r) => own.has(r)) || values.some((v) => tokens.has(v));
    };
}

const DELETE = `
import json, sqlite3, sys
db, ids = sys.argv[1], json.loads(sys.argv[2])
scope = {"project": None}
c = sqlite3.connect(db, timeout=10)
c.create_function("note_caller_project", 0, lambda: scope["project"])
c.create_function("facade_authority_domain", 0, lambda: "")
c.create_function("facade_authority_route", 0, lambda: "")
tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
with c:
    for i in ids:
        row = c.execute("select project_path from notes where id = ?", (i,)).fetchone()
        if row is None:
            continue
        scope["project"] = row[0]
        for t in ("note_deliveries", "note_eval_claims"):
            if t in tables:
                c.execute(f"delete from {t} where note_id = ?", (i,))
        c.execute("delete from notes where id = ?", (i,))
`;

const readNotes = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
        return db.query("select id, content from notes").all() as { id: number; content: string }[];
    } finally {
        db.close();
    }
};

/**
 * Deletes the notes that carry a ledger fact from a live store, through a connection that
 * supplies the store's caller-scope functions so its ownership triggers admit the delete, then
 * reads back how many notes still match the fact by three-word runs or values.
 */
export interface DeletionPlan {
    planned?: number[];
    onPlanned?: (ids: number[]) => void;
}

export async function deleteFactNotes(
    path: string,
    statement: string,
    others: readonly string[] = [],
    onSpawn: (child: ReturnType<typeof Bun.spawn>) => void = () => undefined,
    within?: string,
    plan: DeletionPlan = {},
): Promise<Deletion> {
    if (lstatSync(path).isSymbolicLink()) {
        throw new Error(`${path} is a symlink; the deletion opens only the arm's own store file`);
    }
    if (
        within !== undefined &&
        realpathSync(path) !== join(realpathSync(within), relative(within, path))
    ) {
        throw new Error(
            `${path} resolves outside ${within}; the deletion opens only the arm's own store file`,
        );
    }
    const carries = factMatcher(statement, others, 4);
    const ids =
        plan.planned ??
        readNotes(path)
            .filter((n) => carries(n.content))
            .map((n) => n.id);
    if (plan.planned === undefined) plan.onPlanned?.(ids);
    if (ids.length > 0) {
        const p = Bun.spawn(["python3", "-c", DELETE, path, JSON.stringify(ids)], {
            stderr: "pipe",
        });
        onSpawn(p);
        if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
    }
    const verify = factMatcher(statement, others, 3);
    return { deleted: ids, remaining: readNotes(path).filter((n) => verify(n.content)).length };
}
