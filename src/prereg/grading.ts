import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import { QUALIFICATIONS } from "./qualification";

export const GRADING_SCHEMA = "sim-grading-revision/v1";
/** The grading revisions under `prereg/`, oldest first; graders apply the last one. */
export const GRADING_REVISIONS = ["G10"] as const;
export type GradingRevisionId = (typeof GRADING_REVISIONS)[number];
export const ABSTAIN_LABELS = ["A", "B", "C", "D"] as const;
export type AbstainLabel = (typeof ABSTAIN_LABELS)[number];

interface Split {
    campaigns: string[];
    answers: number;
    agreed: number;
}

/**
 * A grading rule registered after the tier files froze. A tier file's digest is recorded in
 * every run manifest, so the tier files stay byte-identical and a finished run regrades under
 * the revision. Revision 10 grades P9 from a judge's label of the answer (`judged-abstention`)
 * and keeps the tier files' `abstention-without-guess` rule as the stored metric `P9.v1`.
 */
export interface GradingRevision {
    schema: typeof GRADING_SCHEMA;
    id: GradingRevisionId;
    revision: number;
    frozen: true;
    probe: "P9";
    /** The property the probe names; the rubric's label A states it. */
    property: string;
    abstain_rule: "judged-abstention";
    /** The tier-file rule this revision replaces as the P9 verdict. */
    supersedes: {
        key: "grading.abstain_rule";
        value: "abstention-without-guess";
        tier_revisions_through: number;
    };
    /** The replaced rule, computed on every graded answer and stored beside the verdict. */
    secondary_metric: { name: "P9.v1"; rule: "abstention-without-guess" };
    labels: AbstainLabel[];
    pass_labels: AbstainLabel[];
    /** One call per answer; the stored label is reused while the prompt and judge stay the same. */
    judge: { model: string; max_tokens: number; calls: 1 };
    rubric: string;
    /** The labelled set the rule was chosen on: label counts, label agreement, and each split's agreement. */
    validation: {
        labelled_answers: number;
        label_counts: Record<AbstainLabel, number>;
        label_passes: number;
        label_pass_agreement: { four_class: string; pass_fail: string };
        hand_audited: number;
        design: Split;
        test: Split;
        superseded_rule: { answers: number; agreed: number };
    };
}

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

function splitErrors(v: unknown, at: string): string[] {
    if (!isObj(v)) return [`${at}: expected an object`];
    const errors = keysOf(v, ["campaigns", "answers", "agreed"], at);
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
        !count(v.answers) ||
        (v.answers as number) < 1 ||
        !count(v.agreed) ||
        (v.agreed as number) > (v.answers as number)
    ) {
        errors.push(`${at}: expected agreed answers within the answer count`);
    }
    return errors;
}

/** Every way `value` departs from a grading revision; empty when it is one. */
export function validateGradingRevision(value: unknown): string[] {
    if (!isObj(value)) return ["expected an object"];
    const errors = keysOf(
        value,
        [
            "schema",
            "id",
            "revision",
            "frozen",
            "probe",
            "property",
            "abstain_rule",
            "supersedes",
            "secondary_metric",
            "labels",
            "pass_labels",
            "judge",
            "rubric",
            "validation",
        ],
        "revision",
    );
    if (value.schema !== GRADING_SCHEMA) errors.push(`schema: expected ${GRADING_SCHEMA}`);
    if (!(GRADING_REVISIONS as readonly unknown[]).includes(value.id)) {
        errors.push(`id: expected one of ${GRADING_REVISIONS.join(", ")}`);
    }
    if (!Number.isSafeInteger(value.revision) || value.id !== `G${String(value.revision)}`) {
        errors.push("revision: expected the integer the id names");
    }
    if (value.frozen !== true) errors.push("frozen: expected true");
    if (value.probe !== "P9") errors.push("probe: expected P9");
    if (typeof value.property !== "string" || value.property.trim() === "") {
        errors.push("property: expected the property the probe names");
    }
    if (value.abstain_rule !== "judged-abstention") {
        errors.push("abstain_rule: expected judged-abstention");
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
        secondary.name !== "P9.v1" ||
        secondary.rule !== "abstention-without-guess" ||
        Object.keys(secondary).length !== 2
    ) {
        errors.push("secondary_metric: expected P9.v1 under abstention-without-guess");
    }
    if (!same(value.labels, ABSTAIN_LABELS)) {
        errors.push(`labels: expected ${ABSTAIN_LABELS.join(", ")}`);
    }
    if (!same(value.pass_labels, ["A"])) errors.push("pass_labels: expected A alone");
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
        for (const label of ABSTAIN_LABELS) {
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
        errors.push(...keysOf(counts, ABSTAIN_LABELS, "validation.label_counts"));
        const total = ABSTAIN_LABELS.reduce(
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
                    ["four_class", "pass_fail"],
                    "validation.label_pass_agreement",
                ),
            );
        }
        if (
            !isObj(agreement) ||
            ![agreement.four_class, agreement.pass_fail].every(
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

/** The digest a P9 grade carries for the revision that graded it. */
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

/** The revision graders apply: the last one registered. */
export const currentGradingRevision = (dir?: string): GradingRevision =>
    loadGradingRevision(GRADING_REVISIONS[GRADING_REVISIONS.length - 1] as string, dir);
