import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface StoreCheck {
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
        const pragma = db.query("pragma integrity_check").all() as { integrity_check: string }[];
        const checks = pragma.map((r) => r.integrity_check);
        // Rows stream one at a time: the digest is taken and the text dropped before the next row.
        const rows = db
            .query<Segment, []>(
                "select session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content from history_segments order by session_id, start_message, end_message, sequence",
            )
            .iterate();
        const overlaps: StoreCheck["overlaps"] = [];
        const ranges: StoreCheck["ranges"] = [];
        type Reach = Pick<Segment, "session_id" | "sequence" | "end_message">;
        let reach = null as Reach | null;
        for (const next of rows) {
            // The schema has no constraint on the bounds, so an inverted range passes the pragma.
            if (next.start_message > next.end_message) {
                checks.push(`inverted range ${next.session_id}/${next.sequence}`);
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
            ranges.push([
                next.session_id,
                next.sequence,
                next.start_message,
                next.end_message,
                digest(next),
            ]);
        }
        return { integrity: checks.join("; "), segments: ranges.length, overlaps, ranges };
    } finally {
        db.close();
    }
}
