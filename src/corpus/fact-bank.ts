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
const SCHEMA = "sim-fact-bank/v4";
const LANGUAGES = ["rust", "typescript", "any"];
/** Kinds every language object carries; `any` holds the kinds without a language-specific template set. */
const REQUIRED_KINDS: Record<string, string[]> = {
    rust: [
        "constraint",
        "decision",
        "plan",
        "rationale",
        "rejected",
        "scoped_update",
        "tool_error",
        "filler",
    ],
    typescript: [
        "constraint",
        "decision",
        "plan",
        "rationale",
        "rejected",
        "scoped_update",
        "tool_error",
        "filler",
    ],
    any: ["lookup", "never_settled", "anchor", "session_rule", "framings"],
};
/** Lists of plain strings a language object may carry beside its fact kinds. */
const TEXT_LISTS = ["filler", "framings"];
const FORMS = ["tool_result", "pasted"];
const BASE_VARS: Record<string, string> = {
    token: "quiet_vole",
    TOKEN: "QUIET_VOLE",
    alt: "brisk_heron",
    ALT: "BRISK_HERON",
    Alt: "BriskHeron",
    value: "12345",
    value2: "54321",
    codename: "brisk-otter-07",
};
const QUOTE_STYLES = ["double", "single"];
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
    "applies",
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
    "applies",
];
const SCALAR_CHECKS = ["answer", "judge", "quote_style_must"];
const FLAG_CHECKS = ["abstain"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
    typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The values sample renderings of one template fill in: the base set with each of its variants. */
type Vars = Record<string, string>;
const varSets = (t: Json): Vars[] => {
    const variants = Array.isArray(t.variants) && t.variants.length > 0 ? t.variants : [{}];
    return variants.map((v) => {
        const entries = isObject(v) ? Object.entries(v) : [];
        const bound = entries.filter((e): e is [string, string] => typeof e[1] === "string");
        return { ...BASE_VARS, ...Object.fromEntries(bound) };
    });
};
const placeholderProblem = (text: string, vars: Vars): string | null => {
    const unknown = [...text.matchAll(/\{(\w+)\}/g)].find(([, k]) => !(k && k in vars));
    return unknown ? "names an unknown placeholder" : null;
};

const fill = (text: string, vars: Vars) =>
    text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
/** A normalised path inside the project: relative, with no empty, `.`, or `..` segment. */
const projectRelative = (path: string, vars: Vars) => {
    const parts = fill(path, vars).split("/");
    return parts.length > 0 && parts.every((p) => p !== "" && p !== "." && p !== "..");
};
const satisfies = (patterns: unknown, text: string, vars: Vars) =>
    !Array.isArray(patterns) ||
    patterns.every((pattern) => {
        try {
            return new RegExp(fill(String(pattern), vars)).test(text);
        } catch {
            return false;
        }
    });

const patternProblem = (pattern: string, vars: Vars): string | null => {
    if (pattern.trim() === "") return "is blank";
    const unknown = placeholderProblem(pattern, vars);
    if (unknown) return `${pattern} ${unknown}`;
    try {
        new RegExp(pattern.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? ""));
        return null;
    } catch {
        return `${pattern} is not a regular expression`;
    }
};

