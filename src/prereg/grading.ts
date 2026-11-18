import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import { QUALIFICATIONS } from "./qualification";

export const GRADING_SCHEMA = "sim-grading-revision/v1";
/** The revisions whose rule is a judge's label, oldest first; graders apply the last one of each probe. */
export const JUDGED_REVISIONS = ["G10", "G11"] as const;
/** The revisions whose rule the grader computes from the turn's artefacts. */
export const RULE_REVISIONS = ["G12"] as const;
/** Every grading revision under `prereg/`, oldest first. */
export const GRADING_REVISIONS = [...JUDGED_REVISIONS, ...RULE_REVISIONS] as const;
export type GradingRevisionId = (typeof JUDGED_REVISIONS)[number];
export const ABSTAIN_LABELS = ["A", "B", "C", "D"] as const;
export type AbstainLabel = (typeof ABSTAIN_LABELS)[number];
/** The P8-twin labels; `P` is the class the labelling rubric writes A'. */
export const TWIN_LABELS = ["A", "P", "B", "C", "D", "E"] as const;
export type TwinLabel = (typeof TWIN_LABELS)[number];
/** The probes a grading revision grades from a judge's label. */
export const JUDGED_PROBES = ["P9", "P8-twin"] as const;
export type JudgedProbe = (typeof JUDGED_PROBES)[number];

interface Split {
    campaigns: string[];
    answers: number;
    agreed: number;
}

/** What every grading revision holds, over the labels `L` of its probe. */
interface Revision<L extends string> {
    schema: typeof GRADING_SCHEMA;
    id: GradingRevisionId;
    revision: number;
    frozen: true;
    /** The property the probe names; the rubric's passing labels state it. */
    property: string;
    /** The tier-file rule this revision replaces as the probe's verdict. */
    supersedes: {
        key: "grading.abstain_rule";
        value: "abstention-without-guess";
        tier_revisions_through: number;
    };
    labels: L[];
    pass_labels: L[];
    /** One call per answer; the stored label is reused while the prompt and judge stay the same. */
    judge: { model: string; max_tokens: number; calls: 1 };
    rubric: string;
    /** The labelled set the rule was chosen on: label counts, label agreement, and each split's agreement. */
    validation: {
        labelled_answers: number;
        label_counts: Record<L, number>;
        label_passes: number;
        label_pass_agreement: Record<string, string>;
        hand_audited: number;
        design: Split;
        test: Split;
        superseded_rule: { answers: number; agreed: number };
    };
}

/**
 * A grading rule registered after the tier files froze. A tier file's digest is recorded in
 * every run manifest, so the tier files stay byte-identical and a finished run regrades under
 * the revision. Revision 10 grades P9 from a judge's label of the answer (`judged-abstention`)
 * and keeps the tier files' `abstention-without-guess` rule as the stored metric `P9.v1`.
 */
export interface AbstainRevision extends Revision<AbstainLabel> {
    probe: "P9";
    abstain_rule: "judged-abstention";
    /** The replaced rule, computed on every graded answer and stored beside the verdict. */
    secondary_metric: { name: "P9.v1"; rule: "abstention-without-guess" };
}

/**
 * Revision 11 grades P8-twin from a judge's label of the answer (`judged-wrong-project-lookup`):
 * the labels of `pass_labels` pass, a label of `harm_labels` sets `P8-twin.harm`, and the
 * replaced rule (every sentence that names the base value places it elsewhere, then
 * `abstention-without-guess`) stays as the stored metric `P8-twin.v1`.
 */
export interface TwinRevision extends Revision<TwinLabel> {
    probe: "P8-twin";
    twin_rule: "judged-wrong-project-lookup";
    secondary_metric: { name: "P8-twin.v1"; rule: "placed-value-abstention-without-guess" };
    harm_labels: TwinLabel[];
}

export type GradingRevision = AbstainRevision | TwinRevision;

