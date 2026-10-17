import { appendFileSync, existsSync, truncateSync } from "node:fs";
import type { Preregistration } from "../prereg/schema";
import { readJournal } from "../run/journal";
import type { ProbeItem } from "../scenario/compile";
import {
    ArtefactReader,
    assertArtefactsOnly,
    type CallView,
    GradeRefused,
    type Snapshot,
} from "./artefacts";
import { abstains, addedLines, carries, diffPaths, matchesAll, matchesAny } from "./text";

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

const READS = /\b(cat|less|more|head|tail|sed|view|bat|grep|rg)\b|^read /;
const TESTS = /\b(cargo test|bun test|npm test|pnpm test)\b/;
const QUIET = /^\s*(cargo (build|check|test)|bun (test|install)|git (status|log|diff)|ls|pwd)\b/;
const FOLDS = ["history_summarizer", "native_compaction"];

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
const work = (r: ArtefactReader) => `${addedLines(r.diff())}\n${commandText(r)}`;

function foldsIn(r: ArtefactReader, turns?: [number, number]): CallView[] {
    const folds = r.calls().filter((c) => FOLDS.includes(c.component));
    if (!turns) return folds;
    const [lo, hi] = turns;
    return folds.filter(
        (c) => c.turn_index !== undefined && c.turn_index >= lo && c.turn_index < hi,
    );
}

function p4(r: ArtefactReader, c: Check): Outcome {
    const added = addedLines(r.diff());
    const kept = matchesAll(added, c.must ?? []);
    const wrong = matchesAny(added, c.must_not ?? []);
    const collapsed = wrong && c.scope === "out";
    const reason = !wrong
        ? "missing the expected rule"
        : collapsed
          ? "collapsed a still-valid fact"
          : "kept the superseded rule";
    return binary(
        "P4",
        kept && !wrong,
        { "P4.harm": collapsed, "P4.collapsed": collapsed },
        reason,
    );
}

