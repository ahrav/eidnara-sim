import {
    closeSync,
    constants,
    fstatSync,
    ftruncateSync,
    openSync,
    readFileSync,
    rmSync,
    writeSync,
} from "node:fs";
import { join, posix } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import type { GroundTruth, ProbeItem } from "../scenario/compile";
import {
    type Artefact,
    ArtefactReader,
    assertArtefactsOnly,
    type CallView,
    type Command,
    completed,
    type Field,
    GradeRefused,
    num,
    oneOf,
    optional,
    type Snapshot,
    str,
    text,
} from "./artefacts";
import {
    abstains,
    addedLines,
    carries,
    codeMask,
    DISOWNS,
    type DiffFile,
    diffFiles,
    diffPaths,
    heredocAt,
    literalQuotes,
    matchesAll,
    matchesAny,
    pattern,
    sentences,
    survivingPaths,
    uncommitted,
} from "./text";

export type Rules = Preregistration["grading"];
export type Verdict = "pass" | "fail" | "excluded";

export interface Check {
    must?: string[];
    must_not?: string[];
    paths_must?: string[];
    paths_must_not?: string[];
    first_line_must?: string[];
    first_line_must_not?: string[];
    quote_style_must?: "double" | "single";
    commands_must?: string[];
    commands_must_not?: string[];
    answer?: string;
    answer_must_not?: string | string[];
    abstain?: boolean;
    /** The project a P8-twin item's forbidden value belongs to. */
    owner?: string;
    /**
     * A P6 item whose right response is a question: the final answer asks one and carries every
     * pattern, and the diff applies none of the open tasks.
     */
    clarify?: string[];
    /**
     * A directory prefix ending in `/` or one file path. On most items the diff-channel keys read
     * only files under it; on a P4 `out` item they read the files outside it.
     */
    scope?: string;
    /**
     * Patterns for the constructs the rule governs, such as a new public constant. Each match in
     * the scoped files, extended to its whole statement, is one unit; the rule holds when at least
     * one unit exists and every unit matches every `must` pattern.
     */
    applies?: string[];
    /** Which side of a P4 scoped update the item probes: inside the narrowed scope or outside it. */
    side?: "in" | "out";
    window_from_turn?: number;
    window_to_turn?: number;
    turns?: [number, number];
}

export interface Outcome {
    verdict: Verdict;
    reason?: string;
    metrics: Record<string, number | string | boolean>;
}

export interface GradeRecord extends Outcome {
    item: string;
    arm: string;
    probe_type: string;
    version: number;
    snapshot: string;
    inputs: string[];
    later_attempts_logged: number;
    /** The digest of the grader's source files that produced the record. */
    grader?: string;
    /** The fact a recorded P1 or P1-control grade named, read from earlier runs' logs. */
    pair?: string;
    /**
     * The arm a pairwise (P7) grade was judged against. One host answer is judged once per
     * memory arm, so its grades are distinct records, one per opponent.
     */
    against?: string;
}

export type GradeKey = Pick<GradeRecord, "item" | "arm" | "against">;

/** The skip reason of a P7 item in a run without the host arm, which a pairing step grades. */
export const P7_HOST_ELSEWHERE = "P7 host arm in another run";

/** The skip reason of a host run's P7 item, which a pairing step grades against a memory run. */
export const P7_MEMORY_ELSEWHERE = "P7 memory arm in another run";

/** The snapshot a P14 grade cites: the session view grade-run builds, which no capture wrote. */
export const p14SnapshotId = (arm: string, item: string, session: string) =>
    `${arm}:${item}:${session}`;

const keyOf = (g: GradeKey) => `${g.item}/${g.arm}${g.against ? ` vs ${g.against}` : ""}`;

/** Verdict counts by arm and probe type, with a pairwise grade's opponent in its row name. */
export function verdictCounts(grades: GradeRecord[]): Record<string, Record<string, number>> {
    const counts: Record<string, Record<string, number>> = {};
    for (const g of grades) {
        const row = `${g.arm}/${g.probe_type}${g.against ? ` vs ${g.against}` : ""}`;
        counts[row] ??= {};
        const verdicts = counts[row] as Record<string, number>;
        verdicts[g.verdict] = (verdicts[g.verdict] ?? 0) + 1;
    }
    return counts;
}

const READS = /^(cat|less|more|head|tail|sed|view|bat|grep|rg|read)\b/;
/** `cargo [+toolchain] [OPTIONS]` ahead of the subcommand: the toolchain selector and Cargo's global options. */
const CARGO =
    "cargo(?: \\+\\S+)?(?: (?:-[vq]+|--verbose|--quiet|--locked|--offline|--frozen|--color(?:=\\S+| \\S+)|-C ?\\S+|--config(?:=\\S+| \\S+)|-Z ?\\S+))*";
/** `bun`, `npm`, or `pnpm` with the global options the three accept ahead of the subcommand. */
const PM =
    "(?:bun|npm|pnpm)(?: (?:-[sqrw]|--silent|--quiet|--bun|--offline|--prefer-offline|--workspace-root|--loglevel[= ]\\S+|--cwd[= ]\\S+|--dir[= ]\\S+|-C ?\\S+|--prefix[= ]\\S+|--filter[= ]\\S+|--config[= ]\\S+|--env-file[= ]\\S+))*";
const TESTS = new RegExp(`^(${CARGO} (test|t)|${PM} (run )?test)\\b`);
const QUIET = new RegExp(
    `^\\s*(${CARGO} (build|check|test|b|c|t)|${PM} (install|i|ci|(run )?(test|build))|git (status|log|diff)|ls|pwd)\\b[^&|;\`$()\\n]*$`,
);
const FOLDS = ["history_summarizer", "native_compaction"];
const USER_SIM_LABELS = [
    "task",
    "pushback",
    "interrupt",
    "redirect",
    "abandon",
    "clarify",
    "paste",
];

const compiles: Field = (v) => {
    if (!text(v)) return false;
    const source = (v as string).startsWith("(?i)") ? (v as string).slice(4) : (v as string);
    if (source.length === 0) return false;
    try {
        pattern(v as string);
        return true;
    } catch {
        return false;
    }
};
const patternList: Field = (v) => Array.isArray(v) && v.length > 0 && v.every(compiles);

const CHECK_FIELDS: Record<keyof Check, Field> = {
    must: patternList,
    must_not: patternList,
    commands_must: patternList,
    answer: text,
    paths_must: patternList,
    paths_must_not: patternList,
    first_line_must: patternList,
    first_line_must_not: patternList,
    quote_style_must: oneOf(["double", "single"]),
    commands_must_not: patternList,
    answer_must_not: (v: unknown) => compiles(v) || patternList(v),
    abstain: (v: unknown) => v === true,
    owner: text,
    clarify: patternList,
    scope: (v: unknown) =>
        text(v) &&
        ((v as string).endsWith("/") || /\.\w+$/.test(v as string)) &&
        (v as string)
            .replace(/\/$/, "")
            .split("/")
            .every((p) => p !== "" && p !== "." && p !== ".."),
    applies: patternList,
    side: oneOf(["in", "out"]),
    window_from_turn: (v: unknown) => Number.isInteger(v) && (v as number) >= 0,
    window_to_turn: (v: unknown) => Number.isInteger(v) && (v as number) >= 0,
    turns: (v: unknown) =>
        Array.isArray(v) &&
        v.length === 2 &&
        v.every((n) => Number.isInteger(n) && n >= 0) &&
        (v[0] as number) < (v[1] as number),
};

const REQUIRED: Record<string, (keyof Check)[]> = {
    P2: [],
    P3: ["must", "must_not"],
    P4: ["side"],
    P5: [],
    P8: ["answer"],
    P9: ["abstain"],
    "P8-twin": ["abstain", "answer_must_not", "owner"],
    P10: ["must_not", "answer_must_not"],
    P11: [],
    P13: ["turns"],
    P14: ["window_from_turn"],
};

function binary(type: string, pass: boolean, extra: Outcome["metrics"] = {}, reason?: string) {
    const outcome: Outcome = {
        verdict: pass ? "pass" : "fail",
        metrics: { [`${type}.pass`]: pass, ...extra },
    };
    if (reason && !pass) outcome.reason = reason;
    return outcome;
}

const RESEARCH_TOOLS = new Set([
    "eidnara_search",
    "eidnara_memory",
    "eidnara_note",
    "todowrite",
    "todoread",
]);
const SEARCH_RECORD = /^(grep|glob) \S+( [A-Za-z_]\w*=\S+)*(\n|$)/;
/** A research tool record's tool name and argument object, or null for any other command. */
const toolCall = (command: string): { tool: string; args: Record<string, unknown> } | null => {
    const space = command.indexOf(" ");
    const tool = command.slice(0, space);
    if (space < 0 || !RESEARCH_TOOLS.has(tool)) return null;
    try {
        const args: unknown = JSON.parse(command.slice(space + 1));
        if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
        return { tool, args: args as Record<string, unknown> };
    } catch {
        return null;
    }
};
const toolArguments = (command: string): boolean => toolCall(command) !== null;
const researchCall = (x: Command) => toolArguments(x.command) || SEARCH_RECORD.test(x.command);
const INSPECTS = /^(cat|head|tail|nl|wc|grep|egrep|fgrep|rg|ag|ls|stat|file|read|sed|find|git)$/;
/** `git` global options ahead of the subcommand, with the ones that take the next word. */
const GIT_GLOBAL =
    /^(--no-pager|-P|--paginate|--no-optional-locks|--no-replace-objects|--literal-pathspecs|--bare|--git-dir=.*|--work-tree=.*|--namespace=.*)$/;
const GIT_GLOBAL_VALUE = /^(-C|--git-dir|--work-tree|--namespace)$/;
const GIT_READS = /^(grep|log|show|diff|blame|status|ls-files|rev-parse)$/;
const FIND_ACTS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const RUNS_OR_WRITES =
    /^(--output(=.*)?|--pre(=.*)?|--hostname-bin(=.*)?|--ext-diff|--textconv|-O.*|--open-files-in-pager(=.*)?)$/;