/** What the validator holds each probe's revision to. */
const SPECS: Record<
    JudgedProbe,
    {
        rule: [key: string, value: string];
        secondary: [name: string, rule: string];
        labels: readonly string[];
        pass: readonly string[];
        harm?: readonly string[];
        /** The key of `label_pass_agreement` that holds the agreement over every label. */
        classes: string;
    }
> = {
    P9: {
        rule: ["abstain_rule", "judged-abstention"],
        secondary: ["P9.v1", "abstention-without-guess"],
        labels: ABSTAIN_LABELS,
        pass: ["A"],
        classes: "four_class",
    },
    "P8-twin": {
        rule: ["twin_rule", "judged-wrong-project-lookup"],
        secondary: ["P8-twin.v1", "placed-value-abstention-without-guess"],
        labels: TWIN_LABELS,
        pass: ["A", "P"],
        harm: ["C"],
        classes: "six_class",
    },
};
const list = (items: readonly string[]) =>
    items.length === 1 ? `${items[0]} alone` : items.join(", ");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const same = (a: unknown, b: readonly string[]) =>
    Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const keysOf = (v: Obj, expected: readonly string[], at: string): string[] => {
    const extra = Object.keys(v).filter((k) => !expected.includes(k));
    const missing = expected.filter((k) => !(k in v));
    return [
        ...extra.map((k) => `${at}.${k}: unknown key`),
        ...missing.map((k) => `${at}.${k}: missing`),
    ];
};

/** A split's errors; `unit` names its count: `answers` of a judged probe, `items` or `turns` of a rule. */
function splitErrors(v: unknown, at: string, unit = "answers"): string[] {
    if (!isObj(v)) return [`${at}: expected an object`];
    const errors = keysOf(v, ["campaigns", unit, "agreed"], at);
    const names = v.campaigns;
    if (
        !Array.isArray(names) ||
        names.length === 0 ||
        names.some((c) => !(QUALIFICATIONS as readonly unknown[]).includes(c)) ||
        new Set(names).size !== names.length
    ) {
        errors.push(`${at}.campaigns: expected distinct qualification registrations`);
    }
    if (
        !count(v[unit]) ||
        (v[unit] as number) < 1 ||
        !count(v.agreed) ||
        (v.agreed as number) > (v[unit] as number)
    ) {
        errors.push(`${at}: expected agreed ${unit} within the ${unit.replace(/s$/, "")} count`);
    }
    return errors;
}

