import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SEMANTICS = ["always", "always-or-unreached", "sometimes", "reachable", "unreachable"];
const EVIDENCE_HEADINGS = [
    "## Discovery trigger",
    "## Evidence trail",
    "## Failure scenario",
    "## Timing windows and dependencies",
    "## What a test must construct",
    "## Investigation log",
];

interface FieldSpec {
    name: string;
    /** The enumerated leading values the schema line lists, or null for free text. */
    values: string[] | null;
}

/** The record fields in schema order, read from the code block under `## Record schema`. */
export function methodFields(method: string): FieldSpec[] {
    const section = method.slice(method.indexOf("## Record schema"));
    const block = section.slice(
        section.indexOf("```") + 3,
        section.indexOf("```", section.indexOf("```") + 3),
    );
    return block
        .split("\n")
        .filter((line) => /^[A-Z][A-Za-z/ ]*:/.test(line))
        .map((line) => {
            const name = line.slice(0, line.indexOf(":"));
            const rest = line.slice(name.length + 1).trim();
            const values = /^[a-z-]+( \| [a-z-]+)+/.test(rest)
                ? (rest.split(" - ")[0] ?? "").split(" | ").map((v) => v.trim().split(" ")[0] ?? "")
                : null;
            return { name, values };
        });
}

export interface Record {
    slug: string;
    fields: [string, string][];
}

/** Records are `### <slug>` blocks; a line that names no schema field continues the previous field. */
export function parseRecords(catalog: string, fieldNames: string[]): Record[] {
    const records: Record[] = [];
    let current: Record | null = null;
    for (const line of catalog.split("\n")) {
        if (line.startsWith("## ")) {
            current = null;
            continue;
        }
        if (line.startsWith("### ")) {
            current = { slug: line.slice(4).trim(), fields: [] };
            records.push(current);
            continue;
        }
        if (!current || line.trim() === "") continue;
        const name = fieldNames.find((f) => line.startsWith(`${f}:`));
        if (name) current.fields.push([name, line.slice(name.length + 1).trim()]);
        else {
            const last = current.fields.at(-1);
            if (last) last[1] = `${last[1]}\n${line}`;
        }
    }
    return records;
}

export function checkRecord(record: Record, spec: FieldSpec[], catalogDir: string): string[] {
    const errors: string[] = [];
    const at = record.slug;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(at)) errors.push(`${at}: slug is not kebab-case`);
    const names = record.fields.map(([n]) => n);
    const expected = spec.map((f) => f.name);
    if (names.join("|") !== expected.join("|")) {
        errors.push(
            `${at}: fields [${names.join(", ")}] differ from METHOD order [${expected.join(", ")}]`,
        );
        return errors;
    }
    record.fields.forEach(([name, value], i) => {
        const allowed = spec[i]?.values;
        const head = value.split(" ")[0] ?? "";
        if (allowed && !allowed.includes(head))
            errors.push(`${at}: ${name} value ${head} not in METHOD set`);
    });
    const field = (name: string) => record.fields.find(([n]) => n === name)?.[1] ?? "";
    const semantics = /^`([^`]+)`/.exec(field("Check"))?.[1] ?? "";
    if (!SEMANTICS.includes(semantics) && !/^always\(!.+\)$/.test(semantics)) {
        errors.push(`${at}: Check semantics ${semantics || "(none)"} not one of the five`);
    }
    const link = /\[evidence\]\((evidence\/[^)]+\.md)\)/.exec(field("Confidence"))?.[1];
    if (link !== `evidence/${at}.md`)
        errors.push(`${at}: Confidence does not link evidence/${at}.md`);
    else {
        const path = join(catalogDir, link);
        if (!existsSync(path)) errors.push(`${at}: ${link} missing`);
        else {
            const evidence = readFileSync(path, "utf8");
            if (!evidence.startsWith(`# ${at}\n`))
                errors.push(`${at}: evidence title differs from slug`);
            for (const h of EVIDENCE_HEADINGS)
                if (!evidence.includes(`\n${h}\n`)) errors.push(`${at}: evidence lacks ${h}`);
        }
    }
    const oq = field("Open questions");
    if (oq !== "None." && !(oq === "" || oq.startsWith("\n- ") || oq.startsWith("- "))) {
        errors.push(`${at}: Open questions is neither None. nor a list`);
    }
    return errors;
}

/** Checks one catalog: schema per record, index rows equal records, ids, one evidence file each. */
export function checkCatalog(
    catalogPath: string,
    methodPath: string,
    ids: { prefix: string; count: number }[],
): string[] {
    const spec = methodFields(readFileSync(methodPath, "utf8"));
    const catalog = readFileSync(catalogPath, "utf8");
    const dir = dirname(catalogPath);
    const records = parseRecords(
        catalog,
        spec.map((f) => f.name),
    );
    const errors = records.flatMap((r) => checkRecord(r, spec, dir));
    const slugs = records.map((r) => r.slug);
    if (new Set(slugs).size !== slugs.length) errors.push("catalog: duplicate slug");
    const indexed = [...catalog.matchAll(/^\| [A-Z0-9-]+ \| \[([a-z0-9-]+)\]\(#\1\) \|/gm)].map(
        (m) => m[1],
    );
    if (indexed.join("|") !== slugs.join("|"))
        errors.push("catalog: index rows differ from records");
    for (const { prefix, count } of ids) {
        for (let n = 1; n <= count; n++) {
            const id = `${prefix}${String(n).padStart(2, "0")}`;
            const matches = slugs.filter((s) => s.startsWith(`${id.toLowerCase()}-`));
            if (matches.length !== 1)
                errors.push(`catalog: id ${id} appears ${matches.length} times`);
            else if (!catalog.includes(`Guarantee: ${id}:`))
                errors.push(`catalog: ${id} absent from its Guarantee`);
        }
    }
    const expectedIds = ids.reduce((sum, { count }) => sum + count, 0);
    if (slugs.length !== expectedIds)
        errors.push(`catalog: ${slugs.length} records, expected ${expectedIds}`);
    const evidence = readdirSync(join(dir, "evidence")).map((f) => basename(f, ".md"));
    for (const e of evidence)
        if (!slugs.includes(e)) errors.push(`catalog: evidence/${e}.md has no record`);
    return errors;
}

if (import.meta.main) {
    const errors = checkCatalog(
        join(ROOT, "docs/properties/sim-v2/catalog.md"),
        join(ROOT, "docs/properties/METHOD.md"),
        [
            { prefix: "SIM-P", count: 77 },
            { prefix: "SIM-L", count: 3 },
        ],
    );
    if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
    }
    console.log("catalog: 80 records match METHOD.md");
}
