import {
    closeSync,
    constants,
    fstatSync,
    ftruncateSync,
    openSync,
    readFileSync,
    writeSync,
} from "node:fs";
import type { Preregistration } from "../prereg/schema";
import type { ProbeItem } from "../scenario/compile";
import {
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
    diffPaths,
    matchesAll,
    matchesAny,
    pattern,
    survivingPaths,
} from "./text";

export type Rules = Preregistration["grading"];
export type Verdict = "pass" | "fail" | "excluded";

export interface Check {
    must?: string[];
    must_not?: string[];
    commands_must?: string[];
    answer?: string;
    answer_must_not?: string | string[];
    abstain?: boolean;
    scope?: "in" | "out";
    window_from_turn?: number;
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
    pair?: string;
}

const READS = /^(cat|less|more|head|tail|sed|view|bat|grep|rg|read)\b/;
/** `cargo [+toolchain] [OPTIONS]` ahead of the subcommand: the toolchain selector and Cargo's global options. */
const CARGO =
    "cargo(?: \\+\\S+)?(?: (?:-[vq]+|--verbose|--quiet|--locked|--offline|--frozen|--color(?:=\\S+| \\S+)|-C ?\\S+|--config(?:=\\S+| \\S+)|-Z ?\\S+))*";
const TESTS = new RegExp(`^(${CARGO} (test|t)|(bun|npm|pnpm) (run )?test)\\b`);
const QUIET = new RegExp(
    `^\\s*(${CARGO} (build|check|test|b|c|t)|(bun|npm|pnpm) (install|i|ci|(run )?(test|build))|git (status|log|diff)|ls|pwd)\\b[^&|;\`$()\\n]*$`,
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
    answer_must_not: (v: unknown) => compiles(v) || patternList(v),
    abstain: (v: unknown) => v === true,
    scope: oneOf(["in", "out"]),
    window_from_turn: (v: unknown) => Number.isInteger(v) && (v as number) >= 0,
    turns: (v: unknown) =>
        Array.isArray(v) &&
        v.length === 2 &&
        v.every((n) => Number.isInteger(n) && n >= 0) &&
        (v[0] as number) < (v[1] as number),
};

