import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SEMANTICS = ["always", "always-or-unreached", "sometimes", "reachable", "unreachable"];
/** Capitalised lead-ins a continuation line may open with; every other `Name:` line is a field. */
const PROSE_LEAD_INS = ["PROPOSED"];
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

/**
 * The text outside fenced code blocks and HTML comments. A fence opens with three or more
 * backticks or tildes after up to three spaces and closes with a same-character run at least as
 * long, as Markdown defines.
 */
export function withoutFences(text: string): string {
    const kept: string[] = [];
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    let open: { char: string; length: number } | null = null;
    for (const line of text.split("\n")) {
        const m = /^ {0,3}([`~])\1{2,}/.exec(line);
        const run = m ? m[0].trimStart().length : 0;
        if (open) {
            if (m && m[1] === open.char && run >= open.length && line.trim() === m[0].trim()) {
                open = null;
            }
            continue;
        }
        if (m) {
            open = { char: m[1] ?? "", length: run };
            continue;
        }
        kept.push(line);
    }
    return kept.join("\n");
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
            const alternatives = rest.split(" | ");
            const values =
                alternatives.length > 1
                    ? alternatives.map((a) => (a.split(" - ")[0] ?? "").trim())
                    : null;
            return { name, values };
        });
}

export interface Record {
    slug: string;
    fields: [string, string][];
    /** Non-blank lines between the heading and the first field. */
    preamble: string[];
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
            current = { slug: line.slice(4).trim(), fields: [], preamble: [] };
            records.push(current);
            continue;
        }
        if (!current || line.trim() === "") continue;
        const name = fieldNames.find((f) => line.startsWith(`${f}:`));
        if (name) current.fields.push([name, line.slice(name.length + 1).trim()]);
        else {
            const last = current.fields.at(-1);
            if (last) last[1] = `${last[1]}\n${line}`;
            else current.preamble.push(line);
        }
    }
    return records;
}

export function checkRecord(record: Record, spec: FieldSpec[], catalogDir: string): string[] {
    const errors: string[] = [];
    const at = record.slug;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(at)) errors.push(`${at}: slug is not kebab-case`);
    for (const line of record.preamble) errors.push(`${at}: text before the first field: ${line}`);
    const names = record.fields.map(([n]) => n);
    const expected = spec.map((f) => f.name);
    if (names.join("|") !== expected.join("|")) {
        errors.push(
            `${at}: fields [${names.join(", ")}] differ from METHOD order [${expected.join(", ")}]`,
        );
        return errors;
    }
    record.fields.forEach(([name, value], i) => {
        if (value.trim() === "") {
            errors.push(`${at}: ${name} is blank`);
            return;
        }
        for (const line of value.split("\n").slice(1)) {
            const m = /^([A-Z][A-Za-z/ ]*):/.exec(line);
            if (m && !PROSE_LEAD_INS.includes(m[1] ?? "")) {
                errors.push(`${at}: undeclared field ${m[1]}`);
            }
        }
        if (name === "Check" && (value.split(/ -(?:\s|$)/)[1] ?? "").trim() === "") {
            errors.push(`${at}: Check states no condition after its semantics`);
        }
        if (name === "Exercised" && (value.split(/ -(?:\s|$)/)[1] ?? "").trim() === "") {
            errors.push(`${at}: Exercised states nothing after its value`);
        }
        if (name === "Confidence" && (value.split(/\)\.?/)[1] ?? "").trim() === "") {
            errors.push(`${at}: Confidence states nothing after its evidence link`);
        }
        const allowed = spec[i]?.values;
        const head = (value.split(/ -(?:\s|$)/)[0] ?? "").trim();
        if (allowed && !allowed.includes(head)) {
            errors.push(`${at}: ${name} value ${head} not in METHOD set`);
        }
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
            const evidence = withoutFences(readFileSync(path, "utf8"));
            if (!evidence.startsWith(`# ${at}\n`))
                errors.push(`${at}: evidence title differs from slug`);
            let cursor = 0;
            for (const h of EVIDENCE_HEADINGS) {
                const start = evidence.indexOf(`\n${h}\n`, cursor);
                if (start < 0) {
                    errors.push(
                        evidence.includes(`\n${h}\n`)
                            ? `${at}: evidence heading ${h} is out of order`
                            : `${at}: evidence lacks ${h}`,
                    );
                    continue;
                }
                cursor = start + h.length + 2;
                const rest = evidence.slice(cursor);
                const end = rest.indexOf("\n## ");
                const body = end < 0 ? rest : rest.slice(0, end);
                if (body.trim() === "") errors.push(`${at}: evidence section ${h} is empty`);
            }
            const headings = evidence.split("\n").filter((line) => line.startsWith("## "));
            if (new Set(headings).size !== headings.length) {
                errors.push(`${at}: evidence repeats a heading`);
            }
        }
    }
    const oq = field("Open questions");
    if (oq !== "None." && !(oq.startsWith("\n- ") || oq.startsWith("- "))) {
        errors.push(`${at}: Open questions is neither None. nor a list`);
    } else if (oq !== "None." && oq.split("\n").some((line) => line.trim() === "-")) {
        errors.push(`${at}: Open questions has an empty entry`);
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
    const catalog = withoutFences(readFileSync(catalogPath, "utf8"));
    const dir = dirname(catalogPath);
    const records = parseRecords(
        catalog,
        spec.map((f) => f.name),
    );
    const errors = records.flatMap((r) => checkRecord(r, spec, dir));
    const slugs = records.map((r) => r.slug);
    if (new Set(slugs).size !== slugs.length) errors.push("catalog: duplicate slug");
    const index = catalog.slice(catalog.indexOf("\n## Index") + 1);
    const table = index.slice(0, index.indexOf("\n## "));
    const linked: string[] = [];
    for (const row of table
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .slice(2)) {
        const m =
            /^\| ([A-Z0-9-]+) \| \[([a-z0-9-]+)\]\(#\2\) \| ([a-z]+) \| (`[^`]+`) \| ([a-z-]+) \| ([MS]\d+) \|$/.exec(
                row,
            );
        if (!m) {
            errors.push(`catalog: index row malformed: ${row}`);
            continue;
        }
        const id = m[1] ?? "";
        const slug = m[2] ?? "";
        if (!slug.startsWith(`${id.toLowerCase()}-`)) {
            errors.push(`catalog: index row ${id} links ${slug}`);
        }
        const record = records.find((r) => r.slug === slug);
        if (record) {
            const get = (name: string) => record.fields.find(([n]) => n === name)?.[1] ?? "";
            const shown = [m[3], m[4], m[5]].join(", ");
            const held = [get("Type"), get("Check").split(" - ")[0], get("Reachability")].join(
                ", ",
            );
            if (shown !== held) {
                errors.push(`catalog: index row ${id} reads ${shown}; the record reads ${held}`);
            }
        }
        linked.push(slug);
    }
    if (linked.join("|") !== slugs.join("|"))
        errors.push("catalog: index rows differ from records");
    for (const { prefix, count } of ids) {
        for (let n = 1; n <= count; n++) {
            const id = `${prefix}${String(n).padStart(2, "0")}`;
            const matches = records.filter((r) => r.slug.startsWith(`${id.toLowerCase()}-`));
            const guarantee = matches[0]?.fields.find(([name]) => name === "Guarantee")?.[1] ?? "";
            if (matches.length !== 1) {
                errors.push(`catalog: id ${id} appears ${matches.length} times`);
            } else if (!guarantee.startsWith(`${id}:`)) {
                errors.push(`catalog: ${id} absent from its Guarantee`);
            } else if (guarantee.slice(id.length + 1).trim() === "") {
                errors.push(`catalog: ${id} Guarantee states no claim`);
            }
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

/**
 * The sim-v2 catalog's stable ids: the spec's 77 proposed records, the 3 Workstream A S5 records,
 * the fact-bank presupposition record, and the 3 liveness bounds.
 */
export const SIM_IDS = [
    { prefix: "SIM-P", count: 81 },
    { prefix: "SIM-L", count: 3 },
];

if (import.meta.main) {
    const errors = checkCatalog(
        join(ROOT, "docs/properties/sim-v2/catalog.md"),
        join(ROOT, "docs/properties/METHOD.md"),
        SIM_IDS,
    );
    if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
    }
    const total = SIM_IDS.reduce((sum, { count }) => sum + count, 0);
    console.log(`catalog: ${total} records match METHOD.md`);
}