function checkProblems(where: string, check: unknown, kind: string, vars: Vars): string[] {
    if (!isObject(check)) return [`${where}: check is not an object`];
    const problems: string[] = [];
    for (const [key, value] of Object.entries(check)) {
        if (key === SCOPE_KEY) {
            if (
                typeof value !== "string" ||
                !/^[\w./-]+(?:\/|\.\w+)$/.test(value) ||
                !projectRelative(value.replace(/\/$/, ""), vars)
            ) {
                problems.push(
                    `${where}: check key scope is not a directory prefix ending in / or a file path`,
                );
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
                    const problem = patternProblem(pattern, vars);
                    if (problem) problems.push(`${where}: check key ${key} pattern ${problem}`);
                }
            }
        } else if (key === "quote_style_must") {
            if (typeof value !== "string" || !QUOTE_STYLES.includes(fill(value, vars))) {
                problems.push(`${where}: check key ${key} is not double or single`);
            }
        } else if (SCALAR_CHECKS.includes(key)) {
            if (typeof value !== "string")
                problems.push(`${where}: check key ${key} is not a string`);
            else if (value.trim() === "") problems.push(`${where}: check key ${key} is blank`);
            else if (placeholderProblem(value, vars))
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
    if ("applies" in check && !("must" in check)) {
        problems.push(`${where}: check key applies needs must, which every governed unit matches`);
    }
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
            if (TEXT_LISTS.includes(kind)) {
                const ok =
                    isStringList(templates) &&
                    templates.length > 0 &&
                    templates.every((t) => t.trim() !== "") &&
                    new Set(templates).size === templates.length;
                if (!ok) {
                    problems.push(
                        `fact-bank ${lang}/${kind}: expected a non-empty list of distinct non-blank strings`,
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
            const least = kind === "plan" ? 2 : 1;
            if (templates.length < least) {
                problems.push(`fact-bank ${lang}/${kind}: expected at least ${least} templates`);
                continue;
            }
            templates.forEach((t, i) => {
                const id = isObject(t) && typeof t.id === "string" ? t.id : "?";
                const where = `fact-bank ${lang}/${kind}[${i}] ${id}`;
                if (!isObject(t)) {
                    problems.push(`${where}: expected a template object`);
                    return;
                }
                problems.push(...templateProblems(where, kind, t));
                if (lang !== "any") problems.push(...requirementShapeProblems(where, t.requires));
                if (ids.has(id)) problems.push(`${where}: duplicate template id`);
                ids.add(id);
            });
        }
    }
    return problems;
}

/**
 * A language template names the constructs its tasks presuppose: a non-empty list of a project
 * path and a regular expression `src/corpus/presuppositions.ts` matches at each pinned tree.
 */
function requirementShapeProblems(where: string, requires: unknown): string[] {
    if (!Array.isArray(requires) || requires.length === 0) {
        return [`${where}: requires is not a non-empty list`];
    }
    return requires.flatMap((r, i) => {
        const at = `${where}: requires[${i}]`;
        if (!isObject(r) || typeof r.path !== "string" || typeof r.pattern !== "string") {
            return [`${at} needs path and pattern`];
        }
        const problems: string[] = [];
        if (/\{\w+\}/.test(r.path) || !projectRelative(r.path, {})) {
            problems.push(`${at} path is not a fixed project path`);
        }
        const problem = r.pattern.trim() === "" ? "is blank" : null;
        if (problem) problems.push(`${at} pattern ${problem}`);
        else {
            try {
                new RegExp(r.pattern, "m");
            } catch {
                problems.push(`${at} pattern is not a regular expression`);
            }
        }
        return problems;
    });
}

/** Shape problems of one template: its text fields, files, variants, and checks. */
function templateProblems(where: string, kind: string, t: Json): string[] {
    const problems = varSets(t).flatMap((vars) => renderedProblems(where, kind, t, vars));
    if ("variants" in t) problems.push(...variantProblems(where, t.variants));
    return [...new Set(problems)];
}

/** Problems of one template rendered with one set of placeholder values. */
function renderedProblems(where: string, kind: string, t: Json, vars: Vars): string[] {
    const problems: string[] = [];
    const required =
        kind === "plan"
            ? ["id", "task", "probe"]
            : kind === "tool_error"
              ? ["id", "statement", "probe", "form"]
              : ["id", "statement", "probe"];
    for (const field of required) {
        if (typeof t[field] !== "string" || t[field].trim() === "")
            problems.push(`${where}: ${field} missing`);
    }
    for (const field of ["out_probe", "update", "revise", "task", "command", "paste"]) {
        if (field in t && typeof t[field] !== "string")
            problems.push(`${where}: ${field} is not a string`);
    }
    for (const field of ["statement", "task", "probe", "out_probe", "update", "command", "paste"]) {
        const text = t[field];
        if (typeof text === "string" && placeholderProblem(text, vars)) {
            problems.push(`${where}: ${field} names an unknown placeholder`);
        }
    }
    if (typeof t.revise === "string") {
        if (t.revise.trim() === "") problems.push(`${where}: revise is blank`);
        else if (placeholderProblem(t.revise, { ...vars, ...oldOf(vars) })) {
            problems.push(`${where}: revise names an unknown placeholder`);
        }
    }
    for (const field of ["example", "authority", "script"]) {
        if (!(field in t)) continue;
        const part = t[field];
        if (!isObject(part) || typeof part.path !== "string" || typeof part.content !== "string") {
            problems.push(`${where}: ${field} needs path and content`);
            continue;
        }
        if (placeholderProblem(`${part.path}\n${part.content}`, vars)) {
            problems.push(`${where}: ${field} names an unknown placeholder`);
        }
        if (part.path.trim() === "") problems.push(`${where}: ${field} path is blank`);
        else if (!projectRelative(part.path, vars))
            problems.push(`${where}: ${field} path escapes the project`);
    }
    const check = isObject(t.check) ? t.check : {};
    if (kind === "constraint") {
        if (!["must", "paths_must"].some((k) => k in check)) {
            problems.push(`${where}: check needs must or paths_must`);
        }
        if (typeof t.out_probe !== "string" || t.out_probe.trim() === "") {
            problems.push(`${where}: out_probe missing`);
        }
    }
    if (kind === "plan" && !isStringList(check.must)) {
        problems.push(`${where}: check needs must, which a clarify item names`);
    }
    if (kind === "plan") {
        const text = JSON.stringify([t.task, t.check]);
        const rebound = [...text.matchAll(/\{(\w+)\}/g)].some(
            ([, k]) => k !== "token" && k !== "TOKEN",
        );
        if (rebound) {
            problems.push(
                `${where}: a plan task binds only {token} and {TOKEN}, which a second task rebinds`,
            );
        }
    }
    if (kind === "scoped_update") {
        for (const field of ["update", "out_probe"]) {
            if (typeof t[field] !== "string" || t[field].trim() === "") {
                problems.push(`${where}: ${field} missing`);
            }
        }
        if (!("out_check" in t)) problems.push(`${where}: out_check missing`);
    }
    if (kind === "decision") {
        if (!("authority" in t)) problems.push(`${where}: authority missing`);
        else if (isObject(t.authority)) {
            const content = fill(String(t.authority.content ?? ""), vars);
            if (!satisfies(check.must, content, vars)) {
                problems.push(`${where}: authority content does not satisfy the check`);
            }
        }
    }
    if (kind === "constraint" && isObject(t.example)) {
        const content = fill(String(t.example.content ?? ""), vars);
        const path = fill(String(t.example.path ?? ""), vars);
        if (!satisfies(check.must, content, vars) || !satisfies(check.paths_must, path, vars)) {
            problems.push(`${where}: example content does not satisfy the check`);
        }
        const regex = (pattern: unknown, flags: string) => {
            try {
                return new RegExp(fill(String(pattern), vars), flags);
            } catch {
                return null;
            }
        };
        if (Array.isArray(check.applies)) {
            const starts = check.applies.flatMap((pattern) => {
                const re = regex(pattern, "mg");
                return re ? [...content.matchAll(re)].map((m) => m.index) : [];
            });
            const lines = starts.map((at) => content.slice(at).split("\n")[0] as string);
            if (lines.length === 0) {
                problems.push(
                    `${where}: example content is no construct the check's applies governs`,
                );
            } else if (!lines.every((line) => satisfies(check.must, line, vars))) {
                problems.push(`${where}: an example construct the check governs breaks the rule`);
            }
        }
        const scope = typeof check.scope === "string" ? check.scope : undefined;
        if (scope && !(scope.endsWith("/") ? path.startsWith(scope) : path === scope)) {
            problems.push(`${where}: example path lies outside the check's scope`);
        }
    }
    if (kind === "tool_error") problems.push(...toolErrorProblems(where, t, check, vars));
    problems.push(...checkProblems(where, t.check, kind, vars));
    if ("out_check" in t)
        problems.push(...checkProblems(`${where} out_check`, t.out_check, kind, vars));
    return problems;
}

const oldOf = (vars: Vars): Vars =>
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [`old_${k}`, v]));

