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

const runsOf = (text: string, size = 4) => {
    const words = text.toLowerCase().match(/[\w[\]-]+/g) ?? [];
    return new Set(
        words
            .slice(0, Math.max(0, words.length - size + 1))
            .map((_, i) => words.slice(i, i + size).join(" ")),
    );
};

/**
 * Deletes the memory notes that carry a ledger fact from a live store, and reads back how many
 * matching notes remain. A note carries the fact when it shares a four-word run with the fact's
 * statement or holds one of its distinctive values (a token with a digit, an underscore, or a
 * bracket, such as a codename).
 */
export function deleteFactNotes(path: string, statement: string): Deletion {
    const db = new Database(path);
    try {
        db.run("pragma busy_timeout = 10000");
        const fact = runsOf(statement);
        const values = (statement.toLowerCase().match(/[\w[\]-]+/g) ?? []).filter(
            (t) => t.length >= 4 && /[\d_[\]]/.test(t),
        );
        const carries = (content: string) =>
            [...runsOf(content)].some((r) => fact.has(r)) ||
            values.some((v) => content.toLowerCase().includes(v));
        const notes = db.query("select id, content from notes").all() as {
            id: number;
            content: string;
        }[];
        const hits = notes.filter((n) => carries(n.content));
        const ids = hits.map((n) => n.id);
        db.transaction(() => {
            for (const id of ids) {
                db.run("delete from note_deliveries where note_id = ?", [id]);
                db.run("delete from notes where id = ?", [id]);
            }
        })();
        const left = db.query("select id, content from notes").all() as typeof notes;
        const remaining = left.filter((n) => carries(n.content)).length;
        return { deleted: ids, remaining };
    } finally {
        db.close();
    }
}