/** Every way `value` departs from a grading revision; empty when it is one. */
export function validateGradingRevision(value: unknown): string[] {
    if (!isObj(value)) return ["expected an object"];
    const probe = (JUDGED_PROBES as readonly unknown[]).includes(value.probe)
        ? (value.probe as JudgedProbe)
        : "P9";
    const spec = SPECS[probe];
    const errors = keysOf(
        value,
        [
            "schema",
            "id",
            "revision",
            "frozen",
            "probe",
            "property",
            spec.rule[0],
            "supersedes",
            "secondary_metric",
            "labels",
            "pass_labels",
            ...(spec.harm ? ["harm_labels"] : []),
            "judge",
            "rubric",
            "validation",
        ],
        "revision",
    );
    if (value.schema !== GRADING_SCHEMA) errors.push(`schema: expected ${GRADING_SCHEMA}`);
    if (!(JUDGED_REVISIONS as readonly unknown[]).includes(value.id)) {
        errors.push(`id: expected one of ${JUDGED_REVISIONS.join(", ")}`);
    }
    if (!Number.isSafeInteger(value.revision) || value.id !== `G${String(value.revision)}`) {
        errors.push("revision: expected the integer the id names");
    }
    if (value.frozen !== true) errors.push("frozen: expected true");
    if (value.probe !== probe) errors.push(`probe: expected ${JUDGED_PROBES.join(" or ")}`);
    if (typeof value.property !== "string" || value.property.trim() === "") {
        errors.push("property: expected the property the probe names");
    }
    if (value[spec.rule[0]] !== spec.rule[1]) {
        errors.push(`${spec.rule[0]}: expected ${spec.rule[1]}`);
    }
    const supersedes = value.supersedes;
    if (
        !isObj(supersedes) ||
        supersedes.key !== "grading.abstain_rule" ||
        supersedes.value !== "abstention-without-guess" ||
        !Number.isSafeInteger(supersedes.tier_revisions_through) ||
        (Number.isSafeInteger(value.revision) &&
            (supersedes.tier_revisions_through as number) >= (value.revision as number)) ||
        Object.keys(supersedes).length !== 3
    ) {
        errors.push("supersedes: expected the tier rule and the last tier revision it held in");
    }
    const secondary = value.secondary_metric;
    if (
        !isObj(secondary) ||
        secondary.name !== spec.secondary[0] ||
        secondary.rule !== spec.secondary[1] ||
        Object.keys(secondary).length !== 2
    ) {
        errors.push(`secondary_metric: expected ${spec.secondary[0]} under ${spec.secondary[1]}`);
    }
    if (!same(value.labels, spec.labels)) {
        errors.push(`labels: expected ${spec.labels.join(", ")}`);
    }
    if (!same(value.pass_labels, spec.pass)) {
        errors.push(`pass_labels: expected ${list(spec.pass)}`);
    }
    if (spec.harm && !same(value.harm_labels, spec.harm)) {
        errors.push(`harm_labels: expected ${list(spec.harm)}`);
    }
    const judge = value.judge;
    if (
        !isObj(judge) ||
        typeof judge.model !== "string" ||
        judge.model.trim() === "" ||
        !Number.isSafeInteger(judge.max_tokens) ||
        (judge.max_tokens as number) < 1 ||
        judge.calls !== 1 ||
        Object.keys(judge).length !== 3
    ) {
        errors.push("judge: expected a model, a positive max_tokens, and one call per answer");
    }
    const rubric = value.rubric;
    if (typeof rubric !== "string" || rubric.trim() !== rubric || rubric === "") {
        errors.push("rubric: expected trimmed text");
    } else {
        for (const label of spec.labels) {
            if (!new RegExp(`^${label}: `, "m").test(rubric)) {
                errors.push(`rubric: defines no label ${label}`);
            }
        }
    }
    const v = value.validation;
    if (!isObj(v)) errors.push("validation: expected an object");
    else {
        errors.push(
            ...keysOf(
                v,
                [
                    "labelled_answers",
                    "label_counts",
                    "label_passes",
                    "label_pass_agreement",
                    "hand_audited",
                    "design",
                    "test",
                    "superseded_rule",
                ],
                "validation",
            ),
            ...splitErrors(v.design, "validation.design"),
            ...splitErrors(v.test, "validation.test"),
        );
        const campaigns = (s: unknown): unknown[] =>
            isObj(s) && Array.isArray(s.campaigns) ? s.campaigns : [];
        const designed = campaigns(v.design);
        if (campaigns(v.test).some((c) => designed.includes(c))) {
            errors.push(
                "validation: a campaign lies in the design split or the test split, one of them",
            );
        }
        const counts = isObj(v.label_counts) ? v.label_counts : {};
        errors.push(...keysOf(counts, spec.labels, "validation.label_counts"));
        const total = spec.labels.reduce(
            (n, l) => n + (count(counts[l]) ? Number(counts[l]) : NaN),
            0,
        );
        if (!count(v.labelled_answers) || total !== v.labelled_answers) {
            errors.push(
                "validation.label_counts: expected one count per label summing to labelled_answers",
            );
        }
        const splits = [v.design, v.test].map((s) =>
            isObj(s) && count(s.answers) ? Number(s.answers) : NaN,
        );
        if ((splits[0] as number) + (splits[1] as number) !== v.labelled_answers) {
            errors.push("validation: the design and test splits partition the labelled answers");
        }
        if (!count(v.label_passes) || (v.label_passes as number) < 2) {
            errors.push("validation.label_passes: expected at least two independent passes");
        }
        const agreement = v.label_pass_agreement;
        if (isObj(agreement)) {
            errors.push(
                ...keysOf(
                    agreement,
                    [spec.classes, "pass_fail"],
                    "validation.label_pass_agreement",
                ),
            );
        }
        if (
            !isObj(agreement) ||
            ![agreement[spec.classes], agreement.pass_fail].every(
                (x) => isCanonicalDecimal(x) && Number(x) <= 1,
            )
        ) {
            errors.push("validation.label_pass_agreement: expected canonical decimals in [0, 1]");
        }
        if (!count(v.hand_audited) || (v.hand_audited as number) > (v.labelled_answers as number)) {
            errors.push("validation.hand_audited: expected a count within the labelled answers");
        }
        const old = v.superseded_rule;
        if (isObj(old)) {
            errors.push(...keysOf(old, ["answers", "agreed"], "validation.superseded_rule"));
        }
        if (
            !isObj(old) ||
            old.answers !== v.labelled_answers ||
            !count(old.agreed) ||
            (old.agreed as number) > (old.answers as number)
        ) {
            errors.push(
                "validation.superseded_rule: expected its agreement over the labelled answers",
            );
        }
    }
    return errors;
}

