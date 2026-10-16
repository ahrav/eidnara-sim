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
                "select session_id, sequence, start_message, end_message from history_segments order by session_id, start_message, end_message, sequence",
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
