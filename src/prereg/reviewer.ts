import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import { QUALIFICATIONS } from "./qualification";

export const REVIEWER_SCHEMA = "sim-reviewer-change-revision/v1";
/** The revisions that grade the memory reviewer's written changes, oldest first; the step applies the last. */
export const REVIEWER_REVISIONS = ["G16"] as const;
/**
 * The labels of a reviewer change: the target row no longer held (R), one part of it no longer
 * held and the change took the whole row (P), the row still held or no cited source is later
 * evidence about it (W), the record does not settle it (U).
 */
export const CHANGE_LABELS = ["R", "P", "W", "U"] as const;
export type ChangeLabel = (typeof CHANGE_LABELS)[number];
/** What each label reads as in a grade row. */
export const CHANGE_VERDICTS: Record<ChangeLabel, string> = {
    R: "right",
    P: "partly right",
    W: "wrong",
    U: "cannot tell",
};
const CHANGE_RULE = "judged-row-ended";
const DELIVERY_RULE = "scenario-records-in-force";
const SECONDARY = { name: "R1.v1", rule: "target-literal-status" } as const;

interface Split {
    campaigns: string[];
    changes: number;
    agreed: number;
}

/**
 * Revision 16 grades each written change of the memory reviewer (a dispute, a contest mark, a
 * retirement, or a revision of one stored memory) from a judge's label of the change
 * (`judged-row-ended`): the judge reads the target row, the cited later sources, the conversation
 * between them, and the scenario's record of the row's subject. The rule a campaign registered
 * before it (the status of the scenario's value literals in the target's text) stays as the
 * stored metric `R1.v1`. `delivery_rule` names the reading of whether the scenario held a user
 * statement in force when a change took it out of automatic delivery
 * (`scenario-records-in-force`), which the step computes from the scenario's supersession and
 * plan records. The file stands beside the probe revisions under `prereg/` and the probe
 * graders' digest leaves it out, so the probe grades of a finished run stand.
 */
