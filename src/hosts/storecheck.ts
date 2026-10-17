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

/** A segment coordinate as the store holds it: a non-negative safe integer. */
const isCoordinate = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const isRange = (r: unknown): r is StoreCheck["ranges"][number] =>
    Array.isArray(r) &&
    (r.length === 4 || r.length === 5) &&
    typeof r[0] === "string" &&
    isCoordinate(r[1]) &&
    isCoordinate(r[2]) &&
    isCoordinate(r[3]) &&
    (r.length === 4 || typeof r[4] === "string");

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
        v.segments === v.ranges.length;
    if (!sound) throw new Error(`${where}: store check has an unexpected shape`);
    const check = v as StoreCheck;
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
                a.session_id.localeCompare(b.session_id) ||
                a.start_message - b.start_message ||
                a.end_message - b.end_message ||
                a.sequence - b.sequence,
        );
    const derived = derive(bounds);
    const agrees =
        JSON.stringify(derived.overlaps) === JSON.stringify(check.overlaps) &&
        derived.inverted.every((note) => check.integrity.split("; ").includes(note));
    if (!agrees) throw new Error(`${where}: store check disagrees with its own ranges`);
    return check;
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
        const ranges: StoreCheck["ranges"] = [];
        const bounds: Bounds[] = [];
        for (const next of rows) {
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
        checks.push(...inverted);
        return { integrity: checks.join("; "), segments: ranges.length, overlaps, ranges };
    } finally {
        db.close();
    }
}
