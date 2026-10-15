import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Every field path in a value, with array items folded to `[]`. */
function fieldPaths(value: unknown, path = ""): string[] {
    if (Array.isArray(value)) {
        const objects = value.filter((v) => typeof v === "object" && v !== null);
        return [...new Set(objects.flatMap((v) => fieldPaths(v, `${path}[]`)))];
    }
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => {
        const at = path === "" ? key : `${path}.${key}`;
        return [at, ...fieldPaths(child, at)];
    });
}

test("the mapping document has a row for every pre-registration field", () => {
    const doc = readFileSync(join(ROOT, "docs/eval-core-mapping.md"), "utf8");
    const rows = new Set([...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
    const fields = new Set(
        ["S", "M", "L", "XL"].flatMap((tier) =>
            fieldPaths(JSON.parse(readFileSync(join(ROOT, `prereg/${tier}.json`), "utf8"))),
        ),
    );
    expect([...fields].filter((f) => !rows.has(f))).toEqual([]);
    expect([...rows].filter((r) => !fields.has(r as string))).toEqual([]);
});

test("the claim boundary names the four exclusions", () => {
    const doc = readFileSync(join(ROOT, "docs/claim-boundary.md"), "utf8");
    for (const exclusion of [
        "Provider-side wall-clock effects",
        "Live-model nondeterminism as a controlled factor",
        "Scheduler-order independence",
        "Hosts other than Pi and OpenCode",
    ]) {
        expect(doc).toContain(exclusion);
    }
});