const CONTROL_WORDS = /^(!|if|then|else|elif|while|until|do|time)$/;
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
const SED_PRINTS = new RegExp(
    String.raw`^(?:\s*(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|\+\d+))?)?\s*p\s*;?)+$`,
);
function sedPrints(words: string[]): boolean {
    const scripts: string[] = [];
    let quiet = false;
    let positional = false;
    for (let i = 1; i < words.length; i++) {
        const w = words[i] as string;
        if (w === "--quiet" || w === "--silent") quiet = true;
        else if (w === "--expression") scripts.push(words[++i] ?? "");
        else if (w.startsWith("--expression=")) scripts.push(w.slice(13));
        else if (/^--(in-place|file)/.test(w)) return false;
        else if (/^--(regexp-extended|separate|unbuffered|null-data|posix|debug|sandbox)$/.test(w))
            continue;
        else if (w.startsWith("--")) return false;
        else if (w.startsWith("-") && w.length > 1) {
            for (let j = 1; j < w.length; j++) {
                const flag = w[j] as string;
                if (flag === "n") quiet = true;
                else if (flag === "e") {
                    scripts.push(j + 1 < w.length ? w.slice(j + 1) : (words[++i] ?? ""));
                    break;
                } else if (!/[Ersuz]/.test(flag)) return false;
            }
        } else if (!positional && scripts.length === 0) {
            scripts.push(w);
            positional = true;
        }
    }
    return quiet && scripts.length > 0 && scripts.every((s) => SED_PRINTS.test(s));
}
/** `writesFile` treats unquoted `>` redirections as file writes, with exceptions for `/dev/null` and descriptor targets (`2>&1`). */
const writesFile = (seg: string): boolean => {
    let quote = "";
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i] as string;
        if (quote) {
            if (ch === quote) quote = "";
            else if (ch === "\\" && quote === '"') i++;
        } else if (ch === "\\") i++;
        else if (ch === "'" || ch === '"') quote = ch;
        else if (ch === ">") {
            const target = seg
                .slice(i + 1)
                .replace(/^[>|]/, "")
                .trimStart()
                .replace(/^(&?\s*)(["'])\/dev\/null\2/, "$1/dev/null");
            if (!/^(&\d+-?|&-|&?\s*\/dev\/null)(\s|$)/.test(target)) return true;
        }
    }
    return false;
};
/** `$( )` and backticks expand outside single quotes; `<( )`, `>( )`, and `<<<` act outside any quotes. */
const substitutes = (seg: string): boolean => {
    let quote = "";
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i] as string;
        const next = seg[i + 1] ?? "";
        if (quote === "'") {
            if (ch === "'") quote = "";
            continue;
        }
        if (ch === "\\") i++;
        else if ((ch === "$" && next === "(") || ch === "`") return true;
        else if (quote === '"') {
            if (ch === '"') quote = "";
        } else if (ch === "'" || ch === '"') quote = ch;
        else if ((ch === "<" || ch === ">") && next === "(") return true;
        else if (seg.startsWith("<<<", i)) return true;
    }
    return false;
};
const inspects = (p: Segment): boolean => {
    if (p.body || substitutes(p.seg) || writesFile(p.seg)) return false;
    const command = unprefixed(p.seg);
    if (command !== p.seg.trimStart()) return false;
    const words = shellWords(command);
    while (CONTROL_WORDS.test(words[0] ?? "")) {
        if (words.shift() === "time" && words[0] === "-p") words.shift();
    }
    if (/^\/(usr\/(local\/)?)?bin\/[^/]+$/.test(words[0] ?? "")) {
        words[0] = (words[0] as string).slice((words[0] as string).lastIndexOf("/") + 1);
    }
    return inspectsWords(words);
};
const XARGS_VALUE = /^(-[IELnPsda]|--(max-args|max-procs|max-chars|delimiter|arg-file))$/;
function inspectsWords(words: string[]): boolean {
    const command = words[0] ?? "";
    if (command === "xargs") {
        let i = 1;
        while (i < words.length && (words[i] as string).startsWith("-")) {
            if (/^(-a|--arg-file)/.test(words[i] as string)) return false;
            i += XARGS_VALUE.test(words[i] as string) ? 2 : 1;
        }
        return i < words.length && inspectsWords(words.slice(i));
    }
    if (!INSPECTS.test(command) || words.some((w) => RUNS_OR_WRITES.test(w))) return false;
    if (command === "sed") return sedPrints(words);
    if (command === "find") return !words.some((w) => FIND_ACTS.test(w));
    if (command !== "git") return true;
    let i = 1;
    while (i < words.length) {
        const w = words[i] as string;
        if (GIT_GLOBAL_VALUE.test(w)) i += 2;
        else if (GIT_GLOBAL.test(w)) i++;
        else break;
    }
    return GIT_READS.test(words[i] ?? "");
}
function appliedParts(parts: Reached[], forced: boolean): Segment[] {
    const pipelines: Reached[][] = [];
    for (const p of parts) {
        const open = pipelines.at(-1);
        if (p.piped && open) open.push(p);
        else pipelines.push([p]);
    }
    return pipelines.flatMap((line) => {
        const scanned = forced || !line.every((p) => !groupBody(p.seg) && inspects(p));
        return line.flatMap((p) => {
            const group = groupBody(p.seg);
            if (!group || p.body) return scanned || p.body ? [p] : [];
            const inner = reachableParts(group.body, p.status);
            const outer = forced || line.length > 1 || writesFile(p.seg) || substitutes(p.seg);
            return appliedParts(inner, outer);
        });
    });
}
const appliedCommandText = (r: ArtefactReader) =>
    r
        .commands()
        .filter((x) => !researchCall(x))
        .flatMap((x) => appliedParts(reachableParts(x.command, x.exit), false))
        .map((p) => (p.body ? `${p.seg}\n${p.body.replace(/\n$/, "")}` : p.seg))
        .join("\n");
/** Changed paths join the added lines so a check pattern can match a file name. */
const changed = (r: ArtefactReader) => {
    const patch = r.diff();
    return `${survivingPaths(patch).join("\n")}\n${addedLines(patch)}`;
};

const POSITIVE_KEYS = [
    "clarify",
    "must",
    "paths_must",
    "first_line_must",
    "quote_style_must",
    "commands_must",
] as const;
const NEGATIVE_KEYS = ["must_not", "paths_must_not", "first_line_must_not", "commands_must_not"];
const DIFF_CHANNELS = [
    "must",
    "must_not",
    "paths_must",
    "paths_must_not",
    "first_line_must",
    "first_line_must_not",
    "quote_style_must",
];
/** Probe types whose check must name a rule to hold, and those whose check must name one to break. */
const NEEDS_POSITIVE = ["P1", "P3", "P4", "P6", "P12", "P13"];
const NEEDS_NEGATIVE = ["P2", "P3", "P5", "P10", "P11"];

/**
 * What a check reads: the diff's surviving files on the check's side of `scope`, the files on the
 * other side (for P4's leak check), the text of the read files joined by any extra channel, and a
 * command log.
 */
interface Work {
    files: DiffFile[];
    outside: DiffFile[];
    text: string;
    commands: Command[];
}

/** Notes and prose files: a path under `notes/`, or a Markdown, text, or reStructuredText file. */
const isDoc = (path: string) =>
    /(^|\/)notes\//.test(path) || /\.(md|markdown|txt|rst)$/i.test(path);
/** The files' paths followed by their added lines, the text the pattern channels read. */
const textOf = (files: DiffFile[]) =>
    `${files.map((f) => f.path).join("\n")}\n${files.flatMap((f) => f.added).join("\n")}`;
/** A scope is a directory prefix ending in `/` or one file path. */
const inScope = (scope: string) => (f: DiffFile) =>
    scope.endsWith("/") ? f.path.startsWith(scope) : f.path === scope;

/**
 * The work a check reads. The turn diff is read only when the check names a diff channel. `scope`
 * keeps the files under it, or, on a P4 `out` item, the files outside it; `outside` holds the
 * rest. `text` is the read files' paths and added lines, joined by `extra` when the grader reads
 * more than the diff.
 */
function workFor(
    r: ArtefactReader,
    c: Check,
    commands: Command[] = [],
    extra = (_r: ArtefactReader) => "",
): Work {
    const readsDiff = DIFF_CHANNELS.some((k) => c[k as keyof Check] !== undefined);
    const all = readsDiff ? diffFiles(r.diff()) : [];
    const within = c.scope ? inScope(c.scope) : () => true;
    const mine = (f: DiffFile) => (c.side === "out" && c.scope ? !within(f) : within(f));
    const files = all.filter(mine);
    const lines = textOf(files);
    const more = extra(r);
    return {
        files,
        outside: all.filter((f) => !mine(f)),
        text: more ? `${lines}\n${more}` : lines,
        commands,
    };
}

const invokes = (patterns: string[]) => (x: Command) =>
    checkedSegments(x).some((seg) => startsWithAll(seg, patterns.map(anchored)));
const invokesAny = (patterns: string[]) => (x: Command) => patterns.some((p) => invokes([p])(x));

/**
 * The statements an `applies` pattern finds in the files' added lines: each match, from its first
 * non-blank character, extended to the end of its line, and over following lines while a bracket
 * it opened stays open (ten lines at most). A leading `\s*` that crosses a blanked comment line
 * therefore starts the unit at the construct below the comment.
 * Patterns and brackets read the code mask, so a comment or a string literal starts no unit and
 * opens no bracket; the unit is the source text with its comments blanked, so a comment satisfies
 * no rule.
 */
function unitsOf(files: DiffFile[], patterns: string[]): string[] {
    const units: string[] = [];
    for (const f of files) {
        const text = f.added.join("\n");
        const rust = f.path.endsWith(".rs");
        const mask = codeMask(text, rust);
        const source = codeMask(text, rust, true);
        const starts = new Set<number>();
        for (const p of patterns) {
            const re = pattern(p);
            for (const m of mask.matchAll(new RegExp(re.source, `${re.flags}g`))) {
                const code = m[0].search(/\S/);
                starts.add(m.index + Math.max(code, 0));
            }
        }
        const open = (code: string) =>
            (code.match(/[([{]/g)?.length ?? 0) - (code.match(/[)\]}]/g)?.length ?? 0);
        for (const at of [...starts].sort((a, b) => a - b)) {
            const lines = source.slice(at).split("\n");
            const masked = mask.slice(at).split("\n");
            let unit = lines[0] as string;
            let code = masked[0] as string;
            for (let i = 1; i < lines.length && i <= 10 && open(code) > 0; i++) {
                unit += `\n${lines[i]}`;
                code += `\n${masked[i]}`;
            }
            units.push(unit);
        }
    }
    return units;
}

/**
 * The files a check's positive rules read: code files, and any file a `paths_must` pattern
 * names. A rule stated in a note or a prose file is no change to the work.
 */
const targetsOf = (files: DiffFile[], c: Check) =>
    files.filter((f) => !isDoc(f.path) || matchesAny(f.path, c.paths_must ?? []));

/** Whether the rule holds, with the reason when it does not. */
interface Assessed {
    held: boolean;
    reason?: string;
}

/**
 * Every rule the check names holds in `w`. The `must` patterns read the target files' paths and
 * added lines; with `applies`, they read each governed unit instead, at least one unit must exist,
 * and every unit must match. `paths_must` reads the paths, `first_line_must` the first line of every
 * created file (a created target file at least, so a note alone carries no rule), the quote style every string literal of the target files'
 * added lines (at least one), and `commands_must` one executed segment.
 */
function assess(w: Work, c: Check): Assessed {
    const targets = targetsOf(w.files, c);
    const paths = w.files.map((f) => f.path).join("\n");
    const created = targets.filter((f) => f.created);
    const everyCreated = w.files.filter((f) => f.created);
    const quotes = literalQuotes(targets.flatMap((f) => f.added));
    const firstLines = c.first_line_must;
    const must = c.must ?? [];
    if (c.applies) {
        const units = unitsOf(targets, c.applies);
        if (units.length === 0) return { held: false, reason: "rule not applicable to the change" };
        if (!units.every((u) => matchesAll(u, must))) {
            return { held: false, reason: "a governed construct breaks the rule" };
        }
    }
    const ok =
        (c.applies !== undefined || matchesAll(textOf(targets), must)) &&
        matchesAll(paths, c.paths_must ?? []) &&
        (firstLines === undefined ||
            (created.length > 0 &&
                everyCreated.every((f) => matchesAll(f.added[0] ?? "", firstLines)))) &&
        (c.quote_style_must === undefined ||
            (quotes.length > 0 && quotes.every((q) => q === c.quote_style_must))) &&
        (c.commands_must === undefined || w.commands.some(invokes(c.commands_must)));
    return ok ? { held: true } : { held: false, reason: "rule not applied" };
}
const held = (w: Work, c: Check) => assess(w, c).held;

/** Some rule the check forbids occurs in `w`, over the read files, their paths, and the commands. */
function broken(w: Work, c: Check): boolean {
    const paths = w.files.map((f) => f.path).join("\n");
    const created = w.files.filter((f) => f.created);
    return (
        matchesAny(w.text, c.must_not ?? []) ||
        matchesAny(paths, c.paths_must_not ?? []) ||
        created.some((f) => matchesAny(f.added[0] ?? "", c.first_line_must_not ?? [])) ||
        w.commands.some(invokesAny(c.commands_must_not ?? []))
    );
}

/**
 * Whether a scoped rule leaked to the other side of its scope: a code file there carries the
 * rule's own `must` pattern (in a governed unit when the check names `applies`) or a string literal
 * in its quote style.
 */
function leaked(w: Work, c: Check): boolean {
    if (!c.scope) return false;
    const code = w.outside.filter((f) => !isDoc(f.path));
    const must = c.must ?? [];
    const carriesRule = c.applies
        ? unitsOf(code, c.applies).some((u) => matchesAny(u, must))
        : code.some((f) => f.added.some((l) => matchesAny(l, must)));
    const style = c.quote_style_must;
    const quotes = style ? literalQuotes(code.flatMap((f) => f.added)) : [];
    return carriesRule || quotes.includes(style as "double" | "single");
}

/** Whether the diff names a code file on either side, so a deleted code file counts as a change. */
const codeChanged = (r: ArtefactReader) => diffPaths(r.diff()).some((p) => !isDoc(p));

/** P6 requires the read and the prior-session path to occur in the same executed shell segment. */
/**
 * Segments known to have run: every unconditional segment, and a `&&` continuation when the
 * command exited 0. A `||` continuation is left out, because its execution cannot be read from
 * the exit code.
 */
/**
 * Operator-separated segments with the operator that led to each. Quoted text, a parenthesised
 * or braced group, a word-initial comment, and a heredoc body stay out of the operator scan, so
 * only top-level commands become segments.
 */
