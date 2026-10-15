import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth, so equal values serialize to equal bytes. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : v,
    );
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

export function isCanonicalDecimal(value: unknown): value is string {
    return typeof value === "string" && CANONICAL_DECIMAL.test(value);
}
