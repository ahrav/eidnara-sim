/** Licenses a corpus entry may carry; each permits redistribution with attribution. */
const ALLOWED_LICENSES = new Set(["CC-BY-4.0", "ODC-BY-1.0", "MIT", "Apache-2.0"]);

export function entryProblems(entries: readonly unknown[], label: string): string[] {
    const problems: string[] = [];
    entries.forEach((entry, i) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const where = `${label}[${i}]${typeof e.id === "string" ? ` (${e.id})` : ""}`;
        if (typeof e.license !== "string" || !ALLOWED_LICENSES.has(e.license)) {
            problems.push(`${where}: license missing or not permitted`);
        }
        if (typeof e.source_id !== "string" || e.source_id.trim() === "") {
            problems.push(`${where}: source_id missing`);
        }
    });
    return problems;
}

export function parseJsonl(text: string): unknown[] {
    return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