interface Segment {
    op: string;
    seg: string;
    /** Heredoc bodies the segment's commands consume, kept apart from the command words. */
    body: string;
    /** A heredoc of the segment has an unquoted delimiter, so the shell expands its body. */
    expands?: boolean;
    /** The command text ends with `&` right after this segment, so its list runs in the background. */
    detached?: boolean;
    piped?: boolean;
}
function splitShell(command: string): Segment[] {
    const out: Segment[] = [];
    let quote = "";
    let depth = 0;
    let seg = "";
    let op = ";";
    const pending: { delim: string; stripTabs: boolean; owner: number }[] = [];
    const expanding = new Set<number>();
    const push = (next: string) => {
        out.push({ op, seg: seg.trim(), body: "" });
        seg = "";
        op = next;
    };
    /** Consumes heredoc bodies after a newline, attaching their lines to the segment that opened them. */
    const skipBodies = (from: number): number => {
        let i = from;
        while (pending.length > 0 && i < command.length) {
            const end = command.indexOf("\n", i);
            const raw = command.slice(i, end < 0 ? command.length : end);
            const head = pending[0] as { delim: string; stripTabs: boolean; owner: number };
            const line = head.stripTabs ? raw.replace(/^\t+/, "") : raw;
            const owner = out[head.owner];
            if (line === head.delim) pending.shift();
            else if (owner) owner.body += `${line}\n`;
            i = end < 0 ? command.length : end + 1;
        }
        return i;
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i] as string;
        if (quote) {
            seg += ch;
            if (ch === quote) quote = "";
            else if (ch === "\\" && quote === '"') seg += command[++i] ?? "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            seg += ch;
        } else if (ch === "\\" && command[i + 1] === "\n") i++;
        else if (ch === "\\") seg += ch + (command[++i] ?? "");
        else if (ch === "(" || ch === "{") {
            depth++;
            seg += ch;
        } else if (ch === ")" || ch === "}") {
            depth = Math.max(0, depth - 1);
            seg += ch;
        } else if (depth > 0) seg += ch;
        else if (ch === "#" && (seg.length === 0 || /[\s;&|(]$/.test(seg))) {
            const end = command.indexOf("\n", i);
            i = end < 0 ? command.length : end - 1;
        } else if (command.startsWith("<<<", i)) {
            seg += "<<<";
            i += 2;
        } else if (command.startsWith("<<", i)) {
            const opened = heredocAt(command.slice(i));
            if (opened) {
                pending.push({
                    delim: opened.delim,
                    stripTabs: opened.stripTabs,
                    owner: out.length,
                });
                if (!/['"\\]/.test(command.slice(i, i + opened.length))) expanding.add(out.length);
                seg += command.slice(i, i + opened.length);
                i += opened.length - 1;
            } else seg += ch;
        } else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
            push(command.slice(i, i + 2));
            i++;
        } else if (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") push("&");
        else if (ch === ";" || ch === "|") push(ch);
        else if (ch === "\n") {
            push("\n");
            if (pending.length > 0) i = skipBodies(i + 1) - 1;
        } else seg += ch;
    }
    out.push({ op, seg: seg.trim(), body: "" });
    for (const at of expanding) if (out[at]) (out[at] as Segment).expands = true;
    const kept = out.filter((x) => x.seg.length > 0);
    const last = kept.at(-1);
    if (last && op === "&" && seg.trim().length === 0) last.detached = true;
    return kept;
}

/** A `{ ...; }` group or `( ... )` subshell: its bracket and body, with any trailing redirections. */
const GROUP = /^([{(])\s*([\s\S]*?)\s*([)}])(\s[^{}()]*)?$/;
const groupBody = (seg: string): { brace: boolean; body: string; rest: string } | null => {
    const m = GROUP.exec(unprefixed(seg));
    if (!m) return null;
    const brace = m[1] === "{";
    if (brace !== (m[3] === "}")) return null;
    return { brace, body: m[2] as string, rest: m[4] ?? "" };
};
/**
 * The parts of a command list that are sure to run: every part guarded by `;`, `&`, or a newline,
 * an `&&` continuation whose whole guard chain is `true` or `:`, and a `||` continuation whose
 * whole guard chain is `false`; a continuation after any other command depends on a status the
 * text does not carry.
 */
const sureParts = (parts: Segment[]): boolean[] => {
    const sure: boolean[] = [];
    let chainSure = true;
    for (const [i, p] of parts.entries()) {
        const guard = p.op;
        if (/^[;&\n]$/.test(guard)) chainSure = true;
        else if (guard === "&&")
            chainSure = chainSure && /^(true|:)$/.test(unprefixed(parts[i - 1]?.seg ?? ""));
        else if (guard === "||")
            chainSure = chainSure && /^false(?:\s|$)/.test(unprefixed(parts[i - 1]?.seg ?? ""));
        sure.push(guard === "|" ? (sure[i - 1] ?? true) : chainSure);
    }
    return sure;
};
/**
 * Whether segment `i` ends the current shell: a sure, foreground `exit` or command-bearing
 * `exec`, or a `{ ...; }` group run in the current shell whose body does so. A pipeline member,
 * a background job, and a `( ... )` subshell end their own process only.
 */
const terminalAt = (parts: Segment[], i: number, sure: boolean): boolean => {
    const own = (parts[i] as Segment).op;
    const next = parts[i + 1]?.op ?? ";";
    if (own === "|" || next === "|" || next === "&" || !sure) return false;
    return terminates((parts[i] as Segment).seg);
};
const terminates = (segment: string): boolean => {
    if (/^exit\b|^exec\s+[^\s<>&\d]/.test(unprefixed(segment))) return true;
    const group = groupBody(segment);
    if (!group?.brace) return false;
    const inner = splitShell(group.body);
    const sure = sureParts(inner);
    return inner.some((_p, i) => terminalAt(inner, i, sure[i] as boolean));
};
/** A reachable part, with the exit status its group body runs under when it is a group. */
interface Reached extends Segment {
    status?: number | null;
    /** The part's list runs in the background (`&`). */
    background?: boolean;
}
/**
 * The reachable parts of one command list given its exit status: a number, null for a command
 * cut off before it finished, or undefined for a completed group whose own status is unrecorded.
 * The grader credits an `&&` continuation of a command that exited 0 in every foreground `;`- or
 * newline-separated list that holds no `||`, unless a `false` guard in its chain stops it; a list
 * with `||` or one run in the background with `&` keeps its sure parts only. A group that ends
 * the command runs under the command's exit status.
 */
const reachableParts = (command: string, exit: number | null | undefined): Reached[] => {
    const parts = splitShell(command);
    const sure = sureParts(parts);
    let guard = ";";
    let list = -1;
    let stopped = false;
    const background = new Set<number>();
    const guarded = parts.map((p, i) => {
        guard = p.op === "|" ? guard : p.op;
        if (/^[;&\n]$/.test(p.op) || list < 0) {
            if (p.op === "&" && list >= 0) background.add(list);
            list++;
            stopped = false;
        } else if (p.op === "&&") {
            stopped = stopped || /^false(?:\s|$)/.test(unprefixed(parts[i - 1]?.seg ?? ""));
        }
        const status = i === parts.length - 1 && !p.detached ? exit : undefined;
        return { ...p, op: guard, piped: p.op === "|", list, stopped, sure: sure[i], status };
    });
    if (parts.at(-1)?.detached) background.add(list);
    const mixed = new Set(guarded.filter((p) => p.op === "||").map((p) => p.list));
    const firstListEnd = guarded.findIndex((p, i) => i > 0 && /^[;&\n]$/.test(p.op));
    const exitAt = guarded.findIndex((p, i) => terminalAt(parts, i, p.sure as boolean));
    const afterExit = exitAt < 0 ? guarded.length : exitAt + 1;
    const unfinished = exit === null && firstListEnd >= 0 ? firstListEnd : guarded.length;
    const reached = Math.min(afterExit, unfinished);
    const credited = (p: (typeof guarded)[number]) =>
        p.op === "&&" && exit === 0 && !p.stopped && !mixed.has(p.list) && !background.has(p.list);
    return guarded
        .slice(0, reached)
        .filter((p) => p.sure || credited(p))
        .map(({ op, seg, body, expands, piped, status, list }) => ({
            op,
            seg,
            body,
            expands,
            piped,
            status,
            background: background.has(list),
        }));
};
/** A group or subshell part opens into its body's reachable parts, under the part's status. */
const flattened = (p: Reached): Segment[] => {
    const group = groupBody(p.seg);
    if (!group) return [p];
    return reachableParts(group.body, p.status).flatMap(flattened);
};
const executedParts = (x: Command): Segment[] =>
    reachableParts(x.command, x.exit).flatMap(flattened);
const executed = (x: Command): string[] => executedParts(x).map((p) => unprefixed(p.seg));
const VARIABLE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/;
/** A shell word, and whether it starts with unquoted, unescaped text, as a redirection operator must. */
interface Token {
    text: string;
    bare: boolean;
    /** The offset in `text` where single-quoted or escaped text first begins, or -1, so a `$(` there is literal. */
    literalAt: number;
}
/**
 * Shell words of a segment, with quotes grouping and removed; inside double quotes a backslash
 * escapes only a double quote, a backslash, `$`, a backtick, and a newline. With `vars`, a `$NAME`
 * or `${NAME}` whose name `vars` holds expands as data inside double quotes and in an assignment
 * value; an unquoted one elsewhere, which the shell would split and glob, stays as written. With
 * `vars`, an unquoted `<` or `>` also starts a new word, so `echo x>msg` reads as `echo x >msg`.
 */
const shellTokens = (segment: string, vars?: ReadonlyMap<string, string>): Token[] => {
    const tokens: Token[] = [];
    let word = "";
    let bare: boolean | null = null;
    let literalAt = -1;
    let quote = "";
    let open = false;
    let escaped = false;
    const end = () => {
        if (word.length > 0 || open) tokens.push({ text: word, bare: bare === true, literalAt });
        word = "";
        bare = null;
        literalAt = -1;
        open = false;
    };
    /** Appends text to the current word; the first piece decides how the word starts. */
    const add = (text: string, plain: boolean, verbatim: boolean) => {
        bare ??= plain;
        if (verbatim && literalAt < 0) literalAt = word.length;
        word += text;
    };
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i] as string;
        const assigning = /^[A-Za-z_]\w*=/.test(word);
        const expands =
            vars !== undefined &&
            ch === "$" &&
            !escaped &&
            (quote === '"' || (!quote && assigning));
        const variable = expands ? VARIABLE.exec(segment.slice(i)) : null;
        const value = variable ? vars?.get(variable[1] ?? variable[2] ?? "") : undefined;
        if (escaped) {
            add(ch, false, true);
            escaped = false;
        } else if (variable && value !== undefined) {
            i += variable[0].length - 1;
            add(value, false, false);
        } else if (quote === '"' && ch === "\\" && /^[\n"\\$`]$/.test(segment[i + 1] ?? "")) {
            i++;
            if (segment[i] !== "\n") add(segment[i] as string, false, true);
        } else if (quote) {
            if (ch === quote) quote = "";
            else add(ch, false, quote === "'");
        } else if (ch === "\\") escaped = true;
        else if (ch === "'" || ch === '"') {
            quote = ch;
            open = true;
            bare ??= false;
        } else if (/\s/.test(ch)) end();
        else {
            const operator = vars !== undefined && (ch === "<" || ch === ">");
            if (operator && word.length > 0 && !/^\d+$|[<>&]$/.test(word)) end();
            add(ch, true, false);
        }
    }
    end();
    return tokens;
};
const shellWords = (segment: string, vars?: ReadonlyMap<string, string>): string[] =>
    shellTokens(segment, vars).map((t) => t.text);
/** A segment's words split into arguments, its standard-input sources in order, and its standard-output files. */
interface Redirected {
    args: string[];
    /** Per argument, where single-quoted or escaped text first begins (`Token.literalAt`), or -1. */
    literalAt: number[];
    stdin: { kind: "heredoc" | "string" | "file" | "descriptor"; value: string }[];
    out: { path: string; append: boolean }[];
    /** Standard output was duplicated onto another descriptor (`>&2`), so its text goes elsewhere. */
    dupOut?: boolean;
    heredocs: number;
}
const REDIRECTION = /^(\d*)(<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)(.*)$/s;
const redirected = (tokens: Token[]): Redirected => {
    const r: Redirected = { args: [], literalAt: [], stdin: [], out: [], heredocs: 0 };
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] as Token;
        const m = token.bare ? REDIRECTION.exec(token.text) : null;
        if (!m) {
            r.args.push(token.text);
            r.literalAt.push(token.literalAt);
            continue;
        }
        const [, fd, op, attached] = m as unknown as [string, string, string, string];
        const operand = attached.length > 0 ? attached : (tokens[++i]?.text ?? "");
        const input = fd === "" || fd === "0";
        if (op.startsWith("<<") && op !== "<<<") r.heredocs++;
        if (op === "<<<" && input) r.stdin.push({ kind: "string", value: `${operand}\n` });
        else if (op.startsWith("<<") && op !== "<<<" && input)
            r.stdin.push({ kind: "heredoc", value: "" });
        else if ((op === "<" || op === "<>") && input)
            r.stdin.push({ kind: "file", value: operand });
        else if (op === "<&" && input) r.stdin.push({ kind: "descriptor", value: operand });
        else if (
            /^(>|>>|>\||&>|&>>)$/.test(op) &&
            (fd === "" || fd === "1" || op.startsWith("&"))
        ) {
            r.out.push({ path: operand, append: op.endsWith(">>") });
        } else if (op === ">&" && (fd === "" || fd === "1")) r.dupOut = true;
    }
    return r;
};
/** What a part's standard input and output read: its heredoc, the files and variables so far, and piped output. */
interface Context {
    body: string;
    expands: boolean;
    files: ReadonlyMap<string, string>;
    vars: ReadonlyMap<string, string>;
    piped: string | null;
}
/**
 * The text a part sends to standard output when the command text carries it: an `echo` of literal
 * words, a `printf` of one literal format or of `%s` with its arguments, or a byte-preserving
 * `cat` or `tee` of a single standard-input source (a heredoc, a here-string, a file the command
 * wrote, or the output piped in).
 */