const REQUIRED: Record<string, (keyof Check)[]> = {
    P1: ["must"],
    "P1-control": ["must"],
    P2: ["must_not"],
    P3: ["must", "must_not"],
    P4: ["must", "must_not", "scope"],
    P5: ["must_not"],
    P6: ["must"],
    P8: ["answer"],
    P9: ["abstain"],
    P10: ["must_not", "answer_must_not"],
    P11: ["must_not"],
    P12: ["must"],
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

const commandText = (r: ArtefactReader) =>
    r
        .commands()
        .map((c) => c.command)
        .join("\n");
/** Changed paths join the added lines so a check pattern can match a file name. */
const changed = (r: ArtefactReader) => {
    const patch = r.diff();
    return `${survivingPaths(patch).join("\n")}\n${addedLines(patch)}`;
};
const work = (r: ArtefactReader) => `${changed(r)}\n${commandText(r)}`;

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
function splitShell(command: string): { op: string; seg: string }[] {
    const out: { op: string; seg: string }[] = [];
    let quote = "";
    let depth = 0;
    let seg = "";
    let op = ";";
    const pending: { delim: string; stripTabs: boolean }[] = [];
    const push = (next: string) => {
        out.push({ op, seg: seg.trim() });
        seg = "";
        op = next;
    };
    const skipBodies = (from: number): number => {
        let i = from;
        while (pending.length > 0 && i < command.length) {
            const end = command.indexOf("\n", i);
            const raw = command.slice(i, end < 0 ? command.length : end);
            const head = pending[0] as { delim: string; stripTabs: boolean };
            const line = head.stripTabs ? raw.replace(/^\t+/, "") : raw;
            if (line === head.delim) pending.shift();
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
            const m = /^<<(-?)\s*(?:(['"])((?:(?!\2).)+)\2|([^\s'"<>|&;()]+))/.exec(
                command.slice(i),
            );
            if (m) {
                const delim = ((m[3] ?? m[4]) as string).replace(/\\(.)/g, "$1");
                pending.push({ delim, stripTabs: m[1] === "-" });
                seg += m[0];
                i += m[0].length - 1;
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
    out.push({ op, seg: seg.trim() });
    return out.filter((x) => x.seg.length > 0);
}

/** The exit code belongs to the last list of a command, so only an `&&` segment there is established by it. */
const executed = (x: Command): string[] => {
    const parts = splitShell(x.command);
    let guard = ";";
    const guarded = parts.map((p) => {
        guard = p.op === "|" ? guard : p.op;
        return { seg: p.seg, op: guard };
    });
    const lastList = guarded.reduce((n, p, i) => (/^[;&\n]$/.test(p.op) ? i : n), 0);
    const mixed = guarded.slice(lastList).some((p) => p.op === "||");
    const firstListEnd = guarded.findIndex((p, i) => i > 0 && /^[;&\n]$/.test(p.op));
    const exitAt = guarded.findIndex((p, i) => {
        const own = (parts[i] as { op: string }).op;
        const next = parts[i + 1]?.op ?? ";";
        const foreground = own !== "|" && next !== "|" && next !== "&";
        return (
            /^[;&\n]$/.test(p.op) &&
            foreground &&
            /^(exit|return)\b|^exec\s+[^\s<>&\d]/.test(unprefixed(p.seg))
        );
    });
    const afterExit = exitAt < 0 ? guarded.length : exitAt + 1;
    const unfinished = x.exit === null && firstListEnd >= 0 ? firstListEnd : guarded.length;
    const reached = Math.min(afterExit, unfinished);
    return guarded
        .slice(0, reached)
        .filter(
            (p, i) => p.op !== "||" && (p.op !== "&&" || (x.exit === 0 && i >= lastList && !mixed)),
        )
        .map((p) => unprefixed(p.seg));
};
/** Shell words of a segment, with quotes grouping and removed. */
const shellWords = (segment: string): string[] => {
    const words: string[] = [];
    let word = "";
    let quote = "";
    let open = false;
    let escaped = false;
    for (const ch of segment) {
        if (escaped) {
            word += ch;
            escaped = false;
        } else if (quote) {
            if (ch === quote) quote = "";
            else word += ch;
        } else if (ch === "\\") {
            escaped = true;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
            open = true;
        } else if (/\s/.test(ch)) {
            if (word.length > 0 || open) words.push(word);
            word = "";
            open = false;
        } else word += ch;
    }
    if (word.length > 0 || open) words.push(word);
    return words;
};
/** grep and rg options whose value is the next word, so that word is neither pattern nor file. */
const GREP_OPERAND_OPTIONS =
    /^(-[ABCmdDgtTEjM]|--(max-count|after-context|before-context|context|include|exclude|exclude-dir|glob|iglob|type|type-not|max-depth|threads|color|colour|devices|directories|label|encoding|pre|sort|sortr))$/;
/** rg's replacement text option; grep's `-r` is recursion and takes no value. */
const RG_OPERAND_OPTIONS = /^(-r|--replace)$/;
/**
 * A read segment's file operands. For grep and rg the pattern is the first non-option word unless
 * an option supplies it (`-e`, `--regexp`, `-f`, `--file`), in which case every positional word is a file.
 */
const operands = (segment: string): string[] => {
    const words = unredirectedWords(shellWords(segment));
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
        else if (GREP_OPERAND_OPTIONS.test(w) || (words[0] === "rg" && RG_OPERAND_OPTIONS.test(w)))
            i++;
        else if (!w.startsWith("-")) files.push(w);
    }
    if (!supplied) files.shift();
    return files;
};
/**
 * Shell words with output redirections removed (operator and target) and input redirections
 * reduced to their target, which the command reads.
 */
const unredirectedWords = (raw: string[]): string[] => {
    const words = raw.flatMap((w) => {
        const at = w.search(/(?<=.)\d*&?[<>]/);
        return at > 0 ? [w.slice(0, at), w.slice(at)] : [w];
    });
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (/^\d*&?>>?$/.test(w)) i++;
        else if (/^\d*&?>>?./.test(w)) continue;
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
        while (i < rest.length) {
            const ch = rest[i] as string;
            if (quote) {
                if (ch === quote) quote = "";
            } else if (ch === "'" || ch === '"') quote = ch;
            else if (ch === "\\") i++;
            else if (/\s/.test(ch)) break;
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

function p4(r: ArtefactReader, c: Check): Outcome {
    const added = changed(r);
    const kept = matchesAll(added, c.must ?? []);
    const wrong = matchesAny(added, c.must_not ?? []);
    const collapsed = wrong && c.scope === "out";
    const reasons = [
        kept ? "" : "missing the expected rule",
        wrong ? (collapsed ? "collapsed a still-valid fact" : "kept the superseded rule") : "",
    ].filter(Boolean);
    return binary(
        "P4",
        kept && !wrong,
        { "P4.harm": collapsed, "P4.collapsed": collapsed },
        reasons.join("; "),
    );
}

function p6(r: ArtefactReader, c: Check): Outcome {
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
    return binary("P6", matchesAll(work(r), c.must ?? []), {
        "P6.reread_files": reread.length,
        "P6.ran_tests": commands.some(ranTests),
        "P6.rediscovery_tokens": tokens,
    });
}

function p13(r: ArtefactReader, c: Check, rules: Rules): Outcome {
    const folds = foldsIn(r, c.turns);
    if (folds.length === 0) {
        return { verdict: "excluded", reason: "no fold in the item's range", metrics: {} };
    }
    const boundary = Math.min(...folds.map((x) => x.scenario_ms));
    const commands = r.commands("session");
    const after = commands.filter((x) => x.scenario_ms >= boundary);
    const before = new Set(commands.filter((x) => x.scenario_ms < boundary).map((x) => x.command));
    const invoked = (patterns: string[]) => (x: Command) =>
        executed(x).some((seg) => startsWithAll(seg, patterns.map(anchored)));
    const kept = c.commands_must
        ? after.some(invoked(c.commands_must))
        : matchesAll(changed(r), c.must ?? []);
    const min = Number(rules.p13_reduction_ratio.min);
    const max = Number(rules.p13_reduction_ratio.max);
    const ratioOk = folds.every((x) => {
        const input = x.input_tokens + x.cache_read_tokens + x.cache_write_tokens;
        const ratio = x.output_tokens / input;
        return input > 0 && ratio >= min && ratio <= max;
    });
    const repeated = after.some((x) => before.has(x.command) && !QUIET.test(unprefixed(x.command)));
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
    const observed = userSim.filter((x) => x.seq > boundary && (x.turn_index ?? -1) >= from);
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

type Grader = (r: ArtefactReader, check: Check, rules: Rules, probe: ProbeItem) => Outcome;

const GRADERS: Record<string, Grader> = {
    P1: (r, c) => binary("P1", matchesAll(changed(r), c.must ?? []), {}, "rule not applied"),
    "P1-control": (r, c) =>
        binary("P1-control", matchesAll(changed(r), c.must ?? []), {}, "rule not applied"),
    P2: (r, c) => {
        const over = matchesAny(changed(r), c.must_not ?? []);
        return binary("P2", !over, { "P2.harm": over }, "applied the rule outside its scope");
    },
    P3: (r, c) => {
        const added = changed(r);
        const authoritative = matchesAll(added, c.must ?? []);
        const stale = matchesAny(added, c.must_not ?? []);
        const reliance = stale ? "stale" : authoritative ? "authoritative" : "neither";
        const extra = { "P3.reliance": reliance, "P3.harm": stale };
        return binary("P3", authoritative && !stale, extra, `relied on ${reliance}`);
    },
    P4: p4,
    P5: (r, c) =>
        binary("P5", !matchesAny(work(r), c.must_not ?? []), {}, "reused the rejected approach"),
    P6: p6,
    P8: (r, c) => {
        const hit = carries(r.answer(), c.answer ?? "\u0000");
        return binary("P8", hit, { "P8.cross_session_pass_rate": hit }, "answer lacks the value");
    },
    P9: (r, _c, _rules, p) => {
        const hit = abstains(r.answer(), p.text ?? "");
        const extra = { "P9.cross_session_pass_rate": hit };
        return binary("P9", hit, extra, "answered instead of abstaining");
    },
    P10: (r, c) => {
        const fold = (p: string) => (p.startsWith("(?i)") ? p : `(?i)${p}`);
        const inDiff = matchesAny(changed(r), (c.must_not ?? []).map(fold));
        const answerPatterns = [c.answer_must_not ?? []].flat();
        const inAnswer =
            answerPatterns.length > 0 && matchesAny(r.answer(), answerPatterns.map(fold));
        const leaked = inDiff || inAnswer;
        return binary("P10", !leaked, { "P10.harm": leaked }, "anchor value leaked");
    },
    P11: (r, c, rules) => {
        const injected = matchesAny(changed(r), c.must_not ?? []);
        const weighted = injected ? -Number(rules.p11_false_positive_weight) : 1;
        const extra = { "P11.harm": injected, "P11.weighted_score": weighted };
        return binary("P11", !injected, extra, "injected the other project's rule");
    },
    P12: (r, c) =>
        binary("P12", matchesAll(changed(r), c.must ?? []), {}, "fix omits the error code"),
    P13: p13,
    P14: p14,
};

function graderFor(probe: ProbeItem): Grader {
    const grader = Object.hasOwn(GRADERS, probe.type) ? GRADERS[probe.type] : undefined;
    if (!grader) throw new GradeRefused(`no programmatic grader for ${probe.type}`);
    const check = (probe.check ?? {}) as Record<string, unknown>;
    if (probe.type === "P13" && check.must === undefined && check.commands_must === undefined) {
        throw new GradeRefused(
            `P13 item ${probe.id} has neither check.must nor check.commands_must`,
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
    return grader;
}

export function gradeItem(
    probe: ProbeItem,
    snapshots: Snapshot[],
    rules: Rules,
    version = 1,
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
    const reader = new ArtefactReader(first);
    const outcome = grader(reader, (probe.check ?? {}) as Check, rules, probe);
    const paired = probe.type === "P1-control" || probe.type === "P1";
    if (paired && !probe.fact)
        throw new GradeRefused(`${probe.type} item ${probe.id} names no fact`);
    return {
        item: probe.id,
        arm: first.arm,
        probe_type: probe.type,
        version,
        snapshot: first.id,
        inputs: [...reader.read].sort(),
        later_attempts_logged: snapshots.length - 1,
        ...(paired ? { pair: probe.fact as string } : {}),
        ...outcome,
    };
}

const VERDICTS: Verdict[] = ["pass", "fail", "excluded"];

function isGradeRecord(value: unknown): value is GradeRecord {
    if (typeof value !== "object" || value === null) return false;
    const g = value as Record<string, unknown>;
    const strings =
        ["item", "arm", "snapshot"].every((k) => text(g[k])) && typeof g.probe_type === "string";
    const known = g.probe_type === "P7" || Object.hasOwn(GRADERS, g.probe_type as string);
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
    const paired = g.probe_type === "P1" || g.probe_type === "P1-control";
    const pair = paired ? text(g.pair) : g.pair === undefined;
    const graded = metrics && (g.verdict === "excluded" || primaryAgrees(g));
    const optionals = optional(str)(g.reason);
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
        graded
    );
}

/** A graded record's primary metric exists and matches its verdict: `<type>.pass` for the binary graders, the fold score for P13, the correction count for P14. */
function primaryAgrees(g: Record<string, unknown>): boolean {
    const m = g.metrics as Record<string, unknown>;
    const pass = g.verdict === "pass";
    if (g.probe_type === "P13") {
        const score = m["P13.fold_fidelity_score"];
        return typeof score === "number" && (pass ? score === 1 : score !== 1);
    }
    if (g.probe_type === "P14") {
        const n = m["P14.post_compaction_correction_count"];
        return typeof n === "number" && (pass ? n === 0 : n > 0);
    }
    if (g.probe_type === "P7") return typeof m["P7.pass"] === "boolean" && m["P7.pass"] === pass;
    return m[`${g.probe_type}.pass`] === pass;
}

/** The field a regrade changed among those fixed for an item and arm, or null. */
function identityChange(previous: GradeRecord, next: GradeRecord): string | null {
    for (const field of ["snapshot", "probe_type", "pair"] as const) {
        if (previous[field] !== next[field]) return field;
    }
    return null;
}

function newest(grades: GradeRecord[]): GradeRecord[] {
    const byKey = new Map<string, GradeRecord>();
    for (const g of grades) {
        const key = `${g.item}/${g.arm}`;
        if ((byKey.get(key)?.version ?? 0) < g.version) byKey.set(key, g);
    }
    return [...byKey.values()];
}

export class GradeLog {
    constructor(private readonly path: string) {}

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
            const key = `${parsed.item}/${parsed.arm}`;
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

    nextVersion(item: string, arm: string): number {
        const mine = this.all().filter((g) => g.item === item && g.arm === arm);
        return mine.length === 0 ? 1 : Math.max(...mine.map((g) => g.version)) + 1;
    }

    append(record: GradeRecord): void {
        const { item, arm } = record;
        if (!isGradeRecord(record)) {
            throw new GradeRefused(`grade ${item}/${arm} is not a grade record`);
        }
        const mine = this.all().filter((g) => g.item === item && g.arm === arm);
        const expected = mine.length === 0 ? 1 : Math.max(...mine.map((g) => g.version)) + 1;
        if (record.version !== expected) {
            throw new GradeRefused(`grade ${item}/${arm} v${record.version} expected v${expected}`);
        }
        const last = mine.at(-1);
        const changedField = last && identityChange(last, record);
        if (changedField) {
            throw new GradeRefused(
                `grade ${item}/${arm} v${record.version} changes ${changedField}`,
            );
        }
        const fd = this.open(constants.O_RDWR | constants.O_CREAT) as number;
        try {
            const kept = Buffer.byteLength(this.completeFrom(fd));
            ftruncateSync(fd, kept);
            const line = Buffer.from(`${JSON.stringify(record)}\n`);
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
