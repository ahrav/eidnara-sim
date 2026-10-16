import { appendFileSync, existsSync, readFileSync, truncateSync } from "node:fs";
import type { Preregistration } from "../prereg/schema";
import type { ProbeItem } from "../scenario/compile";
import {
    ArtefactReader,
    assertArtefactsOnly,
    bool,
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
import { abstains, addedLines, carries, diffPaths, matchesAll, matchesAny, pattern } from "./text";

export type Rules = Preregistration["grading"];
export type Verdict = "pass" | "fail" | "excluded";

export interface Check {
    must?: string[];
    must_not?: string[];
    commands_must?: string[];
    answer?: string;
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
const TESTS = /^(cargo test|(bun|npm|pnpm) (run )?test)\b/;
const QUIET =
    /^\s*(cargo (build|check|test)|bun install|(bun|npm|pnpm) (run )?test|git (status|log|diff)|ls|pwd)\b[^&|;`$()\n]*$/;
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
    abstain: bool,
    scope: oneOf(["in", "out"]),
    window_from_turn: num,
    turns: (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(num),
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
    P10: ["must_not"],
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
    return `${diffPaths(patch).join("\n")}\n${addedLines(patch)}`;
};
const work = (r: ArtefactReader) => `${changed(r)}\n${commandText(r)}`;

/** P6 requires the read and the prior-session path to occur in the same executed shell segment. */
/**
 * Segments known to have run: every unconditional segment, and a `&&` continuation when the
 * command exited 0. A `||` continuation is left out, because its execution cannot be read from
 * the exit code.
 */
/** Operator-separated segments with the operator that led to each; quoted text is one segment. */
function splitShell(command: string): { op: string; seg: string }[] {
    const out: { op: string; seg: string }[] = [];
    let quote = "";
    let seg = "";
    let op = ";";
    const push = (next: string) => {
        out.push({ op, seg: seg.trim() });
        seg = "";
        op = next;
    };
    let heredoc = "";
    for (let i = 0; i < command.length; i++) {
        const ch = command[i] as string;
        if (heredoc) {
            if (ch === "\n") {
                const end = command.indexOf("\n", i + 1);
                const line = command.slice(i + 1, end < 0 ? command.length : end).trim();
                if (line === heredoc) {
                    heredoc = "";
                    i = end < 0 ? command.length : end;
                    push("\n");
                } else i = end < 0 ? command.length : end - 1;
            }
            continue;
        }
        if (!quote && command.startsWith("<<", i)) {
            const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(command.slice(i));
            if (m) {
                heredoc = m[2] as string;
                seg += m[0];
                i += m[0].length - 1;
                continue;
            }
        }
        if (quote) {
            seg += ch;
            if (ch === quote) quote = "";
            else if (ch === "\\" && quote === '"') seg += command[++i] ?? "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            seg += ch;
        } else if (ch === "\\") seg += ch + (command[++i] ?? "");
        else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
            push(command.slice(i, i + 2));
            i++;
        } else if (ch === ";" || ch === "|" || ch === "\n") push(ch);
        else seg += ch;
    }
    out.push({ op, seg: seg.trim() });
    return out.filter((x) => x.seg.length > 0);
}

/** The exit code belongs to the last list of a command, so only an `&&` segment there is established by it. */
const executed = (x: Command): string[] => {
    const parts = splitShell(x.command);
    const lastList = parts.reduce((n, p, i) => (p.op === ";" || p.op === "\n" ? i : n), 0);
    return parts
        .filter((p, i) => p.op !== "||" && (p.op !== "&&" || (x.exit === 0 && i >= lastList)))
        .map((p) => p.seg);
};
const anchored = (p: string) => (p.startsWith("(?i)") ? `(?i)^${p.slice(4)}` : `^${p}`);
const namesPath = (segment: string, path: string) =>
    new RegExp(`(^|[\\s'"=])(\\./)?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s'"])`).test(
        segment,
    );
const ranTests = (x: Command) => executed(x).some((s) => TESTS.test(s));

function foldsIn(r: ArtefactReader, turns?: [number, number]): CallView[] {
    const folds = r.calls().filter((c) => FOLDS.includes(c.component) && completed(c));
    if (!turns) return folds;
    const [lo, hi] = turns;
    return folds.filter(
        (c) => c.turn_index !== undefined && c.turn_index >= lo && c.turn_index < hi,
    );
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
        commands.some((x) => executed(x).some((s) => READS.test(s) && namesPath(s, p))),
    );
    const tokens = r.turnCalls().reduce((n, x) => n + x.input_tokens + x.output_tokens, 0);
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
        executed(x).some((seg) => matchesAll(seg, patterns.map(anchored)));
    const kept = c.commands_must
        ? after.some(invoked(c.commands_must))
        : matchesAll(changed(r), c.must ?? []);
    const min = Number(rules.p13_reduction_ratio.min);
    const max = Number(rules.p13_reduction_ratio.max);
    const ratioOk = folds.every((x) => {
        const ratio = x.output_tokens / x.input_tokens;
        return x.input_tokens > 0 && ratio >= min && ratio <= max;
    });
    const repeated = after.some((x) => before.has(x.command) && !QUIET.test(x.command));
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
        const anchors = (c.must_not ?? []).map((s) => (s.startsWith("(?i)") ? s : `(?i)${s}`));
        const leaked = matchesAny(`${changed(r)}\n${r.responses()}`, anchors);
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
    const grader = GRADERS[probe.type];
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
    if (snapshots.some((s) => s.item !== probe.id || s.arm !== first.arm)) {
        throw new GradeRefused(`snapshots for ${probe.id} mix items or arms`);
    }
    for (const s of snapshots) assertArtefactsOnly(s);
    if (probe.event && first.turn !== probe.event) {
        throw new GradeRefused(
            `snapshot ${first.id} is of turn ${first.turn}, not the probe's event ${probe.event}`,
        );
    }
    if (first.session !== probe.session) {
        throw new GradeRefused(
            `snapshot ${first.id} is of session ${first.session}, not the probe's ${probe.session}`,
        );
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
    const strings = ["item", "arm", "probe_type", "snapshot"].every(
        (k) => typeof g[k] === "string",
    );
    const version = typeof g.version === "number" && Number.isInteger(g.version) && g.version >= 1;
    const verdict = VERDICTS.includes(g.verdict as Verdict);
    const metricValue = (v: unknown) => typeof v === "boolean" || str(v) || num(v);
    const metrics =
        typeof g.metrics === "object" &&
        g.metrics !== null &&
        !Array.isArray(g.metrics) &&
        Object.values(g.metrics).every(metricValue);
    const inputs = Array.isArray(g.inputs) && g.inputs.every(str);
    const attempts =
        Number.isInteger(g.later_attempts_logged) && (g.later_attempts_logged as number) >= 0;
    const optionals = optional(str)(g.pair) && optional(str)(g.reason);
    return strings && version && verdict && metrics && inputs && attempts && optionals;
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

    /** Earlier records stay readable after an interrupted append: only newline-terminated lines count. */
    private complete(): string {
        if (!existsSync(this.path)) return "";
        const text = readFileSync(this.path, "utf8");
        return text.slice(0, text.lastIndexOf("\n") + 1);
    }

    all(): GradeRecord[] {
        const lines = this.complete().split("\n").filter(Boolean);
        const seen = new Set<string>();
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
            const key = `${parsed.item}/${parsed.arm}/${parsed.version}`;
            if (seen.has(key)) {
                throw new GradeRefused(
                    `grade log ${this.path}: line ${i + 1} repeats version ${parsed.version} of ${parsed.item}/${parsed.arm}`,
                );
            }
            seen.add(key);
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
        const expected = this.nextVersion(record.item, record.arm);
        if (record.version !== expected) {
            throw new GradeRefused(
                `grade ${record.item}/${record.arm} v${record.version} expected v${expected}`,
            );
        }
        if (existsSync(this.path)) truncateSync(this.path, Buffer.byteLength(this.complete()));
        appendFileSync(this.path, `${JSON.stringify(record)}\n`);
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