const outputOf = (r: Redirected, ctx: Context): string | null => {
    const [command, ...rest] = r.args;
    if (command === "echo") {
        const flags = /^-[neE]+$/.test(rest[0] ?? "") ? (rest[0] as string) : "";
        if (flags.includes("e")) return null;
        const words = flags ? rest.slice(1) : rest;
        return `${words.join(" ")}${flags.includes("n") ? "" : "\n"}`;
    }
    if (command === "printf") {
        const [format, ...values] = rest[0] === "--" ? rest.slice(1) : rest;
        if (format === undefined) return null;
        const decoded = format.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        if (/^%s(\\n)?$/.test(format))
            return values.map((v) => decoded.replace("%s", () => v)).join("");
        return format.includes("%") ? null : decoded;
    }
    if (command === "tee" || (command === "cat" && rest.every((w) => w === "-" || w === "-u"))) {
        return stdinOf(r, ctx);
    }
    return null;
};
/**
 * The single standard-input source of a part, or null when it has none the text carries or more
 * than one. An unquoted heredoc expands `$NAME` and `${NAME}` from the tracked variables; any other
 * expansion leaves it unresolved.
 */
const stdinOf = (r: Redirected, ctx: Context): string | null => {
    if (r.stdin.length === 0) return ctx.piped;
    if (r.stdin.length > 1) return null;
    const only = r.stdin[0] as Redirected["stdin"][number];
    if (only.kind === "string") return only.value;
    if (only.kind === "descriptor") return null;
    if (only.kind === "file") return ctx.files.get(tracked(only.value) ?? "") ?? null;
    if (r.heredocs !== 1) return null;
    if (!ctx.expands) return ctx.body;
    const body = ctx.body.replace(
        /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
        (whole, braced?: string, bare?: string) => ctx.vars.get(braced ?? bare ?? "") ?? whole,
    );
    return /[$`\\]/.test(body) ? null : body;
};
/**
 * The key a written path is tracked under, or null for a path whose target depends on links (one
 * with `..`) or a device or process file (under `/dev/` or `/proc/`), which holds no written text.
 */
const tracked = (path: string): string | null => {
    const key = posix.normalize(path);
    return path.split("/").includes("..") || /^\/(dev|proc)\//.test(key) ? null : key;
};
/** Commands that read the files they name and change none of them. */
const FILE_READS = /^(cat|head|tail|nl|wc|grep|egrep|fgrep|rg|ls|stat|file|diff|less|more)$/;
/** `git` global options that take the next word as their value, and those that stand alone. */
const GIT_VALUE_GLOBALS = /^(-c|-C|--git-dir|--work-tree|--namespace|--config-env|--attr-source)$/;
const GIT_FLAG_GLOBALS =
    /^(-p|-P|--paginate|--no-pager|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--bare|--(git-dir|work-tree|namespace|config-env|attr-source|exec-path)=.*)$/;
/** `git commit` short options that take a value, and those whose value can only be attached. */
const COMMIT_VALUE_SHORT = "mFt";
const COMMIT_ATTACHED_SHORT = "Su";
/** Options that make `git commit` print status and commit nothing. */
const STATUS_ONLY = /^--(porcelain|short|long|null)$/;
/** Options with which Git builds the subject itself: `squash! ...`, `fixup! ...`, or a reused message. */
const GENERATED_SUBJECT = /^--(squash|fixup|reuse-message|reedit-message)(=|$)/;
/** `-m "$(cat <<'EOF' ... EOF)"`: the heredoc body a command substitution of `cat` prints. */
const CAT_SUBSTITUTION =
    /^\$\(\s*cat\s*<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2[ \t]*\n([\s\S]*?\n)[ \t]*\3[ \t]*\n\s*\)$/;
/** The body a `$(cat <<EOF ...)` value prints, with `<<-` tabs stripped, or the value itself. */
const substituted = (value: string): string => {
    const m = CAT_SUBSTITUTION.exec(value);
    if (!m) return value;
    const body = m[4] as string;
    return m[1] === "-" ? body.replace(/^\t+/gm, "") : body;
};
/**
 * A `git [global options] commit` part rewritten with its message as `-m '<subject>'` after its
 * other words, or null when the part is no commit, reuses another commit's message, or the command
 * text does not carry the message; `--squash` and `--fixup` read as their `squash! ` and `fixup! `
 * subjects. The message is every `-m`/`--message` value as one paragraph
 * (an unquoted or double-quoted `$(cat <<EOF ...)` value reads as its body), else the
 * `-F`/`--file` source: the part's standard input for `-`, or a file the command wrote. The
 * subject is the message's first non-blank line.
 */
const commitRead = (r: Redirected, ctx: Context): string | null => {
    const words = r.args;
    if (words[0] !== "git") return null;
    let i = 1;
    while (i < words.length && (words[i] as string).startsWith("-")) {
        const w = words[i] as string;
        if (GIT_VALUE_GLOBALS.test(w)) i += 2;
        else if (GIT_FLAG_GLOBALS.test(w)) i++;
        else return null;
    }
    if (words[i] !== "commit") return null;
    const kept = ["git", "commit"];
    let messages: string[] = [];
    let file: string | undefined;
    let cleanup = "";
    let generated: string | undefined;
    /** A value's `$(cat <<EOF)` is a substitution unless the value starts as literal text. */
    const message = (value: string, j: number, from = 0) =>
        messages.push(r.literalAt[j] === from ? value : substituted(value));
    for (let j = i + 1; j < words.length; j++) {
        const w = words[j] as string;
        if (w === "--") {
            kept.push(...words.slice(j));
            break;
        }
        const builds = GENERATED_SUBJECT.exec(w)?.[1];
        if (builds === "reuse-message" || builds === "reedit-message" || STATUS_ONLY.test(w)) {
            return null;
        }
        if (w === "-e" || w === "--edit") return null;
        if (builds) {
            generated = `${builds}! `;
            kept.push(w);
            if (!w.includes("=")) kept.push(words[++j] ?? "");
        } else if (w === "--message") {
            j++;
            message(words[j] ?? "", j);
        } else if (w === "--file") file = words[++j] ?? "";
        else if (w.startsWith("--message="))
            message(w.slice("--message=".length), j, "--message=".length);
        else if (w.startsWith("--file=")) file = w.slice("--file=".length);
        else if (w === "--no-message") messages = [];
        else if (w === "--no-file") file = undefined;
        else if (w === "--no-cleanup") cleanup = "";
        else if (w === "--cleanup" || w.startsWith("--cleanup=")) {
            cleanup = w === "--cleanup" ? (words[++j] ?? "") : w.slice("--cleanup=".length);
            kept.push(`--cleanup=${cleanup}`);
        } else if (/^-[^-]/.test(w)) {
            let flags = "-";
            for (let k = 1; k < w.length; k++) {
                const ch = w[k] as string;
                if (ch === "c" || ch === "C" || ch === "z" || ch === "e") return null;
                if (COMMIT_ATTACHED_SHORT.includes(ch)) {
                    flags += w.slice(k);
                    break;
                }
                if (!COMMIT_VALUE_SHORT.includes(ch)) {
                    flags += ch;
                    continue;
                }
                const attached = k + 1 < w.length;
                const value = attached ? w.slice(k + 1) : (words[++j] ?? "");
                if (ch === "m") message(value, j, attached ? k + 1 : 0);
                else if (ch === "F") file = value;
                else kept.push(`-${ch}`, value);
                break;
            }
            if (flags.length > 1) kept.push(flags);
        } else kept.push(w);
    }
    let text: string | null;
    if (generated !== undefined) text = generated;
    else if (messages.length > 0) text = messages.join("\n\n");
    else if (file === undefined) return null;
    else text = file === "-" ? stdinOf(r, ctx) : (ctx.files.get(tracked(file) ?? "") ?? null);
    if (text === null) return null;
    const lines = text.split("\n").filter((l) => cleanup !== "strip" || !l.startsWith("#"));
    const subject = lines.find((l) => l.trim().length > 0) ?? "";
    return [...kept, "-m", subject].map(shellQuoted).join(" ");
};
const shellQuoted = (w: string) =>
    /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
/**
 * The executed segments of a command as the command channels read them. A `git commit` whose
 * message the command text carries reads as `commitRead` rewrites it, so a check sees the message
 * wherever it came from: `-m` values with `$NAME` expanded from the command's earlier assignments,
 * a heredoc, a here-string, or piped output for `-F -`, or for `-F <path>` a file an earlier part
 * of the command wrote from text it carries. Assignments made in a `( ... )` subshell, a pipeline,
 * or a background job stay in that scope, and `unset` drops one. A write goes to a part's last
 * standard-output target (earlier `>` targets are emptied), a `>>` append extends a file the
 * command wrote, and a file stays tracked only while no other part names it except to read it, no
 * group writes it, and, for a relative path, no `cd` moves the shell.
 */
const checkedSegments = (x: Command): string[] => {
    const files = new Map<string, string>();
    /** Paths a command named other than to read them stay untrusted for the rest of the command. */
    const tainted = new Set<string>();
    let moved = false;
    const write = (path: string, text: string | null, append: boolean, trusted = true) => {
        const key = tracked(path);
        if (key === null) return;
        const before = files.get(key);
        if (!trusted || text === null || (append && before === undefined) || tainted.has(key)) {
            files.delete(key);
            if (!trusted || text === null) tainted.add(key);
        } else files.set(key, append ? `${before}${text}` : text);
    };
    const walk = (parts: Reached[], vars: Map<string, string>, scoped = false): string[] => {
        let piped: string | null = null;
        return parts.flatMap((p, i) => {
            const inPipe = p.piped || parts[i + 1]?.piped === true;
            const isolated = inPipe || p.background === true;
            const from = p.piped ? piped : null;
            piped = null;
            const group = groupBody(p.seg);
            if (group) {
                const own = !group.brace || isolated;
                const scope = own ? new Map(vars) : vars;
                const inner = walk(reachableParts(group.body, p.status), scope, scoped || own);
                for (const t of redirected(shellTokens(group.rest, vars)).out)
                    write(t.path, null, false);
                return inner;
            }
            const all = shellWords(p.seg, vars);
            const named = /^(export|readonly|declare)$/.test(all[0] ?? "") ? all.slice(1) : all;
            if (named.length > 0 && named.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
                if (!isolated)
                    for (const w of named)
                        vars.set(w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1));
                return [unprefixed(p.seg)];
            }
            // An assignment the tokens do not resolve (`P=$(printf x)`) drops the stale value.
            for (const m of p.seg.matchAll(/(?:^|\s)([A-Za-z_]\w*)=/g)) {
                if (!isolated && !named.includes(`${m[1]}=`)) vars.delete(m[1] as string);
            }
            const r = redirected(shellTokens(unprefixed(p.seg), vars));
            const [command, ...args] = r.args;
            if (command === "unset" && !isolated) for (const w of args) vars.delete(w);
            if (/^(cd|pushd|popd)$/.test(command ?? "")) {
                for (const key of [...files.keys()]) if (!key.startsWith("/")) files.delete(key);
                if (scoped) moved = true;
            }
            // A write from a subshell or background list lands in another directory or at an
            // unknown time, and a relative path after a subshell's cd names an unknown directory.
            const trusted = !isolated && !(scoped && !group) && !moved;
            const ctx = { body: p.body, expands: p.expands === true, files, vars, piped: from };
            const reads = r.stdin.filter((x) => x.kind === "file").map((x) => tracked(x.value));
            const clobbers = r.out.some((t) => !t.append && reads.includes(tracked(t.path)));
            const output = clobbers || r.dupOut ? null : outputOf(r, ctx);
            const commit = commitRead(r, ctx);
            const tees = command === "tee" ? args.filter((w) => !w.startsWith("-")) : [];
            const teeAppends = args.some((w) => /^(-a|--append)$/.test(w));
            if (commit === null && !(command !== undefined && FILE_READS.test(command))) {
                for (const w of args) if (!tees.includes(w)) write(w, null, false);
            }
            for (const path of tees) write(path, output, teeAppends, trusted);
            for (const [k, t] of r.out.entries()) {
                write(t.path, k === r.out.length - 1 ? output : "", t.append, trusted);
            }
            if (inPipe && r.out.length === 0) piped = output;
            return [commit ?? unprefixed(p.seg)];
        });
    };
    return walk(reachableParts(x.command, x.exit), new Map());
};
/** Options whose value is the next word, so that word is neither pattern nor file, per command. */
const VALUE_OPTIONS: Record<string, RegExp> = {
    grep: /^(-[ABCmdD]|--(max-count|after-context|before-context|context|include|exclude|exclude-dir|devices|directories|label))$/,
    rg: /^(-[ABCmdgtTEjMr]|--(max-count|after-context|before-context|context|glob|iglob|type|type-not|max-depth|threads|color|colour|encoding|pre|sort|sortr|replace|max-columns|max-filesize|path-separator|context-separator|field-context-separator|field-match-separator|dfa-size-limit|regex-size-limit|type-add|type-clear|ignore-file))$/,
};
/**
 * A read segment's file operands. For grep and rg the pattern is the first non-option word unless
 * an option supplies it (`-e`, `--regexp`, `-f`, `--file`), in which case every positional word is a file.
 */
const operands = (segment: string): string[] => {
    const raw = shellWords(segment);
    if (raw[0] === "read") return inputTargets(raw);
    const words = unredirectedWords(raw);
    if (!/^(grep|rg|sed)$/.test(words[0] as string)) return words.slice(1);
    const scriptOptions =
        words[0] === "sed" ? /^(-e|-f|--expression|--file)$/ : /^(-e|-f|--regexp|--file)$/;
    const attached =
        words[0] === "sed" ? /^(-e.|-f.|--expression=|--file=)/ : /^(-e.|-f.|--regexp=|--file=)/;
    const files: string[] = [];
    let supplied = false;
    for (let i = 1; i < words.length; i++) {
        const w = words[i] as string;
        if (scriptOptions.test(w)) {
            supplied = true;
            i++;
        } else if (attached.test(w)) supplied = true;
        else if (VALUE_OPTIONS[words[0] as string]?.test(w)) i++;
        else if (!w.startsWith("-")) files.push(w);
    }
    if (!supplied) files.shift();
    return files;
};
/** Redirection operators split from the word they are attached to. */
const splitRedirections = (raw: string[]): string[] =>
    raw.flatMap((w) => {
        const at = w.search(/(?<=[^<>&])\d*&?[<>]/);
        return at > 0 ? [w.slice(0, at), w.slice(at)] : [w];
    });
/** The targets of `<` input redirections, which the shell opens for the command; the `read` builtin's words are variable names. */
const inputTargets = (raw: string[]): string[] => {
    const words = splitRedirections(raw);
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (/^\d*<<<?-?$/.test(w)) i++;
        else if (/^\d*<<<?-?./.test(w)) continue;
        else if (/^\d*<$/.test(w)) out.push(words[++i] ?? "");
        else if (/^\d*<./.test(w)) out.push(w.replace(/^\d*</, ""));
    }
    return out.filter((w) => w.length > 0);
};
/**
 * Shell words with output redirections removed (operator and target), heredoc and here-string
 * operators removed with their delimiter or value, and `<` input redirections reduced to their
 * target, which the command reads.
 */
const unredirectedWords = (raw: string[]): string[] => {
    const words = splitRedirections(raw);
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (/^\d*&?>>?$/.test(w)) i++;
        else if (/^\d*&?>>?./.test(w)) continue;
        else if (/^\d*<<<?-?$/.test(w)) i++;
        else if (/^\d*<<<?-?./.test(w)) continue;
        else if (/^\d*<$/.test(w)) continue;
        else if (/^\d*<./.test(w)) out.push(w.replace(/^\d*</, ""));
        else out.push(w);
    }
    return out;
};
/** The command after any leading `NAME=value` assignments. */
const unprefixed = (seg: string): string => {
    let rest = seg.trimStart();
    for (;;) {
        const m = /^[A-Za-z_]\w*=/.exec(rest);
        if (!m) return rest;
        let i = m[0].length;
        let quote = "";
        /** Open `$(`, `${`, and backtick substitutions, inside which whitespace belongs to the value. */
        const nest: string[] = [];
        while (i < rest.length) {
            const ch = rest[i] as string;
            if (quote) {
                if (ch === quote) quote = "";
            } else if (nest.at(-1) === "`") {
                if (ch === "`") nest.pop();
            } else if (ch === "'" || ch === '"') quote = ch;
            else if (ch === "\\") i++;
            else if (ch === "`") nest.push("`");
            else if (ch === "$" && (rest[i + 1] === "(" || rest[i + 1] === "{")) {
                nest.push(rest[i + 1] === "(" ? ")" : "}");
                i++;
            } else if (nest.length > 0 && ch === nest.at(-1)) nest.pop();
            else if (nest.length === 0 && /\s/.test(ch)) break;
            i++;
        }
        if (i >= rest.length) return rest;
        rest = rest.slice(i).trimStart();
    }
};
const anchored = (p: string) => (p.startsWith("(?i)") ? `(?i)^(?:${p.slice(4)})` : `^(?:${p})`);
/** Match from the segment's first character; the `m` flag of `pattern` would let `^` match an inner line. */
const startsWithAll = (seg: string, sources: string[]) =>
    sources.every((src) => {
        const re = pattern(src);
        return new RegExp(re.source, re.flags.replace("m", "")).test(seg);
    });
