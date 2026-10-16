import { isPlainRelativePath } from "./sources";

/** Licenses a corpus entry may carry; each permits redistribution with attribution. */
const ALLOWED_LICENSES = new Set(["CC-BY-4.0", "ODC-BY-1.0", "MIT", "Apache-2.0"]);

type FieldType = "string" | "number" | "boolean" | "number|null";

const COMMON: Record<string, FieldType> = { id: "string", repo: "string", source_id: "string" };
/** `<repo>@<revision>:<trajectory>#<message index>` names the exact source message. */
const SOURCE_ID = /^[^@\s]+@[0-9a-f]{40}:[^#\s]+#\d+$/;

export const SAMPLE_FIELDS: Record<string, FieldType> = {
    ...COMMON,
    kind: "string",
    tool: "string",
    command: "string",
    exit_code: "number|null",
    chars: "number",
    truncated: "boolean",
    content: "string",
};
export const ERROR_CODE_FIELDS: Record<string, FieldType> = {
    ...COMMON,
    code: "string",
    message: "string",
    context: "string",
};

function hasType(value: unknown, type: FieldType): boolean {
    if (type === "number|null") return value === null || typeof value === "number";
    return typeof value === type;
}

export function entryProblems(
    entries: readonly unknown[],
    label: string,
    fields: Record<string, FieldType>,
): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    entries.forEach((entry, i) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const where = `${label}[${i}]${typeof e.id === "string" ? ` (${e.id})` : ""}`;
        for (const [field, type] of Object.entries(fields)) {
            if (!hasType(e[field], type)) problems.push(`${where}: ${field} must be ${type}`);
        }
        if (typeof e.id === "string") {
            if (ids.has(e.id)) problems.push(`${where}: duplicate id`);
            ids.add(e.id);
        }
        if (typeof e.license !== "string" || !ALLOWED_LICENSES.has(e.license)) {
            problems.push(`${where}: license missing or not permitted`);
        }
        if (typeof e.source_id === "string" && !SOURCE_ID.test(e.source_id)) {
            problems.push(`${where}: source_id must be repo@revision:trajectory#index`);
        }
        if (
            typeof e.repo === "string" &&
            !(e.repo.split("/").length === 2 && isPlainRelativePath(e.repo))
        ) {
            problems.push(`${where}: repo must be owner/name`);
        }
    });
    return problems;
}

export function parseJsonl(text: string): unknown[] {
    return text
        .split("\n")
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => line.trim() !== "")
        .map(([line, n]) => {
            try {
                return JSON.parse(line) as unknown;
            } catch (error) {
                throw new Error(`line ${n}: invalid JSON: ${(error as Error).message}`);
            }
        });
}