/** Variants bind the same non-generated placeholders, and consecutive instances differ. */
function variantProblems(where: string, variants: unknown): string[] {
    if (!Array.isArray(variants) || variants.length < 2 || !variants.every(isObject)) {
        return [`${where}: variants is not a list of at least two objects`];
    }
    const keys = Object.keys(variants[0] as Json)
        .sort()
        .join(",");
    const problems: string[] = [];
    for (const v of variants as Json[]) {
        if (Object.keys(v).sort().join(",") !== keys) {
            problems.push(`${where}: variants bind different placeholders`);
        }
        if (!Object.values(v).every((x) => typeof x === "string" && x.trim() !== "")) {
            problems.push(`${where}: a variant value is not a non-blank string`);
        }
        if (Object.keys(v).some((k) => k in BASE_VARS)) {
            problems.push(`${where}: a variant rebinds a generated placeholder`);
        }
    }
    const canonical = (v: Json) =>
        JSON.stringify(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (new Set((variants as Json[]).map(canonical)).size !== variants.length) {
        problems.push(`${where}: variants repeat`);
    }
    return problems;
}

/** A tool error names its form, and the text the agent meets carries the identity the check grades. */
function toolErrorProblems(where: string, t: Json, check: Json, vars: Vars): string[] {
    if (!FORMS.includes(String(t.form))) return [`${where}: form is not ${FORMS.join(" or ")}`];
    const problems: string[] = [];
    const shown =
        t.form === "tool_result"
            ? isObject(t.script)
                ? String(t.script.content ?? "")
                : ""
            : String(t.paste ?? "");
    if (t.form === "tool_result" && (typeof t.command !== "string" || t.command.trim() === "")) {
        problems.push(`${where}: command missing`);
    }
    if (t.form === "tool_result" && !isObject(t.script)) problems.push(`${where}: script missing`);
    const script = isObject(t.script) ? fill(String(t.script.path ?? ""), vars) : "";
    for (const field of ["command", "revise"]) {
        const text = t[field];
        if (
            t.form === "tool_result" &&
            typeof text === "string" &&
            !fill(text, vars).includes(script)
        ) {
            problems.push(`${where}: ${field} does not run the committed script ${script}`);
        }
    }
    if (t.form === "pasted" && (typeof t.paste !== "string" || t.paste.trim() === "")) {
        problems.push(`${where}: paste missing`);
    }
    if (!("must" in check)) problems.push(`${where}: check needs must`);
    else if (!satisfies(check.must, fill(shown, vars), vars)) {
        problems.push(`${where}: the ${t.form} text does not carry the error the check names`);
    }
    if (typeof t.revise === "string" && !satisfies(check.must, fill(t.revise, vars), vars)) {
        if (t.form === "pasted") {
            problems.push(`${where}: revise does not carry the error the check names`);
        }
    }
    return problems;
}