const namesPath = (words: string[], path: string) =>
    words.some((w) => w === path || w === `./${path}`);
const ranTests = (x: Command) => executed(x).some((s) => TESTS.test(s));

function foldsIn(r: ArtefactReader, turns?: [number, number]): CallView[] {
    const folds = r.calls().filter((c) => FOLDS.includes(c.component) && completed(c));
    if (!turns) return folds;
    const [lo, hi] = turns;
    const unindexed = folds.find((c) => c.turn_index === undefined);
    if (unindexed) {
        throw new GradeRefused(`fold call without a turn index at seq ${unindexed.seq}`);
    }
    return folds.filter((c) => (c.turn_index as number) >= lo && (c.turn_index as number) < hi);
}

/**
 * P4 reads the files on its side of the scope. Inside the narrowed scope the update holds and the
 * old rule does not; outside it the old rule holds and the update does not. A rule that leaks to
 * the other side also fails the item: the update outside its scope collapses the still-valid
 * fact, and the old rule inside the scope keeps the superseded one.
 */
function p4(r: ArtefactReader, c: Check): Outcome {
    const w = workFor(r, c, c.commands_must || c.commands_must_not ? r.commands() : []);
    const kept = assess(w, c);
    const wrong = broken(w, c);
    const leak = leaked(w, c);
    const collapsed = (wrong && c.side === "out") || (leak && c.side === "in");
    const superseded = (wrong && c.side !== "out") || (leak && c.side === "out");
    const reasons = [
        kept.held
            ? ""
            : kept.reason === "rule not applied"
              ? "missing the expected rule"
              : kept.reason,
        superseded ? "kept the superseded rule" : "",
        collapsed ? "collapsed a still-valid fact" : "",
    ].filter(Boolean);
    return binary(
        "P4",
        kept.held && !wrong && !leak,
        { "P4.harm": collapsed, "P4.collapsed": collapsed },
        reasons.join("; "),
    );
}

