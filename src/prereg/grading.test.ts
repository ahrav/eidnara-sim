import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    currentGradingRevision,
    GRADING_REVISIONS,
    type GradingRevision,
    gradingRevisionHash,
    gradingRevisionPath,
    loadGradingRevision,
    validateGradingRevision,
} from "./grading";
import { TIERS } from "./schema";

const g10 = loadGradingRevision("G10");
const edited = (change: (r: Record<string, unknown>) => void) => {
    const copy = structuredClone(g10) as unknown as Record<string, unknown>;
    change(copy);
    return validateGradingRevision(copy);
};

describe("grading revisions", () => {
    test("every registered revision loads, and graders apply the last one", () => {
        for (const id of GRADING_REVISIONS) expect(loadGradingRevision(id).id).toBe(id);
        expect<string>(currentGradingRevision().id).toBe(GRADING_REVISIONS.at(-1) as string);
    });

    test("G10 grades P9 by a judge's label, keeps the tier rule as P9.v1, and passes label A alone", () => {
        expect(g10).toMatchObject({
            probe: "P9",
            abstain_rule: "judged-abstention",
            secondary_metric: { name: "P9.v1", rule: "abstention-without-guess" },
            pass_labels: ["A"],
            judge: { calls: 1 },
        });
        expect(validateGradingRevision(g10)).toEqual([]);
    });

    test("the revision leaves the tier files' own rule as registered", () => {
        const dir = join(import.meta.dir, "..", "..", "prereg");
        for (const tier of TIERS) {
            const prereg = JSON.parse(readFileSync(join(dir, `${tier}.json`), "utf8"));
            expect(prereg.grading.abstain_rule).toBe(g10.supersedes.value);
            expect(prereg.revision).toBeLessThanOrEqual(g10.supersedes.tier_revisions_through);
        }
    });

    test("the recorded validation counts add up and the judge beats the superseded rule on them", () => {
        const v = g10.validation;
        expect(v.design.answers + v.test.answers).toBe(v.labelled_answers);
        expect(Object.values(v.label_counts).reduce((a, b) => a + b, 0)).toBe(v.labelled_answers);
        const rate = (s: { agreed: number; answers: number }) => s.agreed / s.answers;
        expect(rate(v.test)).toBeGreaterThan(rate(v.superseded_rule));
        expect(rate(v.design)).toBeGreaterThan(rate(v.superseded_rule));
    });

    test("a changed rubric, judge, or count changes the digest", () => {
        const base = gradingRevisionHash(g10);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        const variants: GradingRevision[] = [
            { ...g10, rubric: `${g10.rubric} More.` },
            { ...g10, judge: { ...g10.judge, model: "global.openai.other" } },
            { ...g10, validation: { ...g10.validation, hand_audited: 1 } },
        ];
        for (const v of variants) expect(gradingRevisionHash(v)).not.toBe(base);
    });

    test("each departure from the shape is named", () => {
        expect(edited((r) => Object.assign(r, { frozen: false }))).toEqual([
            "frozen: expected true",
        ]);
        expect(edited((r) => Object.assign(r, { extra: 1 }))).toEqual([
            "revision.extra: unknown key",
        ]);
        expect(edited((r) => Object.assign(r, { pass_labels: ["A", "B"] }))).toEqual([
            "pass_labels: expected A alone",
        ]);
        expect(edited((r) => Object.assign(r, { rubric: "A: only one label" }))).toEqual([
            "rubric: defines no label B",
            "rubric: defines no label C",
            "rubric: defines no label D",
        ]);
        expect(
            edited((r) => Object.assign(r, { judge: { model: "", max_tokens: 0, calls: 2 } })),
        ).toEqual(["judge: expected a model, a positive max_tokens, and one call per answer"]);
        expect(edited((r) => Object.assign(r, { revision: 11 }))).toEqual([
            "revision: expected the integer the id names",
        ]);
        expect(
            edited((r) => {
                (r.validation as { test: { agreed: number } }).test.agreed = 10_000;
            }),
        ).toEqual(["validation.test: expected agreed answers within the answer count"]);
        expect(
            edited((r) => {
                (r.validation as { label_counts: { A: number } }).label_counts.A = 1;
            }),
        ).toEqual([
            "validation.label_counts: expected one count per label summing to labelled_answers",
        ]);
        expect(
            edited((r) => {
                Object.assign((r.validation as { label_counts: object }).label_counts, { E: 0 });
            }),
        ).toEqual(["validation.label_counts.E: unknown key"]);
        expect(
            edited((r) => {
                const v = r.validation as { superseded_rule: object; label_pass_agreement: object };
                Object.assign(v.superseded_rule, { note: "x" });
                Object.assign(v.label_pass_agreement, { kappa: "0.9" });
            }),
        ).toEqual([
            "validation.label_pass_agreement.kappa: unknown key",
            "validation.superseded_rule.note: unknown key",
        ]);
        expect(validateGradingRevision(null)).toEqual(["expected an object"]);
    });

    test("a file that names another revision, or none, is refused by name", () => {
        const dir = join(import.meta.dir, "..", "..", "prereg");
        expect(gradingRevisionPath("G10", dir)).toBe(join(dir, "G10.json"));
        expect(() => loadGradingRevision("S", dir)).toThrow("prereg/S.json refused");
        expect(() => loadGradingRevision("G99", dir)).toThrow();
    });
});