/** The digest a judged grade carries for the revision that graded it. */
export function gradingRevisionHash(revision: GradingRevision): string {
    return sha256Hex(`${GRADING_SCHEMA}\n${canonicalJson(revision)}`);
}

export const gradingRevisionPath = (
    id: string,
    dir = join(import.meta.dir, "..", "..", "prereg"),
): string => join(dir, `${id}.json`);

/** `prereg/<id>.json`, accepted only when it validates and names `id`. */
export function loadGradingRevision(id: string, dir?: string): GradingRevision {
    const value: unknown = JSON.parse(readFileSync(gradingRevisionPath(id, dir), "utf8"));
    const errors = validateGradingRevision(value);
    if (errors.length === 0 && (value as Obj).id !== id) errors.push(`id: differs from ${id}.json`);
    if (errors.length > 0) throw new Error(`prereg/${id}.json refused: ${errors.join("; ")}`);
    // SAFETY: validateGradingRevision reported no error, so value has the GradingRevision shape.
    return value as GradingRevision;
}

/** The revision graders apply to `probe`: the last one registered for it. */
export function gradingRevisionFor<P extends JudgedProbe>(
    probe: P,
    dir?: string,
): Extract<GradingRevision, { probe: P }> {
    const found = JUDGED_REVISIONS.map((id) => loadGradingRevision(id, dir))
        .reverse()
        .find((r) => r.probe === probe);
    if (!found) throw new Error(`prereg/ registers no grading revision for ${probe}`);
    // SAFETY: found.probe equals probe, so it is the revision type of that probe.
    return found as Extract<GradingRevision, { probe: P }>;
}

export const RULE_SCHEMA = "sim-grading-rule-revision/v1";
/** The probes revision 12 grades: P5 by `reuse_rule`, and all three by `deferral_rule`. */
export const RULE_PROBES = ["P2", "P5", "P11"] as const;
/** The P5 labels: reuse, another way, named only, defers or asks, no real work. */
export const REUSE_LABELS = ["U", "K", "M", "Q", "N"] as const;
export type ReuseLabel = (typeof REUSE_LABELS)[number];
/** The labels of a turn that did no work: it hands the next step back, or hands nothing back. */
export const DEFERRAL_LABELS = ["Q", "N"] as const;
const REUSE_RULE = "product-code-match";
const DEFERRAL_RULE = "no-work-reply";
const SECONDARY = RULE_PROBES.map((probe) => ({
    name: `${probe}.v1`,
    rule: probe === "P5" ? "added-lines-and-applied-commands" : "code-change-or-question",
}));