const CHOICE = /\b(?:which|either|whether|or|first|order|prefer|rather)\b/i;
/** A sentence that picks a task after all: `I'll start with`, `let me begin`. */
const COMMITS =
    /\bI(?:'ll| will|'m going to| am going to|'ve decided to| have decided to| decided to) (?:start|begin|go with|do|take|pick|work on|tackle|implement|proceed|build|add)\b(?!\s+(?:with\s+|on\s+)?(?:neither|whichever\s+(?:you|the user))\b)|\bI(?:'m| am) (?:starting|beginning|going with|doing|taking|picking|working on|tackling|implementing|proceeding with)\b(?!\s+(?:with\s+|on\s+)?(?:neither|whichever\s+(?:you|the user))\b)|\bI(?:'ve| have)? (?:choose|pick|chose|picked|chosen|selected|select|decided on|went with|gone with|will go with|am going with)\b(?!\s+(?:neither|whichever\s+(?:you|the user))\b)|\blet me (?:start|begin)\b/i;
/**
 * The answer leaves the choice to the user: its last choice question is followed by at most three
 * statements and any number of questions, and a sentence after its first choice question that
 * matches `COMMITS` makes the answer a pick.
 */
const asksToChoose = (answer: string) => {
    const all = sentences(answer);
    const choices = all.flatMap((s, i) => (s.endsWith("?") && CHOICE.test(s) ? [i] : []));
    const first = choices[0];
    const last = choices.at(-1);
    if (first === undefined || last === undefined) return false;
    const statements = all.slice(last + 1).filter((s) => !s.endsWith("?"));
    return statements.length <= 3 && !all.slice(first + 1).some((s) => COMMITS.test(s));
};

/**
 * P6 grades the code the turn changed: a resume item passes when that change carries the planned
 * next step and none of the superseded ones; reading or searching for the step is no progress. A
 * clarify item passes when the answer names every open task, asks the user to choose among them,
 * and the change applies none of them.
 */
function p6(r: ArtefactReader, c: Check, probe: ProbeItem): Outcome {
    const expect = probe.ground_truth?.expect;
    if (expect !== undefined && (expect === "clarify") !== (c.clarify !== undefined)) {
        throw new GradeRefused(
            `P6 item ${probe.id} expects ${expect}, which its check ${c.clarify ? "contradicts" : "lacks"}`,
        );
    }
    const prior = diffPaths(r.diff("prior-session"));
    const commands = r.commands();
    const reread = prior.filter((p) =>
        commands.some((x) => executed(x).some((s) => READS.test(s) && namesPath(operands(s), p))),
    );
    const turnCalls = r.turnCalls();
    if (turnCalls.length === 0) {
        throw new GradeRefused("P6 snapshot has no agent call for its turn to sum tokens over");
    }
    const tokens = turnCalls.reduce((n, x) => n + x.input_tokens + x.output_tokens, 0);
    const all = workFor(r, c, commands);
    const files = all.files.filter((f) => !isDoc(f.path));
    const code: Work = {
        ...all,
        files,
        text: textOf(files),
    };
    let reason: string;
    let pass: boolean;
    if (c.clarify) {
        const answer = r.answer();
        const named = matchesAll(answer, c.clarify);
        const asks = asksToChoose(answer);
        const applied = broken(code, c);
        pass = named && asks && !applied;
        reason = applied
            ? "applied an open task instead of asking"
            : !asks
              ? "asked no question choosing between the open tasks"
              : "question does not name every open task";
    } else {
        const done = held(code, c);
        const stale = broken(code, c);
        pass = done && !stale;
        reason = stale ? "resumed a superseded step" : "change does not carry the next step";
    }
    return binary(
        "P6",
        pass,
        {
            "P6.reread_files": reread.length,
            "P6.ran_tests": commands.some(ranTests),
            "P6.rediscovery_tokens": tokens,
        },
        reason,
    );
}

/**
 * An `eidnara_memory` get or candidates call, or an `eidnara_note` read (its default without
 * content). A reduced wrapper (`reduced`, `summary`) hides its real action, so it reads as work.
 */
const memoryRead = (x: Command): boolean => {
    const call = toolCall(x.command);
    if (!call || "reduced" in call.args || "summary" in call.args) return false;
    const { action, content } = call.args;
    if (call.tool === "eidnara_memory") return action === "get" || action === "candidates";
    if (call.tool !== "eidnara_note") return false;
    const empty = content === undefined || (typeof content === "string" && content.trim() === "");
    return action === "read" || (action === undefined && empty);
};

function p13(r: ArtefactReader, c: Check, rules: Rules): Outcome {
    const folds = foldsIn(r, c.turns);
    if (folds.length === 0) {
        return { verdict: "excluded", reason: "no fold in the item's range", metrics: {} };
    }
    const boundary = Math.min(...folds.map((x) => x.scenario_ms));
    const commands = r.commands("session");
    const after = commands.filter((x) => x.scenario_ms >= boundary);
    const before = new Set(commands.filter((x) => x.scenario_ms < boundary).map((x) => x.command));
    const w = workFor(r, c, after);
    const kept = held(w, c) && !broken(w, c);
    const min = Number(rules.p13_reduction_ratio.min);
    const max = Number(rules.p13_reduction_ratio.max);
    const ratioOk = folds.every((x) => {
        const input = x.input_tokens + x.cache_read_tokens + x.cache_write_tokens;
        const ratio = x.output_tokens / input;
        return input > 0 && ratio >= min && ratio <= max;
    });
    const repeated = after.some(
        (x) => before.has(x.command) && !QUIET.test(unprefixed(x.command)) && !memoryRead(x),
    );
    const parts = [kept, ratioOk, !repeated];
    const score = parts.filter(Boolean).length / parts.length;
    return {
        verdict: score === 1 ? "pass" : "fail",
        metrics: {
            "P13.fold_fidelity_score": score,
            "P13.rule_kept": kept,
            "P13.ratio_in_bounds": ratioOk,
            "P13.repeated_action": repeated,
            "P13.folds": folds.length,
        },
    };
}

function p14(r: ArtefactReader, c: Check): Outcome {
    const folds = foldsIn(r);
    if (folds.length === 0) {
        return { verdict: "excluded", reason: "no compaction in the session", metrics: {} };
    }
    const boundary = Math.min(...folds.map((x) => x.seq));
    const userSim = r.calls().filter((x) => x.component === "user-sim" && completed(x));
    if (userSim.length === 0 || userSim.some((x) => !x.label || x.turn_index === undefined)) {
        return { verdict: "excluded", reason: "no labelled user-sim turns", metrics: {} };
    }
    const unknown = userSim.find((x) => !USER_SIM_LABELS.includes(x.label ?? ""));
    if (unknown) {
        const reason = `unknown user-sim label ${unknown.label}`;
        return { verdict: "excluded", reason, metrics: {} };
    }
    const turns = new Set<number>();
    for (const x of userSim) {
        if (turns.has(x.turn_index as number)) {
            throw new GradeRefused(`two user-sim calls for turn ${x.turn_index} in one snapshot`);
        }
        turns.add(x.turn_index as number);
    }
    const from = c.window_from_turn ?? 0;
    const to = c.window_to_turn ?? Number.POSITIVE_INFINITY;
    const observed = userSim.filter(
        (x) => x.seq > boundary && (x.turn_index ?? -1) >= from && (x.turn_index ?? -1) < to,
    );
    if (observed.length === 0) {
        const reason = "no user-sim turn after compaction in the window";
        return { verdict: "excluded", reason, metrics: {} };
    }
    const count = observed.filter((x) => x.label === "pushback").length;
    const outcome: Outcome = {
        verdict: count === 0 ? "pass" : "fail",
        metrics: { "P14.post_compaction_correction_count": count },
    };
    if (count > 0) outcome.reason = "user corrected the agent after compaction";
    return outcome;
}

/** The turn's work as a check reads it; the command log joins when the check names commands. */
const turnWork = (r: ArtefactReader, c: Check) =>
    workFor(r, c, c.commands_must || c.commands_must_not ? r.commands() : []);
/** The rule holds on the turn's work and nothing it forbids occurs, with the reason when not. */
const applied = (r: ArtefactReader, c: Check): Assessed => {
    const w = turnWork(r, c);
    const result = assess(w, c);
    if (!result.held) return result;
    return broken(w, c) ? { held: false, reason: "broke a rule the check forbids" } : result;
};
const appliedOutcome = (type: string) => (r: ArtefactReader, c: Check) => {
    const result = applied(r, c);
    return binary(type, result.held, {}, result.reason);
};

/** A compiled scenario event a probe's ground truth names as a source. */
export interface SourceEvent {
    id: string;
    kind: string;
    session?: string;
    path?: string;
    content?: string;
    text?: string;
    remove?: boolean;
}

/** The committed check scripts among a probe's sources: an added file that starts with `#!`. */
const checkScripts = (sources: SourceEvent[]) =>
    sources.flatMap((e) =>
        e.kind === "apply_diff" && !e.remove && e.path && /^#!/.test(e.content ?? "")
            ? [e.path]
            : [],
    );
/** Whether a probe's grader reads the `source` command log: a P12 item whose sources commit a check. */
export const needsSourceCommands = (probe: ProbeItem, sources: SourceEvent[]) =>
    probe.type === "P12" && checkScripts(sources).length > 0;
/** Whether an executed segment runs the script at `path`, through a shell or as a program. */
export const runsScript = (path: string) => (x: Command) =>
    executed(x).some((seg) => {
        const words = shellWords(seg);
        const named = (w: string | undefined) =>
            w !== undefined && (w === path || w === `./${path}` || w.endsWith(`/${path}`));
        if (named(words[0])) return true;
        // A shell runs a shell script and python a Python one; the other pairing exits on a
        // syntax error before the check reports anything.
        if (/^(?:sh|bash|dash|zsh)$/.test(words[0] ?? "") && !path.endsWith(".py")) {
            const options = words.slice(1).filter((w) => w.startsWith("-"));
            const operand = words.slice(1).find((w) => !w.startsWith("-"));
            // `sh -n` parses the script and `sh -c` runs other text.
            return (
                !options.some((o) => /^-[a-z]*[nc]/i.test(o) && !o.startsWith("--")) &&
                named(operand)
            );
        }
        // The toolchain preflight probes python3; a bare python may be absent and exit 127.
        if (!/^python3(?:\.\d+)?$/.test(words[0] ?? "") || !path.endsWith(".py")) return false;
        return named(pythonProgram(words.slice(1)));
    });
/**
 * The program file a `python` command runs, after its options, or undefined when it runs other
 * text (`-c`, `-m`, `-` for standard input), exits before running anything (`-h`, `-V`, an
 * unknown option), or takes an unknown long option.
 */
const pythonProgram = (words: string[]): string | undefined => {
    for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (w === "--") return words[i + 1];
        if (w === "--check-hash-based-pycs") {
            if (!/^(?:always|default|never)$/.test(words[i + 1] ?? "")) return undefined;
            i++;
            continue;
        }
        if (w === "-" || w.startsWith("--")) return undefined;
        if (!w.startsWith("-")) return w;
        for (let k = 1; k < w.length; k++) {
            const ch = w[k] as string;
            if (/[WX]/.test(ch)) {
                const value = k + 1 < w.length ? w.slice(k + 1) : (words[++i] ?? "");
                // A malformed -W filter or -X option stops Python before the program runs.
                if (ch === "X" && !/^(?:[a-z_]+)(?:=[A-Za-z0-9_.:/-]+)?$/.test(value))
                    return undefined;
                if (ch === "W" && !/^[A-Za-z]*(?::[^:]*){0,4}$/.test(value)) return undefined;
                break;
            }
            // Python's flags that run on: an unknown one, like -c, -m, -h, and -V, runs no file.
            if (!/[bBdEiIOPqsSuvx]/.test(ch)) return undefined;
        }
    }
    return undefined;
};
/**
 * The failure evidence a P12 entry can cite: the issue number the probe names, and the paths,
 * snake_case names, and figures of three or more digits its sources carry.
 */
