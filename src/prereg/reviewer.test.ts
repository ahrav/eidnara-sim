import { describe, expect, test } from "bun:test";
import { GRADING_REVISIONS } from "./grading";
import {
    CHANGE_LABELS,
    loadReviewerRevision,
    REVIEWER_REVISIONS,
    reviewerRevisionHash,
    validateReviewerRevision,
} from "./reviewer";

const g16 = loadReviewerRevision();
const edited = (change: (r: Record<string, unknown>) => void) => {
    const copy = structuredClone(g16) as unknown as Record<string, unknown>;
    change(copy);
    return validateReviewerRevision(copy);
};
const validation = (change: (v: Record<string, unknown>) => void) =>
    edited((r) => change(r.validation as Record<string, unknown>));

describe("the reviewer-change revision", () => {
    test("G16 grades a reviewer change by a judge's label, keeps the registered literal rule as R1.v1, and names the in-force reading", () => {
        expect(REVIEWER_REVISIONS.at(-1)).toBe("G16");
        expect(g16).toMatchObject({
            id: "G16",
            revision: 16,
            subject: "reviewer-change",
            change_rule: "judged-row-ended",
            delivery_rule: "scenario-records-in-force",
            secondary_metric: { name: "R1.v1", rule: "target-literal-status" },
            labels: ["R", "P", "W", "U"],
            right_labels: ["R"],
            partial_labels: ["P"],
            wrong_labels: ["W"],
            judge: { calls: 1 },
        });
        expect(validateReviewerRevision(g16)).toEqual([]);
        expect(reviewerRevisionHash(g16)).toMatch(/^[0-9a-f]{64}$/);
    });

    test("the judge agrees with the labels on each split more often than the literal rule does over all of them", () => {
        const v = g16.validation;
        expect(v.design.changes + v.test.changes).toBe(v.labelled_changes);
        expect(CHANGE_LABELS.reduce((n, l) => n + v.label_counts[l], 0)).toBe(v.labelled_changes);
        expect(v.design.agreed + v.test.agreed).toBeGreaterThan(v.literal_rule.agreed);
        // A rule that calls every change right would score the count of R; the judge beats it on the labelled set.
        expect(v.design.agreed + v.test.agreed).toBeGreaterThan(v.label_counts.R);
    });

    test("a revision is held to its shape", () => {
        expect(validateReviewerRevision(null)).toEqual(["expected an object"]);
        expect(edited((r) => Object.assign(r, { schema: "sim-grading-revision/v1" }))).toEqual([
            "schema: expected sim-reviewer-change-revision/v1",
        ]);
        expect(edited((r) => Object.assign(r, { id: "G15" }))).toEqual([
            "id: expected one of G16",
            "revision: expected the integer the id names",
        ]);
        expect(edited((r) => Object.assign(r, { frozen: false }))).toEqual([
            "frozen: expected true",
        ]);
        expect(edited((r) => Object.assign(r, { change_rule: "literal" }))).toEqual([
            "change_rule: expected judged-row-ended",
        ]);
        expect(
            edited((r) => Object.assign(r, { secondary_metric: { name: "R1.v2", rule: "x" } })),
        ).toEqual(["secondary_metric: expected R1.v1 under target-literal-status"]);
        expect(edited((r) => Object.assign(r, { right_labels: ["R", "P"] }))).toEqual([
            "right_labels: expected R alone",
        ]);
        expect(edited((r) => Object.assign(r, { labels: ["R", "W"] }))).toEqual([
            "labels: expected R, P, W, U",
        ]);
        expect(
            edited((r) => Object.assign(r, { judge: { model: "m", max_tokens: 0, calls: 1 } })),
        ).toEqual(["judge: expected a model, a positive max_tokens, and one call per change"]);
        expect(edited((r) => Object.assign(r, { rubric: "R: x\nP: x\nW: x" }))).toEqual([
            "rubric: defines no label U",
        ]);
        expect(edited((r) => Object.assign(r, { extra: 1 }))).toEqual([
            "revision.extra: unknown key",
        ]);
    });

    test("the labelled set is held to its counts", () => {
        expect(
            validation((v) => Object.assign(v, { label_counts: { R: 1, P: 1, W: 1, U: 1 } })),
        ).toEqual([
            "validation.label_counts: expected one count per label summing to labelled_changes",
        ]);
        expect(
            validation((v) =>
                Object.assign(v.test as object, {
                    campaigns: (v.design as { campaigns: string[] }).campaigns,
                }),
            ),
        ).toEqual([
            "validation: a campaign lies in the design split or the test split, one of them",
        ]);
        expect(
            validation((v) => Object.assign(v.design as object, { campaigns: ["nowhere"] })),
        ).toEqual(["validation.design.campaigns: expected distinct qualification registrations"]);
        expect(validation((v) => Object.assign(v.design as object, { agreed: 10_000 }))).toEqual([
            "validation.design: expected agreed changes within the change count",
        ]);
        expect(validation((v) => Object.assign(v, { label_passes: 1 }))).toEqual([
            "validation.label_passes: expected at least two independent passes",
        ]);
        expect(
            validation((v) =>
                Object.assign(v, {
                    label_pass_agreement: { four_class: "1.2", right_rest: "0.9" },
                }),
            ),
        ).toEqual(["validation.label_pass_agreement: expected canonical decimals in [0, 1]"]);
        expect(validation((v) => Object.assign(v, { hand_audited: 10_000 }))).toEqual([
            "validation.hand_audited: expected a count within the labelled changes",
        ]);
        expect(
            validation((v) => Object.assign(v, { literal_rule: { changes: 1, agreed: 1 } })),
        ).toEqual(["validation.literal_rule: expected its agreement over the labelled changes"]);
    });

    test("a file of another schema is refused, and the probe graders' revisions leave this one out", () => {
        expect(() => loadReviewerRevision("G15")).toThrow("prereg/G15.json refused");
        // `graderDigest` reads the files of `GRADING_REVISIONS`, so the probe grades of a finished run stand.
        expect((GRADING_REVISIONS as readonly string[]).includes("G16")).toBe(false);
    });
});