type SplitOf<U extends string> = { campaigns: string[]; agreed: number } & Record<U, number>;

/**
 * Revision 12 registers two rules a grader computes from the turn's artefacts, so a finished
 * run regrades with no model call. `product-code-match`: a P5 turn reuses the rejected approach
 * when the check's pattern matches code the turn adds to a product file, and its work is a
 * changed product file. `no-work-reply`: a P2, P5, or P11 turn that did no work and broke no
 * rule is deferred when its final reply holds text and fails when the reply is empty. It
 * replaces the tier files' `grading.no_change_question`, under which only a reply with a
 * question was deferred. Each grade keeps the replaced verdict as `<probe>.v1`.
 */
export interface RuleRevision {
    schema: typeof RULE_SCHEMA;
    id: (typeof RULE_REVISIONS)[number];
    revision: number;
    frozen: true;
    probes: (typeof RULE_PROBES)[number][];
    /** The property P5 names; labels K and M state it. */
    property: string;
    reuse_rule: typeof REUSE_RULE;
    deferral_rule: typeof DEFERRAL_RULE;
    supersedes: {
        key: "grading.no_change_question";
        value: "deferred";
        tier_revisions_through: number;
    };
    /** The replaced verdict of each probe, computed on every graded turn and stored beside the verdict. */
    secondary_metrics: { name: string; rule: string }[];
    labels: ReuseLabel[];
    pass_labels: ReuseLabel[];
    deferred_labels: ReuseLabel[];
    /** The rubric the labelled turns were read under; the rules were chosen by agreement with its labels. */
    rubric: string;
    validation: {
        /** The P5 turns: label counts, label agreement, and the rule's agreement on each split. */
        reuse: {
            labelled_items: number;
            label_counts: Record<ReuseLabel, number>;
            label_passes: number;
            label_pass_agreement: { five_class: string; verdict: string };
            hand_audited: number;
            design: SplitOf<"items">;
            test: SplitOf<"items">;
            superseded_rule: { items: number; agreed: number };
            /** The judge-graded design the rule was compared with, one call per item. */
            judge: { model: string; design_agreed: number; test_agreed: number };
        };
        /** The turns of the three probes that did no work: their labels and the rule's agreement. */
        deferral: {
            labelled_turns: number;
            label_counts: Record<(typeof DEFERRAL_LABELS)[number], number>;
            hand_audited: number;
            design: SplitOf<"turns">;
            test: SplitOf<"turns">;
            superseded_rule: { turns: number; agreed: number };
        };
    };
}

/**
 * The errors of one labelled set of a rule revision: its label counts sum to `total`, its design
 * and test splits partition it over disjoint campaigns, the audit count lies within it, and the
 * superseded rule's agreement is given over all of it. `unit` names the counted thing.
 */
function labelledSetErrors(
    v: Obj,
    at: string,
    unit: "items" | "turns",
    labels: readonly string[],
): string[] {
    const total = v[`labelled_${unit}`];
    const errors = [
        ...splitErrors(v.design, `${at}.design`, unit),
        ...splitErrors(v.test, `${at}.test`, unit),
    ];
    const campaigns = (s: unknown): unknown[] =>
        isObj(s) && Array.isArray(s.campaigns) ? s.campaigns : [];
    if (campaigns(v.test).some((c) => campaigns(v.design).includes(c))) {
        errors.push(`${at}: a campaign lies in the design split or the test split, one of them`);
    }
    const counts = isObj(v.label_counts) ? v.label_counts : {};
    errors.push(...keysOf(counts, labels, `${at}.label_counts`));
    const sum = labels.reduce((n, l) => n + (count(counts[l]) ? Number(counts[l]) : NaN), 0);
    if (!count(total) || sum !== total) {
        errors.push(`${at}.label_counts: expected one count per label summing to labelled_${unit}`);
    }
    const sizes = [v.design, v.test].map((s) =>
        isObj(s) && count(s[unit]) ? Number(s[unit]) : NaN,
    );
    if ((sizes[0] as number) + (sizes[1] as number) !== total) {
        errors.push(`${at}: the design and test splits partition the labelled ${unit}`);
    }
    if (!count(v.hand_audited) || (v.hand_audited as number) > (total as number)) {
        errors.push(`${at}.hand_audited: expected a count within the labelled ${unit}`);
    }
    const old = v.superseded_rule;
    if (isObj(old)) errors.push(...keysOf(old, [unit, "agreed"], `${at}.superseded_rule`));
    if (
        !isObj(old) ||
        old[unit] !== total ||
        !count(old.agreed) ||
        (old.agreed as number) > (old[unit] as number)
    ) {
        errors.push(`${at}.superseded_rule: expected its agreement over the labelled ${unit}`);
    }
    return errors;
}