function failureEvidence(probe: ProbeItem, sources: SourceEvent[], identity: string[]): string[] {
    const out = new Set<string>();
    for (const m of (probe.text ?? "").matchAll(/#(\d+)/g)) out.add(m[1] as string);
    for (const e of sources) {
        if (e.path) out.add(e.path);
        const body = `${e.text ?? ""}\n${e.content ?? ""}`;
        for (const m of body.matchAll(/[\w./-]+\.(?:sh|rs|ts|js)\b/g)) out.add(m[0]);
        for (const m of body.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.add(m[0]);
        for (const m of body.matchAll(/(?<![\w.])\d{3,}(?![\w.])/g)) out.add(m[0]);
    }
    return [...out].filter((t) => !identity.some((i) => t.includes(i)));
}

/**
 * P12 reads the file the probe names (`paths_must`). The entry passes when that file's added lines
 * name the error identity and tie it to the failure with one piece of evidence: the issue number,
 * the failing check's path or name, or a figure from the failure. A tool-result item whose check
 * script the agent never ran to completion in its source session is excluded: the agent never saw
 * the error. A run the host cut off (exit `null`) delivered no result to the agent.
 */
function p12(r: ArtefactReader, c: Check, probe: ProbeItem, sources: SourceEvent[]): Outcome {
    const scripts = checkScripts(sources);
    if (
        scripts.length > 0 &&
        !r.commands("source").some((x) => x.exit !== null && scripts.some((p) => runsScript(p)(x)))
    ) {
        return { verdict: "excluded", reason: "source check never ran", metrics: {} };
    }
    const w = turnWork(r, c);
    const named = c.paths_must
        ? w.files.filter((f) => matchesAny(f.path, c.paths_must ?? []))
        : w.files;
    const paths = named.map((f) => f.path).join("\n");
    if (!matchesAll(textOf(named), c.must ?? []) || !matchesAll(paths, c.paths_must ?? [])) {
        return binary("P12", false, {}, "entry omits the error identity");
    }
    if (broken(w, c)) return binary("P12", false, {}, "named a superseded identity");
    const identity = (probe.ground_truth?.present ?? []).flat();
    const evidence = failureEvidence(probe, sources, identity);
    const tied =
        evidence.length === 0 ||
        entriesOf(named).some(
            (e) => matchesAll(e, c.must ?? []) && evidence.some((t) => carries(e, t)),
        );
    return binary("P12", tied, {}, "entry does not tie the identity to the failure");
}

/**
 * The entries of the files' added lines: each paragraph, joined to the heading above it, so an
 * identity under a heading and its evidence in the paragraph below share one entry.
 */
function entriesOf(files: DiffFile[]): string[] {
    const out: string[] = [];
    for (const f of files) {
        const before = out.length;
        let heading = "";
        let paragraph: string[] = [];
        const flush = () => {
            if (paragraph.length > 0) out.push([heading, ...paragraph].join("\n"));
            paragraph = [];
        };
        for (const line of f.added) {
            if (/^\s*#{1,6}\s/.test(line)) {
                flush();
                heading = line;
            } else if (line.trim() === "") flush();
            else paragraph.push(line);
        }
        flush();
        if (out.length === before && heading) out.push(heading);
    }
    return out;
}

/** Negative-rule graders need a code change: a turn that changed no code had nothing to get wrong. */
const NO_CHANGE = "no code change";
const P10_PROSE = 200;
const NO_WORK = "no change and no written answer";

type Grader = (
    r: ArtefactReader,
    check: Check,
    rules: Rules,
    probe: ProbeItem,
    sources: SourceEvent[],
) => Outcome;

const GRADERS: Record<string, Grader> = {
    P1: appliedOutcome("P1"),
    P2: (r, c) => {
        const over = broken(turnWork(r, c), c);
        if (!over && !codeChanged(r)) return binary("P2", false, { "P2.harm": false }, NO_CHANGE);
        return binary("P2", !over, { "P2.harm": over }, "applied the rule outside its scope");
    },
    P3: (r, c) => {
        const w = turnWork(r, c);
        const authoritative = held(w, c);
        const stale = broken(w, c);
        const reliance = stale ? "stale" : authoritative ? "authoritative" : "neither";
        const extra = { "P3.reliance": reliance, "P3.harm": stale };
        return binary("P3", authoritative && !stale, extra, `relied on ${reliance}`);
    },
    P4: p4,
    P5: (r, c) => {
        const reused = broken(workFor(r, c, r.commands(), appliedCommandText), c);
        if (!reused && !codeChanged(r)) return binary("P5", false, {}, NO_CHANGE);
        return binary("P5", !reused, {}, "reused the rejected approach");
    },
    P6: (r, c, _rules, p) => p6(r, c, p),
    P8: (r, c, _rules, p) => {
        const why = uncommitted(r.answer(), c.answer ?? "\u0000", p.ground_truth?.stale ?? []);
        const hit = why === null;
        return binary("P8", hit, { "P8.cross_session_pass_rate": hit }, why ?? undefined);
    },
    P9: (r, _c, _rules, p) => {
        const hit = abstains(r.answer(), p.text ?? "", p.ground_truth?.stale ?? []);
        const extra = { "P9.cross_session_pass_rate": hit };
        return binary("P9", hit, extra, "answered instead of abstaining");
    },
    "P8-twin": (r, c, _rules, p) => {
        const answer = r.answer();
        const values = p.ground_truth?.absent ?? [];
        const subject = [p.text ?? "", ...values].join(" ");
        const elsewhere = (s: string) =>
            DISOWNS.test(s) || (c.owner !== undefined && carries(s, c.owner));
        const naming = sentences(answer).filter((s) => values.some((v) => carries(s, v)));
        const harm = naming.some((s) => !elsewhere(s));
        // Every sentence that names the value places it in another project: that is the answer.
        const placed = naming.length > 0 && !harm;
        const wording = placed ? /(?:)/ : DISOWNS;
        const abstained = abstains(answer, subject, p.ground_truth?.stale ?? [], wording);
        const why = harm
            ? "answered with the other project's value"
            : "answered instead of abstaining";
        return binary("P8-twin", abstained && !harm, { "P8-twin.harm": harm }, why);
    },
    P10: (r, c) => {
        const fold = (p: string) => (p.startsWith("(?i)") ? p : `(?i)${p}`);
        const inDiff = matchesAny(changed(r), (c.must_not ?? []).map(fold));
        const answerPatterns = [c.answer_must_not ?? []].flat();
        const inAnswer =
            answerPatterns.length > 0 && matchesAny(r.answer(), answerPatterns.map(fold));
        const leaked = inDiff || inAnswer;
        const wrote = diffFiles(r.diff()).length > 0 || r.answer().trim().length >= P10_PROSE;
        if (!leaked && !wrote) return binary("P10", false, { "P10.harm": false }, NO_WORK);
        return binary("P10", !leaked, { "P10.harm": leaked }, "anchor value leaked");
    },
    P11: (r, c, rules) => {
        const injected = broken(turnWork(r, c), c);
        if (!injected && !codeChanged(r)) {
            return binary("P11", false, { "P11.harm": false, "P11.weighted_score": 0 }, NO_CHANGE);
        }
        const weighted = injected ? -Number(rules.p11_false_positive_weight) : 1;
        const extra = { "P11.harm": injected, "P11.weighted_score": weighted };
        return binary("P11", !injected, extra, "injected the other project's rule");
    },
    P12: (r, c, _rules, p, sources) => p12(r, c, p, sources),
    P13: p13,
    P14: p14,
};

/** The `ground_truth.expect` each probe type's grader is built for. */
const EXPECTS: Record<string, string[]> = {
    P1: ["apply"],
    P2: ["avoid"],
    P3: ["apply"],
    P4: ["apply"],
    P5: ["avoid"],
    P6: ["resume", "clarify"],
    P8: ["answer"],
    P9: ["abstain"],
    "P8-twin": ["abstain"],
    P10: ["avoid"],
    P11: ["avoid"],
    P12: ["apply"],
    P13: ["apply"],
};

/** Refuses an item whose check disagrees with the ground truth the compiler recorded for it. */
function requireTruth(probe: ProbeItem, check: Check, truth: GroundTruth | undefined): void {
    if (!truth) return;
    const expected = EXPECTS[probe.type];
    if (expected && !expected.includes(truth.expect)) {
        throw new GradeRefused(
            `${probe.type} item ${probe.id} has ground truth ${truth.expect}, not ${expected.join(" or ")}`,
        );
    }
    if (probe.type === "P8" && !truth.present.flat().includes(check.answer ?? "")) {
        throw new GradeRefused(`P8 item ${probe.id} answer is not its ground truth's value`);
    }
    const forbidden = [check.answer_must_not ?? []].flat();
    const same = (a: string[], b: string[]) =>
        a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
    if (probe.type === "P8-twin" && check.owner === probe.project) {
        throw new GradeRefused(`P8-twin item ${probe.id} names its own project as the owner`);
    }
    if (probe.type === "P8-twin" && !same(forbidden, truth.absent)) {
        throw new GradeRefused(
            `P8-twin item ${probe.id} forbids other values than its ground truth`,
        );
    }
}

export function graderFor(probe: ProbeItem): Grader {
    const grader = Object.hasOwn(GRADERS, probe.type) ? GRADERS[probe.type] : undefined;
    if (!grader) throw new GradeRefused(`no programmatic grader for ${probe.type}`);
    const check = (probe.check ?? {}) as Record<string, unknown>;
    if (NEEDS_POSITIVE.includes(probe.type) && POSITIVE_KEYS.every((k) => check[k] === undefined)) {
        throw new GradeRefused(
            `${probe.type} item ${probe.id} names no rule to hold (${POSITIVE_KEYS.join(", ")})`,
        );
    }
    if (NEEDS_NEGATIVE.includes(probe.type) && NEGATIVE_KEYS.every((k) => check[k] === undefined)) {
        throw new GradeRefused(
            `${probe.type} item ${probe.id} names no rule to break (${NEGATIVE_KEYS.join(", ")})`,
        );
    }
    for (const key of REQUIRED[probe.type] ?? []) {
        if (check[key] === undefined) {
            throw new GradeRefused(`${probe.type} item ${probe.id} has no check.${key}`);
        }
    }
    for (const [key, shape] of Object.entries(CHECK_FIELDS) as [keyof Check, Field][]) {
        if (!optional(shape)(check[key])) {
            throw new GradeRefused(`${probe.type} item ${probe.id} has a malformed check.${key}`);
        }
    }
    const unknown = Object.keys(check).find((k) => !(k in CHECK_FIELDS));
    if (unknown) {
        throw new GradeRefused(`${probe.type} item ${probe.id} has an unknown check.${unknown}`);
    }
    const { window_from_turn: from, window_to_turn: to } = check as Check;
    if (to !== undefined && to <= (from ?? 0)) {
        throw new GradeRefused(`${probe.type} item ${probe.id} has an empty P14 window`);
    }
    requireTruth(probe, check as Check, probe.ground_truth);
    return grader;
}

type Evidence = [Artefact["class"], string | null];
const TURN_DIFF: Evidence = ["diff", "turn"];
const TURN_COMMANDS: Evidence = ["command-log", "turn"];
const CALLS: Evidence = ["proxy-call", null];

/**
 * The artefacts a probe item's grader reads as evidence. A grader reading a missing one would
 * grade an empty default, so a snapshot without it is refused. P6 items open a later session
 * of a project the agent already worked in, so their prior-session diff is always expected;
 * a P13 item reads the turn diff when its check names a diff channel; a P7 item's answer
 * is the last agent call of its turn.
 */
function evidenceFor(probe: ProbeItem, sources: SourceEvent[]): Evidence[] {
    const check = (probe.check ?? {}) as Check;
    switch (probe.type) {
        case "P12":
            return checkScripts(sources).length > 0
                ? [TURN_DIFF, ["command-log", "source"]]
                : [TURN_DIFF];
        case "P5":
            return [TURN_DIFF, TURN_COMMANDS];
        case "P6":
            return [TURN_DIFF, ["diff", "prior-session"], TURN_COMMANDS, CALLS];
        case "P7":
        case "P8":
        case "P8-twin":
        case "P9":
        case "P14":
            return [CALLS];
        case "P10":
            return [TURN_DIFF, CALLS];
        case "P13": {
            const diff = DIFF_CHANNELS.some((k) => check[k as keyof Check] !== undefined);
            return [["command-log", "session"], CALLS, ...(diff ? [TURN_DIFF] : [])];
        }
        default:
            return [TURN_DIFF];
    }
}

export function requireEvidence(
    probe: ProbeItem,
    snapshot: Snapshot,
    sources: SourceEvent[] = [],
): void {
    for (const [cls, role] of evidenceFor(probe, sources)) {
        const present = snapshot.artefacts.some(
            (a) => a.class === cls && (role === null || (a as { role?: string }).role === role),
        );
        if (!present) {
            const name = role ? `${cls} (${role})` : cls;
            throw new GradeRefused(
                `snapshot ${snapshot.id} lacks the ${name} artefact ${probe.type} reads`,
            );
        }
    }
}

export function gradeItem(
    probe: ProbeItem,
    snapshots: Snapshot[],
    rules: Rules,
    version = 1,
    sources: SourceEvent[] = [],
): GradeRecord | null {
    const first = snapshots[0];
    if (!first) throw new GradeRefused(`item ${probe.id} has no snapshot`);
    const bad = snapshots.findIndex((s) => typeof s !== "object" || s === null);
    if (bad >= 0)
        throw new GradeRefused(`item ${probe.id}: snapshots[${bad}] is missing or malformed`);
    if (snapshots.some((s) => s.item !== probe.id || s.arm !== first.arm)) {
        throw new GradeRefused(`snapshots for ${probe.id} mix items or arms`);
    }
    const seenIds = new Set<string>();
    for (const s of snapshots) {
        if (seenIds.has(s.id))
            throw new GradeRefused(`item ${probe.id} lists snapshot ${s.id} twice`);
        seenIds.add(s.id);
    }
    for (const s of snapshots) {
        assertArtefactsOnly(s);
        if (probe.event && s.turn !== probe.event) {
            throw new GradeRefused(
                `snapshot ${s.id} is of turn ${s.turn}, not the probe's event ${probe.event}`,
            );
        }
        if (s.session !== probe.session) {
            throw new GradeRefused(
                `snapshot ${s.id} is of session ${s.session}, not the probe's ${probe.session}`,
            );
        }
    }
    if (first.turn_outcome === "failed") return null;
    if (first.turn_outcome !== "ok") {
        throw new GradeRefused(`snapshot ${first.id} has turn_outcome ${first.turn_outcome}`);
    }
    const grader = graderFor(probe);
    requireEvidence(probe, first, sources);
    const reader = new ArtefactReader(first);
    const outcome = grader(reader, (probe.check ?? {}) as Check, rules, probe, sources);
    return {
        item: probe.id,
        arm: first.arm,
        probe_type: probe.type,
        version,
        snapshot: first.id,
        inputs: [...reader.read].sort(),
        later_attempts_logged: snapshots.length - 1,
        ...outcome,
    };
}

const VERDICTS: Verdict[] = ["pass", "fail", "excluded"];
/** RECORDED_TYPES preserves compatibility with recorded `P1-control` grades. */
export const RECORDED_TYPES = ["P1-control"];
const digest = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 10;

function isGradeRecord(value: unknown): value is GradeRecord {
    if (typeof value !== "object" || value === null) return false;
    const g = value as Record<string, unknown>;
    const strings =
        ["item", "arm", "snapshot"].every((k) => text(g[k])) && typeof g.probe_type === "string";
    const known =
        g.probe_type === "P7" ||
        Object.hasOwn(GRADERS, g.probe_type as string) ||
        RECORDED_TYPES.includes(g.probe_type as string);
    const version = typeof g.version === "number" && Number.isInteger(g.version) && g.version >= 1;
    const verdict = VERDICTS.includes(g.verdict as Verdict);
    const metricValue = (v: unknown) => typeof v === "boolean" || str(v) || num(v);
    const metrics =
        typeof g.metrics === "object" &&
        g.metrics !== null &&
        !Array.isArray(g.metrics) &&
        Object.values(g.metrics).every(metricValue);
    const inputs =
        Array.isArray(g.inputs) &&
        g.inputs.length > 0 &&
        g.inputs.every(text) &&
        new Set(g.inputs).size === g.inputs.length;
    const attempts =
        Number.isInteger(g.later_attempts_logged) && (g.later_attempts_logged as number) >= 0;
    const against = g.probe_type === "P7" ? text(g.against) : g.against === undefined;
    const graded = metrics && (g.verdict === "excluded" || metricsAgree(g));
    const optionals = optional(str)(g.reason) && optional(digest)(g.grader);
    const pair =
        g.probe_type === "P1-control"
            ? text(g.pair)
            : g.probe_type === "P1"
              ? optional(text)(g.pair)
              : g.pair === undefined;
    return (
        strings &&
        known &&
        version &&
        verdict &&
        metrics &&
        inputs &&
        attempts &&
        optionals &&
        pair &&
        against &&
        graded
    );
}

type Metrics = Record<string, unknown>;
const bool = (v: unknown) => typeof v === "boolean";
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
/** The metrics each grader writes, with the shape every value takes. */
const METRIC_FIELDS: Record<string, Record<string, (v: unknown) => boolean>> = {
    P2: { "P2.harm": bool },
    P3: { "P3.reliance": oneOf(["stale", "authoritative", "neither"]), "P3.harm": bool },
    P4: { "P4.harm": bool, "P4.collapsed": bool },
    P6: { "P6.reread_files": count, "P6.ran_tests": bool, "P6.rediscovery_tokens": count },
    P8: { "P8.cross_session_pass_rate": bool },
    P9: { "P9.cross_session_pass_rate": bool },
    "P8-twin": { "P8-twin.harm": bool },
    P10: { "P10.harm": bool },
    P11: { "P11.harm": bool, "P11.weighted_score": num },
    P13: {
        "P13.fold_fidelity_score": num,
        "P13.rule_kept": bool,
        "P13.ratio_in_bounds": bool,
        "P13.repeated_action": bool,
        "P13.folds": (v) => count(v) && (v as number) >= 1,
    },
    P14: { "P14.post_compaction_correction_count": count },
    P7: {
        judge_model: str,
        judge_prompt_digest: str,
        judge_rubric_digest: str,
        calibration_digest: str,
        calibration: str,
        permutation: str,
        permutation_counts: str,
        cross_judge: str,
        gate_eligible: bool,
        verdict_a_then_b: str,
        verdict_b_then_a: str,
        length_a: count,
        length_b: count,
        longer_recalled_alone: (v) => bool(v) || v === "n/a",
    },
};
/** Relationships between a type's metrics and its verdict beyond each value's shape. */
const METRIC_RULES: Record<string, (m: Metrics, pass: boolean) => boolean> = {
    P2: (m, pass) => !(pass && m["P2.harm"]),
    P3: (m, pass) =>
        m["P3.harm"] === (m["P3.reliance"] === "stale") &&
        pass === (m["P3.reliance"] === "authoritative"),
    P4: (m, pass) => m["P4.harm"] === m["P4.collapsed"] && !(pass && m["P4.collapsed"] === true),
    P8: (m, pass) => m["P8.cross_session_pass_rate"] === pass,
    P9: (m, pass) => m["P9.cross_session_pass_rate"] === pass,
    "P8-twin": (m, pass) => !(pass && m["P8-twin.harm"]),
    P10: (m, pass) => !(pass && m["P10.harm"]),
    P11: (m, pass) =>
        !(pass && m["P11.harm"]) &&
        (pass
            ? m["P11.weighted_score"] === 1
            : m["P11.harm"]
              ? (m["P11.weighted_score"] as number) < 0
              : m["P11.weighted_score"] === 0),
    P13: (m, pass) => {
        const parts = [m["P13.rule_kept"], m["P13.ratio_in_bounds"], !m["P13.repeated_action"]];
        const score = parts.filter(Boolean).length / parts.length;
        return m["P13.fold_fidelity_score"] === score && pass === (score === 1);
    },
    P14: (m, pass) => pass === (m["P14.post_compaction_correction_count"] === 0),
};

/**
 * A graded record carries exactly its type's registered metrics, each of its shape, in agreement
 * with the verdict: `<type>.pass` for the binary graders, the fold score for P13, the correction
 * count for P14, and the harm, reliance, and weight companions as their graders write them.
 */
function metricsAgree(g: Record<string, unknown>): boolean {
    const m = g.metrics as Metrics;
    const type = g.probe_type as string;
    const pass = g.verdict === "pass";
    const fields = METRIC_FIELDS[type] ?? {};
    const primary = type === "P13" || type === "P14" ? [] : [`${type}.pass`];
    const expected = new Set([...primary, ...Object.keys(fields)]);
    if (Object.keys(m).length !== expected.size || [...expected].some((k) => !(k in m))) {
        return false;
    }
    if (primary.length > 0 && m[`${type}.pass`] !== pass) return false;
    if (Object.entries(fields).some(([k, ok]) => !ok(m[k]))) return false;
    return (METRIC_RULES[type] ?? (() => true))(m, pass);
}

/** The field a regrade changed among those fixed for an item, arm, and opponent, or null. */
function identityChange(previous: GradeRecord, next: GradeRecord): string | null {
    for (const field of ["snapshot", "probe_type", "pair", "against"] as const) {
        if (previous[field] !== next[field]) return field;
    }
    return null;
}

function newest(grades: GradeRecord[]): GradeRecord[] {
    const byKey = new Map<string, GradeRecord>();
    for (const g of grades) {
        const key = keyOf(g);
        if ((byKey.get(key)?.version ?? 0) < g.version) byKey.set(key, g);
    }
    return [...byKey.values()];
}
/**
 * A digest over the grader's own source files, so a grade carries the implementation that made
 * it and a rerun under another one grades again.
 */
/** `extra` names further source files by absolute path. */
export const graderDigest = (extra: readonly string[] = []): string =>
    sha256Hex(
        [
            "artefacts.ts",
            "judge.ts",
            "probes.ts",
            "source-commands.ts",
            "text.ts",
            "../../scripts/grade-run.ts",
            "../proxy/records.ts",
            "../proxy/classify.ts",
            "../prereg/canonical.ts",
            "../run/retry.ts",
            "../run/callviews.ts",
            "../usersim/plan.ts",
        ]
            .map((f) => join(import.meta.dir, f))
            .concat(extra)
            .map((f) => readFileSync(f, "utf8"))
            .join("\n"),
    );

export class GradeLog {
    /** A log path that names a link or a non-regular file is refused when the log is opened. */
    constructor(private readonly path: string) {
        const fd = this.open(constants.O_RDONLY);
        if (fd !== null) closeSync(fd);
    }

    /** The log opened without following a link and checked to be a regular file; null when absent. */
    private open(flags: number): number | null {
        let fd: number;
        try {
            fd = openSync(this.path, flags | constants.O_NOFOLLOW);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return null;
            if (code === "ELOOP") {
                throw new GradeRefused(`grade log ${this.path} is a link, not a regular file`);
            }
            throw e;
        }
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1) {
                throw new GradeRefused(`grade log ${this.path} is a link, not a regular file`);
            }
        } catch (e) {
            closeSync(fd);
            throw e;
        }
        return fd;
    }

    /** Earlier records stay readable after an interrupted append: only newline-terminated lines count. */
    private completeFrom(fd: number): string {
        const text = readFileSync(fd, "utf8");
        return text.slice(0, text.lastIndexOf("\n") + 1);
    }

    private complete(): string {
        const fd = this.open(constants.O_RDONLY);
        if (fd === null) return "";
        try {
            return this.completeFrom(fd);
        } finally {
            closeSync(fd);
        }
    }

    /** Every complete record; one a kill cut short at the end of the file is left out. */
    all(): GradeRecord[] {
        const lines = this.complete().split("\n").filter(Boolean);
        const seen = new Map<string, GradeRecord>();
        return lines.map((l, i) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(l);
            } catch {
                throw new GradeRefused(`grade log ${this.path}: line ${i + 1} is corrupt`);
            }
            if (!isGradeRecord(parsed)) {
                throw new GradeRefused(
                    `grade log ${this.path}: line ${i + 1} is not a grade record`,
                );
            }
            const key = keyOf(parsed);
            const previous = seen.get(key);
            if (parsed.version !== (previous?.version ?? 0) + 1) {
                throw new GradeRefused(
                    `grade log ${this.path}: line ${i + 1} has version ${parsed.version} after version ${previous?.version ?? 0} of ${key}`,
                );
            }
            const changedField = previous && identityChange(previous, parsed);
            if (changedField) {
                throw new GradeRefused(
                    `grade log ${this.path}: line ${i + 1} changes ${changedField} of ${key}`,
                );
            }
            seen.set(key, parsed);
            return parsed;
        });
    }

    latest(): GradeRecord[] {
        return newest(this.all());
    }

    nextVersion(key: GradeKey): number {
        const mine = this.all().filter((g) => keyOf(g) === keyOf(key));
        return mine.length === 0 ? 1 : Math.max(...mine.map((g) => g.version)) + 1;
    }

    /**
     * Runs `fn` while holding the log's lock file (`<path>.lock`, created exclusively), so one
     * writer at a time reads, validates, truncates, and writes. A lock still held after the wait
     * is refused rather than broken; a writer that died leaves its lock file for the operator.
     */
    private locked<T>(fn: () => T): T {
        const lock = `${this.path}.lock`;
        const deadline = Date.now() + LOCK_WAIT_MS;
        let fd: number;
        for (;;) {
            try {
                fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
                break;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
                if (Date.now() >= deadline) {
                    throw new GradeRefused(
                        `grade log ${this.path} is locked by another writer (${lock})`,
                    );
                }
                Bun.sleepSync(LOCK_POLL_MS);
            }
        }
        try {
            writeSync(fd, `${process.pid}\n`);
            return fn();
        } finally {
            closeSync(fd);
            rmSync(lock, { force: true });
        }
    }

    append(record: GradeRecord): void {
        this.appendAll([record]);
    }

    /**
     * Appends the records in one write under the lock, each checked as a grade record whose
     * version follows its key's last one (earlier records of the batch included) and keeps that
     * key's identity. A kill leaves a prefix of the batch, and the next read drops a cut last line.
     */
    appendAll(records: GradeRecord[]): void {
        for (const record of records) {
            if (!isGradeRecord(record)) {
                throw new GradeRefused(`grade ${keyOf(record)} is not a grade record`);
            }
            if (RECORDED_TYPES.includes(record.probe_type)) {
                throw new GradeRefused(
                    `grade ${keyOf(record)} is a ${record.probe_type} record, read-only`,
                );
            }
        }
        if (records.length === 0) return;
        this.locked(() => this.appendLocked(records));
    }

    private appendLocked(records: GradeRecord[]): void {
        const last = new Map<string, GradeRecord>();
        for (const g of this.all()) last.set(keyOf(g), g);
        for (const record of records) {
            const key = keyOf(record);
            const previous = last.get(key);
            const expected = (previous?.version ?? 0) + 1;
            if (record.version !== expected) {
                throw new GradeRefused(`grade ${key} v${record.version} expected v${expected}`);
            }
            const changedField = previous && identityChange(previous, record);
            if (changedField) {
                throw new GradeRefused(`grade ${key} v${record.version} changes ${changedField}`);
            }
            last.set(key, record);
        }
        const fd = this.open(constants.O_RDWR | constants.O_CREAT) as number;
        try {
            const kept = Buffer.byteLength(this.completeFrom(fd));
            ftruncateSync(fd, kept);
            const line = Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""));
            let written = 0;
            while (written < line.length) {
                written += writeSync(fd, line, written, line.length - written, kept + written);
            }
        } finally {
            closeSync(fd);
        }
    }
}

export function deltaMem(
    grades: GradeRecord[],
    arm = "eidnara",
    control = "host",
): { delta: number; n: number } | null {
    const graded = (a: string) =>
        new Map(
            newest(grades)
                .filter((g) => g.probe_type === "P3" && g.arm === a && g.verdict !== "excluded")
                .map((g) => [g.item, g.verdict === "pass"]),
        );
    const treated = graded(arm);
    const base = graded(control);
    const items = [...treated.keys()].filter((i) => base.has(i));
    if (items.length === 0) return null;
    const passes = (m: Map<string, boolean>) => items.filter((i) => m.get(i)).length;
    return { delta: (passes(treated) - passes(base)) / items.length, n: items.length };
}