export interface ReviewerRevision {
    schema: typeof REVIEWER_SCHEMA;
    id: (typeof REVIEWER_REVISIONS)[number];
    revision: number;
    frozen: true;
    subject: "reviewer-change";
    /** The property a right change has; label R states it. */
    property: string;
    change_rule: typeof CHANGE_RULE;
    delivery_rule: typeof DELIVERY_RULE;
    /** The registered literal rule, computed on every change and stored beside the label. */
    secondary_metric: typeof SECONDARY;
    labels: ChangeLabel[];
    right_labels: ChangeLabel[];
    partial_labels: ChangeLabel[];
    wrong_labels: ChangeLabel[];
    /** One call per change; the stored label is reused while the prompt and judge stay the same. */
    judge: { model: string; max_tokens: number; calls: 1 };
    rubric: string;
    /** The labelled changes the rule was chosen on: label counts, label agreement, and each split's agreement. */
    validation: {
        labelled_changes: number;
        label_counts: Record<ChangeLabel, number>;
        label_passes: number;
        /** The two label passes' agreement over the four labels, and over R against the rest. */
        label_pass_agreement: { four_class: string; right_rest: string };
        hand_audited: number;
        design: Split;
        test: Split;
        /** The changes on which the literal rule's reading equals the label: right with R, wrong with W, no truth with U. */
        literal_rule: { changes: number; agreed: number };
    };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const same = (a: unknown, b: readonly string[]) =>
    Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const unitDecimal = (x: unknown) => isCanonicalDecimal(x) && (x === "1" || /^0(?:\.|$)/.test(x));

// The checks stand in this file so that `grading.ts`, which the probe graders' digest covers,
// keeps the bytes finished runs were graded under.
function keysOf(v: Obj, expected: readonly string[], at: string): string[] {
    return [
        ...Object.keys(v)
            .filter((k) => !expected.includes(k))
            .map((k) => `${at}.${k}: unknown key`),
        ...expected.filter((k) => !(k in v)).map((k) => `${at}.${k}: missing`),
    ];
}

/** The errors of a split: distinct registered campaigns and an agreement within its change count. */
function splitErrors(v: unknown, at: string): string[] {
    if (!isObj(v)) return [`${at}: expected an object`];
    const errors = keysOf(v, ["campaigns", "changes", "agreed"], at);
    const names = v.campaigns;
    if (
        !Array.isArray(names) ||
        names.length === 0 ||
        names.some((c) => !(QUALIFICATIONS as readonly unknown[]).includes(c)) ||
        new Set(names).size !== names.length
    ) {
        errors.push(`${at}.campaigns: expected distinct qualification registrations`);
    }
    if (!count(v.changes) || v.changes < 1 || !count(v.agreed) || v.agreed > v.changes) {
        errors.push(`${at}: expected agreed changes within the change count`);
    }
    return errors;
}

/** Every way `value` departs from a reviewer-change revision; empty when it is one. */
export function validateReviewerRevision(value: unknown): string[] {
    if (!isObj(value)) return ["expected an object"];
    const errors = keysOf(
        value,
        [
            "schema",
            "id",
            "revision",
            "frozen",
            "subject",
            "property",
            "change_rule",
            "delivery_rule",
            "secondary_metric",
            "labels",
            "right_labels",
            "partial_labels",
            "wrong_labels",
            "judge",
            "rubric",
            "validation",
        ],
        "revision",
    );
    if (value.schema !== REVIEWER_SCHEMA) errors.push(`schema: expected ${REVIEWER_SCHEMA}`);
    if (!(REVIEWER_REVISIONS as readonly unknown[]).includes(value.id)) {
        errors.push(`id: expected one of ${REVIEWER_REVISIONS.join(", ")}`);
    }
    if (!Number.isSafeInteger(value.revision) || value.id !== `G${String(value.revision)}`) {
        errors.push("revision: expected the integer the id names");
    }
    if (value.frozen !== true) errors.push("frozen: expected true");
    if (value.subject !== "reviewer-change") errors.push("subject: expected reviewer-change");
    if (typeof value.property !== "string" || value.property.trim() === "") {
        errors.push("property: expected the property a right change has");
    }
    if (value.change_rule !== CHANGE_RULE) errors.push(`change_rule: expected ${CHANGE_RULE}`);
    if (value.delivery_rule !== DELIVERY_RULE) {
        errors.push(`delivery_rule: expected ${DELIVERY_RULE}`);
    }
    const secondary = value.secondary_metric;
    if (
        !isObj(secondary) ||
        secondary.name !== SECONDARY.name ||
        secondary.rule !== SECONDARY.rule ||
        Object.keys(secondary).length !== 2
    ) {
        errors.push(`secondary_metric: expected ${SECONDARY.name} under ${SECONDARY.rule}`);
    }
    if (!same(value.labels, CHANGE_LABELS)) {
        errors.push(`labels: expected ${CHANGE_LABELS.join(", ")}`);
    }
    for (const [key, label] of [
        ["right_labels", "R"],
        ["partial_labels", "P"],
        ["wrong_labels", "W"],
    ] as const) {
        if (!same(value[key], [label])) errors.push(`${key}: expected ${label} alone`);
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
        errors.push("judge: expected a model, a positive max_tokens, and one call per change");
    }
    const rubric = value.rubric;
    if (typeof rubric !== "string" || rubric.trim() !== rubric || rubric === "") {
        errors.push("rubric: expected trimmed text");
    } else {
        for (const label of CHANGE_LABELS) {
            if (!new RegExp(`^${label}: \\S`, "m").test(rubric)) {
                errors.push(`rubric: defines no label ${label}`);
            }
        }
    }
    const v = value.validation;
    if (!isObj(v)) return [...errors, "validation: expected an object"];
    errors.push(
        ...keysOf(
            v,
            [
                "labelled_changes",
                "label_counts",
                "label_passes",
                "label_pass_agreement",
                "hand_audited",
                "design",
                "test",
                "literal_rule",
            ],
            "validation",
        ),
        ...splitErrors(v.design, "validation.design"),
        ...splitErrors(v.test, "validation.test"),
    );
    const total = v.labelled_changes;
    const campaigns = (s: unknown): unknown[] =>
        isObj(s) && Array.isArray(s.campaigns) ? s.campaigns : [];
    if (campaigns(v.test).some((c) => campaigns(v.design).includes(c))) {
        errors.push(
            "validation: a campaign lies in the design split or the test split, one of them",
        );
    }
    const counts = isObj(v.label_counts) ? v.label_counts : {};
    errors.push(...keysOf(counts, CHANGE_LABELS, "validation.label_counts"));
    const sum = CHANGE_LABELS.reduce((n, l) => n + (count(counts[l]) ? counts[l] : Number.NaN), 0);
    if (!count(total) || sum !== total) {
        errors.push(
            "validation.label_counts: expected one count per label summing to labelled_changes",
        );
    }
    const size = (s: unknown) => (isObj(s) && count(s.changes) ? s.changes : Number.NaN);
    if (size(v.design) + size(v.test) !== total) {
        errors.push("validation: the design and test splits partition the labelled changes");
    }
    if (!count(v.label_passes) || v.label_passes < 2) {
        errors.push("validation.label_passes: expected at least two independent passes");
    }
    const agreement = v.label_pass_agreement;
    const keys = ["four_class", "right_rest"];
    if (isObj(agreement))
        errors.push(...keysOf(agreement, keys, "validation.label_pass_agreement"));
    if (!isObj(agreement) || !keys.every((k) => unitDecimal(agreement[k]))) {
        errors.push("validation.label_pass_agreement: expected canonical decimals in [0, 1]");
    }
    if (!count(v.hand_audited) || !count(total) || v.hand_audited > total) {
        errors.push("validation.hand_audited: expected a count within the labelled changes");
    }
    const literal = v.literal_rule;
    if (isObj(literal))
        errors.push(...keysOf(literal, ["changes", "agreed"], "validation.literal_rule"));
    if (
        !isObj(literal) ||
        literal.changes !== total ||
        !count(literal.agreed) ||
        !count(literal.changes) ||
        literal.agreed > literal.changes
    ) {
        errors.push("validation.literal_rule: expected its agreement over the labelled changes");
    }
    return errors;
}

/** The digest a reviewer grade carries for the revision that graded it. */
export function reviewerRevisionHash(revision: ReviewerRevision): string {
    return sha256Hex(`${REVIEWER_SCHEMA}\n${canonicalJson(revision)}`);
}

/** `prereg/<id>.json`, accepted only when it validates as a reviewer-change revision and names `id`. */
export function loadReviewerRevision(
    id: string = REVIEWER_REVISIONS.at(-1) as string,
    dir = join(import.meta.dir, "..", "..", "prereg"),
): ReviewerRevision {
    const value: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    const errors = validateReviewerRevision(value);
    if (errors.length === 0 && (value as Obj).id !== id) errors.push(`id: differs from ${id}.json`);
    if (errors.length > 0) throw new Error(`prereg/${id}.json refused: ${errors.join("; ")}`);
    // SAFETY: validateReviewerRevision reported no error, so value has the shape it checks.
    return value as ReviewerRevision;
}
