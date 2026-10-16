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
const ERROR_VARS = ["code", "code_re", "context"];
/** The grading channel each fact kind must use; every other kind grades the diff or command log. */
const REQUIRED_CHECK: Record<string, string> = {
    decision: "must",
    lookup: "answer",
    rationale: "judge",
    never_settled: "abstain",
    anchor: "must_not",
};
const DIFF_KEYS = [
    "must",
    "must_not",
    "paths_must",
    "paths_must_not",
    "first_line_must",
    "commands_must",
    "commands_must_not",
    "quote_style_must",
];
/** Check keys each fact kind may grade with; kinds absent here grade the diff or command log. */
const ALLOWED_KEYS: Record<string, string[]> = {
    lookup: ["answer"],
    rationale: ["judge"],
    never_settled: ["abstain"],
    anchor: ["must_not", "answer_must_not"],
};
/** Check keys that take a string value beside the grading channels. */
const SCOPE_KEY = "scope";
const LIST_CHECKS = [
    "must",
    "must_not",
    "commands_must_not",
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

const placeholderProblem = (text: string, kind: string): string | null => {
    const known = (k: string) =>
        k in SAMPLE_VARS && (kind === "tool_error" || !ERROR_VARS.includes(k));
    const unknown = [...text.matchAll(/\{(\w+)\}/g)].find(([, k]) => !(k && known(k)));
    return unknown ? "names an unknown placeholder" : null;
};

const patternProblem = (pattern: string, kind: string): string | null => {
    if (pattern.trim() === "") return "is blank";
    const unknown = placeholderProblem(pattern, kind);
    if (unknown) return `${pattern} ${unknown}`;
    try {
        new RegExp(pattern.replace(/\{(\w+)\}/g, (_m, k: string) => SAMPLE_VARS[k] ?? ""));
        return null;
    } catch {
        return `${pattern} is not a regular expression`;
    }
};

function checkProblems(where: string, check: unknown, kind: string): string[] {
    if (!isObject(check)) return [`${where}: check is not an object`];
    const problems: string[] = [];
    for (const [key, value] of Object.entries(check)) {
        if (key === SCOPE_KEY) {
            if (typeof value !== "string" || !/^[\w./-]+\/$/.test(value)) {
                problems.push(`${where}: check key scope is not a directory prefix ending in /`);
            }
            continue;
        }
        const known = [...LIST_CHECKS, ...SCALAR_CHECKS, ...FLAG_CHECKS, "quote_style_must"];
        if (known.includes(key) && !(ALLOWED_KEYS[kind] ?? DIFF_KEYS).includes(key)) {
            problems.push(`${where}: check key ${key} is not graded for ${kind} facts`);
        }
        if (LIST_CHECKS.includes(key)) {
            if (!isStringList(value) || value.length === 0) {
                problems.push(`${where}: check key ${key} is not a non-empty list of strings`);
            } else {
                for (const pattern of value) {
                    const problem = patternProblem(pattern, kind);
                    if (problem) problems.push(`${where}: check key ${key} pattern ${problem}`);
                }
            }
        } else if (key === "quote_style_must") {
            if (typeof value !== "string" || !QUOTE_STYLES.includes(value)) {
                problems.push(`${where}: check key ${key} is not double or single`);
            }
        } else if (SCALAR_CHECKS.includes(key)) {
            if (typeof value !== "string")
                problems.push(`${where}: check key ${key} is not a string`);
            else if (value.trim() === "") problems.push(`${where}: check key ${key} is blank`);
            else if (placeholderProblem(value, kind))
                problems.push(`${where}: check key ${key} names an unknown placeholder`);
        } else if (FLAG_CHECKS.includes(key)) {
            if (value !== true) problems.push(`${where}: check key ${key} is not true`);
        } else problems.push(`${where}: check key ${key} is not a check kind`);
    }
    if (Object.keys(check).filter((k) => k !== SCOPE_KEY).length === 0) {
        problems.push(`${where}: check is empty`);
    }
    const required = REQUIRED_CHECK[kind];
    if (required && !(required in check)) problems.push(`${where}: check needs ${required}`);
    return problems;
}

/** Shape problems in `corpus/fact-bank.json`; an empty list means every template the compiler reads is well formed. */
export function bankProblems(bank: unknown): string[] {
    if (!isObject(bank)) return ["fact-bank: expected an object of languages"];
    const problems: string[] = [];
    if (bank.schema !== SCHEMA) problems.push(`fact-bank schema: ${bank.schema} is not ${SCHEMA}`);
    const ids = new Set<string>();
    for (const lang of LANGUAGES) {
        if (!(lang in bank)) problems.push(`fact-bank ${lang}: language missing`);
    }
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
                    if (typeof t[field] !== "string" || t[field].trim() === "")
                        problems.push(`${where}: ${field} missing`);
                }
                for (const field of ["statement", "probe", "out_probe", "update"]) {
                    const text = t[field];
                    if (typeof text === "string" && placeholderProblem(text, kind)) {
                        problems.push(`${where}: ${field} names an unknown placeholder`);
                    }
                }
                for (const field of ["example", "authority"]) {
                    const part = t[field];
                    if (isObject(part)) {
                        const text = `${part.path ?? ""}\n${part.content ?? ""}`;
                        if (placeholderProblem(text, kind)) {
                            problems.push(`${where}: ${field} names an unknown placeholder`);
                        }
                    }
                }
                if (kind === "constraint") {
                    const positive = ["must", "paths_must"];
                    const check = t.check;
                    if (!isObject(check) || !positive.some((k) => k in check)) {
                        problems.push(`${where}: check needs must or paths_must`);
                    }
                }
                if (
                    kind === "constraint" &&
                    (typeof t.out_probe !== "string" || t.out_probe.trim() === "")
                ) {
                    problems.push(`${where}: out_probe missing`);
                }
                for (const field of ["out_probe", "update"]) {
                    if (field in t && typeof t[field] !== "string")
                        problems.push(`${where}: ${field} is not a string`);
                }
                if (kind === "scoped_update") {
                    for (const field of ["update", "out_probe"]) {
                        if (typeof t[field] !== "string" || t[field].trim() === "") {
                            problems.push(`${where}: ${field} missing`);
                        }
                    }
                    if (!("out_check" in t)) problems.push(`${where}: out_check missing`);
                }
                if (kind === "decision" && !("authority" in t)) {
                    problems.push(`${where}: authority missing`);
                }
                if (kind === "decision" && isObject(t.authority) && isObject(t.check)) {
                    const fill = (text: string) =>
                        text.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE_VARS[k] ?? m);
                    const content = fill(String(t.authority.content ?? ""));
                    const must = Array.isArray(t.check.must) ? (t.check.must as string[]) : [];
                    const satisfied = must.every((pattern) => {
                        try {
                            return new RegExp(fill(pattern)).test(content);
                        } catch {
                            return false;
                        }
                    });
                    if (!satisfied)
                        problems.push(`${where}: authority content does not satisfy the check`);
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
                problems.push(...checkProblems(where, t.check, kind));
                if ("out_check" in t)
                    problems.push(...checkProblems(`${where} out_check`, t.out_check, kind));
            });
        }
    }
    return problems;
}
