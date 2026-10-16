const KINDS = [
    "constraint",
    "decision",
    "plan",
    "rationale",
    "rejected",
    "scoped_update",
    "lookup",
    "never_settled",
    "anchor",
    "tool_error",
    "session_rule",
];
const SCHEMA = "sim-fact-bank/v1";
const LANGUAGES = ["rust", "typescript", "any"];
/** Kinds every language object carries; `any` holds the kinds without a language-specific template set. */
const REQUIRED_KINDS: Record<string, string[]> = {
    rust: ["constraint", "decision", "plan", "rationale", "rejected", "scoped_update", "filler"],
    typescript: [
        "constraint",
        "decision",
        "plan",
        "rationale",
        "rejected",
        "scoped_update",
        "filler",
    ],
    any: ["lookup", "never_settled", "anchor", "tool_error", "session_rule"],
};
const SAMPLE_VARS: Record<string, string> = {
    token: "quiet_vole",
    TOKEN: "QUIET_VOLE",
    value: "12345",
    value2: "54321",
    codename: "brisk-otter-07",
    code: "ValueError",
    context: "x",
    code_re: "ValueError",
};
const QUOTE_STYLES = ["double", "single"];
const LIST_CHECKS = [
    "must",
    "must_not",
    "paths_must",
    "paths_must_not",
    "first_line_must",
    "commands_must",
    "answer_must_not",
];
const SCALAR_CHECKS = ["answer", "judge", "quote_style_must"];
const FLAG_CHECKS = ["abstain"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
    typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

const isRegExp = (pattern: string) => {
    try {
        new RegExp(pattern.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE_VARS[k] ?? m));
        return true;
    } catch {
        return false;
    }
};

function checkProblems(where: string, check: unknown): string[] {
    if (!isObject(check)) return [`${where}: check is not an object`];
    const problems: string[] = [];
    for (const [key, value] of Object.entries(check)) {
        if (LIST_CHECKS.includes(key)) {
            if (!isStringList(value) || value.length === 0) {
                problems.push(`${where}: check key ${key} is not a non-empty list of strings`);
            } else {
                for (const pattern of value) {
                    if (!isRegExp(pattern)) {
                        problems.push(
                            `${where}: check key ${key} pattern ${pattern} is not a regular expression`,
                        );
                    }
                }
            }
        } else if (key === "quote_style_must") {
            if (typeof value !== "string" || !QUOTE_STYLES.includes(value)) {
                problems.push(`${where}: check key ${key} is not double or single`);
            }
        } else if (SCALAR_CHECKS.includes(key)) {
            if (typeof value !== "string")
                problems.push(`${where}: check key ${key} is not a string`);
        } else if (FLAG_CHECKS.includes(key)) {
            if (value !== true) problems.push(`${where}: check key ${key} is not true`);
        } else problems.push(`${where}: check key ${key} is not a check kind`);
    }
    if (Object.keys(check).length === 0) problems.push(`${where}: check is empty`);
    return problems;
}

/** Shape problems in `corpus/fact-bank.json`; an empty list means every template the compiler reads is well formed. */
export function bankProblems(bank: unknown): string[] {
    if (!isObject(bank)) return ["fact-bank: expected an object of languages"];
    const problems: string[] = [];
    if (bank.schema !== SCHEMA) problems.push(`fact-bank schema: ${bank.schema} is not ${SCHEMA}`);
    const ids = new Set<string>();
    for (const [lang, kinds] of Object.entries(bank)) {
        if (lang === "schema" || lang === "note") continue;
        if (!LANGUAGES.includes(lang)) {
            problems.push(`fact-bank ${lang}: unknown language`);
            continue;
        }
        if (!isObject(kinds)) {
            problems.push(`fact-bank ${lang}: expected an object of kinds`);
            continue;
        }
        for (const kind of REQUIRED_KINDS[lang] ?? []) {
            if (!(kind in kinds)) problems.push(`fact-bank ${lang}/${kind}: kind missing`);
        }
        for (const [kind, templates] of Object.entries(kinds)) {
            if (kind === "filler") {
                const ok =
                    isStringList(templates) &&
                    templates.length > 0 &&
                    templates.every((t) => t.trim() !== "");
                if (!ok) {
                    problems.push(
                        `fact-bank ${lang}/filler: expected a non-empty list of non-blank strings`,
                    );
                }
                continue;
            }
            if (!KINDS.includes(kind)) {
                problems.push(`fact-bank ${lang}/${kind}: unknown fact kind`);
                continue;
            }
            if (!Array.isArray(templates)) {
                problems.push(`fact-bank ${lang}/${kind}: expected a list of templates`);
                continue;
            }
            if (templates.length === 0) {
                problems.push(`fact-bank ${lang}/${kind}: expected at least one template`);
                continue;
            }
            templates.forEach((t, i) => {
                const id = isObject(t) && typeof t.id === "string" ? t.id : "?";
                const where = `fact-bank ${lang}/${kind}[${i}] ${id}`;
                if (!isObject(t)) {
                    problems.push(`${where}: expected a template object`);
                    return;
                }
                if (ids.has(id)) problems.push(`${where}: duplicate template id`);
                ids.add(id);
                for (const field of ["id", "statement", "probe"]) {
                    if (typeof t[field] !== "string" || t[field] === "")
                        problems.push(`${where}: ${field} missing`);
                }
                for (const field of ["out_probe", "update"]) {
                    if (field in t && typeof t[field] !== "string")
                        problems.push(`${where}: ${field} is not a string`);
                }
                if ("example" in t) {
                    const e = t.example;
                    if (
                        !isObject(e) ||
                        typeof e.path !== "string" ||
                        typeof e.content !== "string"
                    ) {
                        problems.push(`${where}: example needs path and content`);
                    }
                }
                if ("authority" in t) {
                    const a = t.authority;
                    if (
                        !isObject(a) ||
                        typeof a.path !== "string" ||
                        typeof a.content !== "string"
                    ) {
                        problems.push(`${where}: authority needs path and content`);
                    }
                }
                problems.push(...checkProblems(where, t.check));
                if ("out_check" in t)
                    problems.push(...checkProblems(`${where} out_check`, t.out_check));
            });
        }
    }
    return problems;
}