/** Every way `value` departs from a rule revision; empty when it is one. */
export function validateRuleRevision(value: unknown): string[] {
    if (!isObj(value)) return ["expected an object"];
    const errors = keysOf(
        value,
        [
            "schema",
            "id",
            "revision",
            "frozen",
            "probes",
            "property",
            "reuse_rule",
            "deferral_rule",
            "supersedes",
            "secondary_metrics",
            "labels",
            "pass_labels",
            "deferred_labels",
            "rubric",
            "validation",
        ],
        "revision",
    );
    if (value.schema !== RULE_SCHEMA) errors.push(`schema: expected ${RULE_SCHEMA}`);
    if (!(RULE_REVISIONS as readonly unknown[]).includes(value.id)) {
        errors.push(`id: expected one of ${RULE_REVISIONS.join(", ")}`);
    }
    if (!Number.isSafeInteger(value.revision) || value.id !== `G${String(value.revision)}`) {
        errors.push("revision: expected the integer the id names");
    }
    if (value.frozen !== true) errors.push("frozen: expected true");
    if (!same(value.probes, RULE_PROBES)) {
        errors.push(`probes: expected ${RULE_PROBES.join(", ")}`);
    }
    if (typeof value.property !== "string" || value.property.trim() === "") {
        errors.push("property: expected the property the probe names");
    }
    if (value.reuse_rule !== REUSE_RULE) errors.push(`reuse_rule: expected ${REUSE_RULE}`);
    if (value.deferral_rule !== DEFERRAL_RULE) {
        errors.push(`deferral_rule: expected ${DEFERRAL_RULE}`);
    }
    const supersedes = value.supersedes;
    if (
        !isObj(supersedes) ||
        supersedes.key !== "grading.no_change_question" ||
        supersedes.value !== "deferred" ||
        !Number.isSafeInteger(supersedes.tier_revisions_through) ||
        (Number.isSafeInteger(value.revision) &&
            (supersedes.tier_revisions_through as number) >= (value.revision as number)) ||
        Object.keys(supersedes).length !== 3
    ) {
        errors.push("supersedes: expected the tier rule and the last tier revision it held in");
    }
    const secondary = value.secondary_metrics;
    if (
        !Array.isArray(secondary) ||
        secondary.length !== SECONDARY.length ||
        !SECONDARY.every((expected, i) => {
            const got: unknown = secondary[i];
            return (
                isObj(got) &&
                got.name === expected.name &&
                got.rule === expected.rule &&
                Object.keys(got).length === 2
            );
        })
    ) {
        errors.push(
            `secondary_metrics: expected ${SECONDARY.map((m) => `${m.name} under ${m.rule}`).join(", ")}`,
        );
    }
    if (!same(value.labels, REUSE_LABELS)) {
        errors.push(`labels: expected ${REUSE_LABELS.join(", ")}`);
    }
    if (!same(value.pass_labels, ["K", "M"])) errors.push("pass_labels: expected K, M");
    if (!same(value.deferred_labels, ["Q"])) errors.push("deferred_labels: expected Q alone");
    const rubric = value.rubric;
    if (typeof rubric !== "string" || rubric.trim() !== rubric || rubric === "") {
        errors.push("rubric: expected trimmed text");
    } else {
        for (const label of REUSE_LABELS) {
            if (!new RegExp(`^${label}: `, "m").test(rubric)) {
                errors.push(`rubric: defines no label ${label}`);
            }
        }
    }
    const v = value.validation;
    if (!isObj(v)) return [...errors, "validation: expected an object"];
    errors.push(...keysOf(v, ["reuse", "deferral"], "validation"));
    const reuse = v.reuse;
    if (!isObj(reuse)) errors.push("validation.reuse: expected an object");
    else {
        errors.push(
            ...keysOf(
                reuse,
                [
                    "labelled_items",
                    "label_counts",
                    "label_passes",
                    "label_pass_agreement",
                    "hand_audited",
                    "design",
                    "test",
                    "superseded_rule",
                    "judge",
                ],
                "validation.reuse",
            ),
            ...labelledSetErrors(reuse, "validation.reuse", "items", REUSE_LABELS),
        );
        if (!count(reuse.label_passes) || (reuse.label_passes as number) < 2) {
            errors.push("validation.reuse.label_passes: expected at least two independent passes");
        }
        const agreement = reuse.label_pass_agreement;
        if (isObj(agreement)) {
            errors.push(
                ...keysOf(
                    agreement,
                    ["five_class", "verdict"],
                    "validation.reuse.label_pass_agreement",
                ),
            );
        }
        if (
            !isObj(agreement) ||
            ![agreement.five_class, agreement.verdict].every(
                (x) => isCanonicalDecimal(x) && Number(x) <= 1,
            )
        ) {
            errors.push(
                "validation.reuse.label_pass_agreement: expected canonical decimals in [0, 1]",
            );
        }
        const judge = reuse.judge;
        const within = (n: unknown, split: unknown) =>
            count(n) && isObj(split) && count(split.items) && (n as number) <= Number(split.items);
        if (
            !isObj(judge) ||
            typeof judge.model !== "string" ||
            judge.model.trim() === "" ||
            !within(judge.design_agreed, reuse.design) ||
            !within(judge.test_agreed, reuse.test) ||
            Object.keys(judge).length !== 3
        ) {
            errors.push(
                "validation.reuse.judge: expected the compared judge's model and its agreement within each split",
            );
        }
    }
    const deferral = v.deferral;
    if (!isObj(deferral)) errors.push("validation.deferral: expected an object");
    else {
        errors.push(
            ...keysOf(
                deferral,
                [
                    "labelled_turns",
                    "label_counts",
                    "hand_audited",
                    "design",
                    "test",
                    "superseded_rule",
                ],
                "validation.deferral",
            ),
            ...labelledSetErrors(deferral, "validation.deferral", "turns", DEFERRAL_LABELS),
        );
    }
    return errors;
}

/** The digest of a rule revision, which `bun run prereg:validate` prints. */
export function ruleRevisionHash(revision: RuleRevision): string {
    return sha256Hex(`${RULE_SCHEMA}\n${canonicalJson(revision)}`);
}

/** `prereg/<id>.json`, accepted only when it validates as a rule revision and names `id`. */
export function loadRuleRevision(id: string, dir?: string): RuleRevision {
    const value: unknown = JSON.parse(readFileSync(gradingRevisionPath(id, dir), "utf8"));
    const errors = validateRuleRevision(value);
    if (errors.length === 0 && (value as Obj).id !== id) errors.push(`id: differs from ${id}.json`);
    if (errors.length > 0) throw new Error(`prereg/${id}.json refused: ${errors.join("; ")}`);
    // SAFETY: validateRuleRevision reported no error, so value has the RuleRevision shape.
    return value as RuleRevision;
}