function p6(r: ArtefactReader, c: Check): Outcome {
    const prior = diffPaths(r.diff("prior-session"));
    const commands = r.commands();
    const reread = prior.filter((p) =>
        commands.some((x) => READS.test(x.command) && x.command.includes(p)),
    );
    const tokens = r.turnCalls().reduce((n, x) => n + x.input_tokens + x.output_tokens, 0);
    return binary("P6", matchesAll(work(r), c.must ?? []), {
        "P6.reread_files": reread.length,
        "P6.ran_tests": commands.some((x) => TESTS.test(x.command)),
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
    const kept = c.commands_must
        ? after.some((x) => matchesAll(x.command, c.commands_must ?? []))
        : matchesAll(addedLines(r.diff()), c.must ?? []);
    const min = Number(rules.p13_reduction_ratio.min);
    const max = Number(rules.p13_reduction_ratio.max);
    const measured = folds.filter((x) => x.input_tokens > 0);
    const ratioOk = measured.every((x) => {
        const ratio = x.output_tokens / x.input_tokens;
        return ratio >= min && ratio <= max;
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
    const boundary = Math.min(...folds.map((x) => x.scenario_ms));
    const userSim = r.calls().filter((x) => x.component === "user-sim");
    if (userSim.length === 0 || userSim.some((x) => !x.label || x.turn_index === undefined)) {
        return { verdict: "excluded", reason: "no labelled user-sim turns", metrics: {} };
    }
    const from = c.window_from_turn ?? 0;
    const pushback = userSim.filter(
        (x) => x.label === "pushback" && x.scenario_ms >= boundary && (x.turn_index ?? -1) >= from,
    );
    const count = pushback.length;
    const outcome: Outcome = {
        verdict: count === 0 ? "pass" : "fail",
        metrics: { "P14.post_compaction_correction_count": count },
    };
    if (count > 0) outcome.reason = "user corrected the agent after compaction";
    return outcome;
}

type Grader = (r: ArtefactReader, check: Check, rules: Rules, probe: ProbeItem) => Outcome;

const GRADERS: Record<string, Grader> = {
    P1: (r, c) =>
        binary("P1", matchesAll(addedLines(r.diff()), c.must ?? []), {}, "rule not applied"),
    "P1-control": (r, c) =>
        binary(
            "P1-control",
            matchesAll(addedLines(r.diff()), c.must ?? []),
            {},
            "rule not applied",
        ),
    P2: (r, c) => {
        const over = matchesAny(addedLines(r.diff()), c.must_not ?? []);
        return binary("P2", !over, { "P2.harm": over }, "applied the rule outside its scope");
    },
    P3: (r, c) => {
        const added = addedLines(r.diff());
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
    P8: (r, c) =>
        binary("P8", carries(r.answer(), c.answer ?? "\u0000"), {}, "answer lacks the value"),
    P9: (r, _c, _rules, p) =>
        binary("P9", abstains(r.answer(), p.text ?? ""), {}, "answered instead of abstaining"),
    P10: (r, c) => {
        const leaked = matchesAny(`${addedLines(r.diff())}\n${r.answer()}`, c.must_not ?? []);
        return binary("P10", !leaked, { "P10.harm": leaked }, "anchor value leaked");
    },
    P11: (r, c, rules) => {
        const injected = matchesAny(addedLines(r.diff()), c.must_not ?? []);
        const weighted = injected ? -Number(rules.p11_false_positive_weight) : 1;
        const extra = { "P11.harm": injected, "P11.weighted_score": weighted };
        return binary("P11", !injected, extra, "injected the other project's rule");
    },
    P12: (r, c) =>
        binary(
            "P12",
            matchesAll(addedLines(r.diff()), c.must ?? []),
            {},
            "fix omits the error code",
        ),
    P13: p13,
    P14: p14,
};

function graderFor(probe: ProbeItem): Grader {
    const grader = GRADERS[probe.type];
    if (!grader) throw new GradeRefused(`no programmatic grader for ${probe.type}`);
    const check = (probe.check ?? {}) as Record<string, unknown>;
    if (probe.type === "P13" && !check.must && !check.commands_must) {
        throw new GradeRefused(
            `P13 item ${probe.id} has neither check.must nor check.commands_must`,
        );
    }
    for (const key of REQUIRED[probe.type] ?? []) {
        const value = check[key];
        if (value === undefined || (Array.isArray(value) && value.length === 0)) {
            throw new GradeRefused(`${probe.type} item ${probe.id} has no check.${key}`);
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
    assertArtefactsOnly(first);
    const grader = graderFor(probe);
    if (first.turn_outcome === "failed") return null;
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

export class GradeLog {
    constructor(private readonly path: string) {}

    /** Every complete record; one a kill cut short at the end of the file is left out. */
    all(): GradeRecord[] {
        return readJournal(this.path) as unknown as GradeRecord[];
    }

    latest(): GradeRecord[] {
        const newest = new Map<string, GradeRecord>();
        for (const g of this.all()) {
            const key = `${g.item}/${g.arm}`;
            if ((newest.get(key)?.version ?? 0) < g.version) newest.set(key, g);
        }
        return [...newest.values()];
    }

    nextVersion(item: string, arm: string): number {
        const mine = this.all().filter((g) => g.item === item && g.arm === arm);
        return mine.length === 0 ? 1 : Math.max(...mine.map((g) => g.version)) + 1;
    }

    append(record: GradeRecord): void {
        this.appendAll([record]);
    }

    /** Appends the records in one write, so a kill leaves either all of them or none. */
    appendAll(records: GradeRecord[]): void {
        for (const record of records) {
            const expected = this.nextVersion(record.item, record.arm);
            if (record.version !== expected) {
                throw new GradeRefused(
                    `grade ${record.item}/${record.arm} v${record.version} expected v${expected}`,
                );
            }
        }
        if (existsSync(this.path)) truncateSync(this.path, readJournal(this.path).bytes ?? 0);
        appendFileSync(this.path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
    }
}

export function deltaMem(
    grades: GradeRecord[],
    arm = "eidnara",
    control = "host",
): { delta: number; n: number } | null {
    const graded = (a: string) =>
        new Map(
            grades
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
