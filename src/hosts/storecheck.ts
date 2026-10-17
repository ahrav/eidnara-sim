import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface StoreCheck {
    integrity: string;
    segments: number;
    overlaps: { session: string; first: number; second: number }[];
    /** Each segment as `[session, sequence, start_message, end_message]`. */
    ranges: [string, number, number, number][];
}

interface Segment {
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
}

export function checkStore(path: string): StoreCheck {
    if (!existsSync(path)) return { integrity: "missing", segments: 0, overlaps: [], ranges: [] };
    try {
        return inspect(path);
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return { integrity: `error: ${message}`, segments: 0, overlaps: [], ranges: [] };
    }
}

function inspect(path: string): StoreCheck {
    const db = new Database(path, { readonly: true });
    try {
        const rows = db.query("pragma integrity_check").all() as { integrity_check: string }[];
        const integrity = rows.map((r) => r.integrity_check).join("; ");
        const segments = db
            .query(
                "select session_id, sequence, start_message, end_message from history_segments order by session_id, start_message",
            )
            .all() as Segment[];
        const overlaps: StoreCheck["overlaps"] = [];
        let reach: Segment | null = null;
        for (const next of segments) {
            if (reach?.session_id !== next.session_id) reach = null;
            if (reach && next.start_message <= reach.end_message) {
                overlaps.push({
                    session: next.session_id,
                    first: reach.sequence,
                    second: next.sequence,
                });
            }
            if (!reach || next.end_message > reach.end_message) reach = next;
        }
        const ranges = segments.map((g): StoreCheck["ranges"][number] => [
            g.session_id,
            g.sequence,
            g.start_message,
            g.end_message,
        ]);
        return { integrity, segments: segments.length, overlaps, ranges };
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

export function memoryNotes(path: string): MemoryNote[] | null {
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true });
    try {
        return db
            .query(
                "select n.id, n.content, n.status, (select count(*) from note_deliveries d where d.note_id = n.id) as deliveries, (select min(d.created_at_ms) from note_deliveries d where d.note_id = n.id) as first_delivery_ms from notes n order by n.id",
            )
            .all() as MemoryNote[];
    } catch {
        return null;
    } finally {
        db.close();
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
const literal = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
        .filter((t) => !sharedWords.has(t))
        .map((t) => new RegExp(`(^|[^\\w-])${literal(t)}($|[^\\w-])`));
    return (content: string) => {
        const text = unbracket(content.toLowerCase());
        const own = runsOf(content, size);
        return runs.some((r) => own.has(r)) || values.some((v) => v.test(text));
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
export async function deleteFactNotes(
    path: string,
    statement: string,
    others: readonly string[] = [],
): Promise<Deletion> {
    const carries = factMatcher(statement, others, 4);
    const ids = readNotes(path)
        .filter((n) => carries(n.content))
        .map((n) => n.id);
    if (ids.length > 0) {
        const p = Bun.spawn(["python3", "-c", DELETE, path, JSON.stringify(ids)], {
            stderr: "pipe",
        });
        if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
    }
    const verify = factMatcher(statement, others, 3);
    return { deleted: ids, remaining: readNotes(path).filter((n) => verify(n.content)).length };
}
