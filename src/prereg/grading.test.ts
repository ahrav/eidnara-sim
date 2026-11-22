import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    type AbstainRevision,
    DEFERRAL_REVISIONS,
    deferralRevisionHash,
    gradingRevisionFor,
    gradingRevisionHash,
    gradingRevisionPath,
    JUDGED_REVISIONS,
    loadDeferralRevision,
    loadGradingRevision,
    loadPositiveRevision,
    loadRuleRevision,
    POSITIVE_REVISIONS,
    positiveRevisionHash,
    RULE_REVISIONS,
    type RuleRevision,
    ruleRevisionHash,
    validateDeferralRevision,
    validateGradingRevision,
    validatePositiveRevision,
    validateRuleRevision,
} from "./grading";
import { TIERS } from "./schema";

const g10 = gradingRevisionFor("P9");
const g11 = gradingRevisionFor("P8-twin");
const edited = (change: (r: Record<string, unknown>) => void) => {
    const copy = structuredClone(g10) as unknown as Record<string, unknown>;
    change(copy);
    return validateGradingRevision(copy);
};

describe("grading revisions", () => {
    test("every registered revision loads, and graders apply the last one of each probe", () => {
        for (const id of JUDGED_REVISIONS) expect(loadGradingRevision(id).id).toBe(id);
        expect<string>(g10.id).toBe("G10");
        expect<string>(g11.id).toBe("G11");
    });

    test("G11 grades P8-twin by a judge's label, keeps the registered rule as P8-twin.v1, passes labels A and P, and counts label C as harm", () => {
        expect(g11).toMatchObject({
            probe: "P8-twin",
            twin_rule: "judged-wrong-project-lookup",
            secondary_metric: { name: "P8-twin.v1", rule: "placed-value-abstention-without-guess" },
            labels: ["A", "P", "B", "C", "D", "E"],
            pass_labels: ["A", "P"],
            harm_labels: ["C"],
            judge: { calls: 1, model: g10.judge.model },
        });
        expect(validateGradingRevision(g11)).toEqual([]);
        const v = g11.validation;
        expect(v.design.answers + v.test.answers).toBe(v.labelled_answers);
        // Over the design and test answers together, the judge agrees with the labels more
        // often than the superseded rule and than a rule that passes every answer, which
        // scores the count of passing labels.
        const judged = v.design.agreed + v.test.agreed;
        expect(judged).toBeGreaterThan(v.superseded_rule.agreed);
        expect(judged).toBeGreaterThan(v.label_counts.A + v.label_counts.P);
    });

    test("a P8-twin revision is held to its own shape", () => {
        const twin = (change: (r: Record<string, unknown>) => void) => {
            const copy = structuredClone(g11) as unknown as Record<string, unknown>;
            change(copy);
            return validateGradingRevision(copy);
        };
        expect(twin((r) => Object.assign(r, { harm_labels: ["B", "C"] }))).toEqual([
            "harm_labels: expected C alone",
        ]);
        expect(twin((r) => Object.assign(r, { pass_labels: ["A"] }))).toEqual([
            "pass_labels: expected A, P",
        ]);
        expect(twin((r) => Object.assign(r, { abstain_rule: "judged-abstention" }))).toEqual([
            "revision.abstain_rule: unknown key",
        ]);
        expect(twin((r) => Object.assign(r, { rubric: "A: x\nB: x\nC: x\nD: x" }))).toEqual([
            "rubric: defines no label P",
            "rubric: defines no label E",
        ]);
        expect(
            twin((r) => {
                const v = r.validation as { label_pass_agreement: Record<string, string> };
                v.label_pass_agreement = { four_class: "0.9", pass_fail: "0.9" };
            }),
        ).toEqual([
            "validation.label_pass_agreement.four_class: unknown key",
            "validation.label_pass_agreement.six_class: missing",
            "validation.label_pass_agreement: expected canonical decimals in [0, 1]",
        ]);
        expect(twin((r) => Object.assign(r, { probe: "P8" }))).toContain(
            "probe: expected one of P9, P8-twin, P3",
        );
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
        const variants: AbstainRevision[] = [
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
        expect(
            edited((r) => {
                const v = r.validation as { design: { campaigns: string[] }; test: object };
                Object.assign(v.test, { campaigns: [...v.design.campaigns] });
            }),
        ).toEqual([
            "validation: a campaign lies in the design split or the test split, one of them",
        ]);
        expect(
            edited((r) => {
                (r.validation as { design: { campaigns: string[] } }).design.campaigns = ["C9"];
            }),
        ).toEqual(["validation.design.campaigns: expected distinct qualification registrations"]);
        expect(
            edited((r) => {
                const v = r.validation as { test: { answers: number; agreed: number } };
                Object.assign(v.test, { answers: 0, agreed: 0 });
            }),
        ).toContain("validation.test: expected agreed answers within the answer count");
        // A revision that is no number is named, and the checks that read it still return.
        expect(
            edited((r) => Object.assign(r, { revision: { valueOf: null, toString: null } })),
        ).toEqual(["revision: expected the integer the id names"]);
        expect(validateGradingRevision(null)).toEqual(["expected an object"]);
    });

    test("a file that names another revision, or none, is refused by name", () => {
        const dir = join(import.meta.dir, "..", "..", "prereg");
        expect(gradingRevisionPath("G10", dir)).toBe(join(dir, "G10.json"));
        expect(() => loadGradingRevision("S", dir)).toThrow("prereg/S.json refused");
        expect(() => loadGradingRevision("G99", dir)).toThrow();
    });
});

describe("rule revisions", () => {
    const g12 = loadRuleRevision("G12");
    const edited = (change: (r: Record<string, unknown>) => void) => {
        const copy = structuredClone(g12) as unknown as Record<string, unknown>;
        change(copy);
        return validateRuleRevision(copy);
    };

    test("every rule revision loads under its own schema, apart from the judged ones", () => {
        for (const id of RULE_REVISIONS) expect(loadRuleRevision(id).id).toBe(id);
        expect(() => loadGradingRevision("G12")).toThrow("prereg/G12.json refused");
        expect(() => loadRuleRevision("G10")).toThrow("prereg/G10.json refused");
    });

    test("G12 registers the P5 product-code rule and the no-work-reply deferral, and keeps each replaced verdict as <probe>.v1", () => {
        expect(g12).toMatchObject({
            probes: ["P2", "P5", "P11"],
            reuse_rule: "product-code-match",
            deferral_rule: "no-work-reply",
            secondary_metrics: [{ name: "P2.v1" }, { name: "P5.v1" }, { name: "P11.v1" }],
            labels: ["U", "K", "M", "Q", "N"],
            pass_labels: ["K", "M"],
            deferred_labels: ["Q"],
        });
        expect(validateRuleRevision(g12)).toEqual([]);
    });

    test("the revision replaces the tier files' question rule and leaves it as registered", () => {
        const dir = join(import.meta.dir, "..", "..", "prereg");
        for (const tier of TIERS) {
            const prereg = JSON.parse(readFileSync(join(dir, `${tier}.json`), "utf8"));
            expect(prereg.grading.no_change_question).toBe(g12.supersedes.value);
            expect(prereg.revision).toBeLessThanOrEqual(g12.supersedes.tier_revisions_through);
        }
        // The registered bound is the last revision a tier file reached.
        const last = Math.max(
            ...TIERS.map(
                (tier) => JSON.parse(readFileSync(join(dir, `${tier}.json`), "utf8")).revision,
            ),
        );
        expect(g12.supersedes.tier_revisions_through).toBe(last);
    });

    test("on each split the rules agree with the labels more often than the replaced rules do over both splits, and the P5 rule's test agreement is at most two points below the judge's", () => {
        const { reuse, deferral } = g12.validation;
        const share = (agreed: number, of: number) => agreed / of;
        const old = share(reuse.superseded_rule.agreed, reuse.superseded_rule.items);
        expect(share(reuse.design.agreed, reuse.design.items)).toBeGreaterThan(old);
        expect(share(reuse.test.agreed, reuse.test.items)).toBeGreaterThan(old);
        expect(share(reuse.test.agreed, reuse.test.items)).toBeGreaterThanOrEqual(
            share(reuse.judge.test_agreed, reuse.test.items) - 0.02,
        );
        const asked = share(deferral.superseded_rule.agreed, deferral.superseded_rule.turns);
        expect(share(deferral.design.agreed, deferral.design.turns)).toBeGreaterThan(asked);
        expect(share(deferral.test.agreed, deferral.test.turns)).toBeGreaterThan(asked);
        // Every labelled P5 turn that did no work is one of the deferral set's turns.
        expect(reuse.label_counts.N).toBe(deferral.label_counts.N);
        expect(reuse.label_counts.Q).toBeLessThanOrEqual(deferral.label_counts.Q);
    });

    test("a changed rubric, rule name, or count changes the digest", () => {
        const base = ruleRevisionHash(g12);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        const reuse = { ...g12.validation.reuse, hand_audited: 1 };
        const variants: RuleRevision[] = [
            { ...g12, rubric: `${g12.rubric} More.` },
            { ...g12, property: "another property" },
            { ...g12, validation: { ...g12.validation, reuse } },
        ];
        for (const v of variants) expect(ruleRevisionHash(v)).not.toBe(base);
    });

    test("each departure from the shape is named", () => {
        const reuse = (r: Record<string, unknown>) =>
            (r.validation as { reuse: Record<string, Record<string, unknown>> }).reuse;
        const deferral = (r: Record<string, unknown>) =>
            (r.validation as { deferral: Record<string, Record<string, unknown>> }).deferral;
        expect(edited((r) => Object.assign(r, { schema: "sim-grading-revision/v1" }))).toEqual([
            "schema: expected sim-grading-rule-revision/v1",
        ]);
        expect(edited((r) => Object.assign(r, { judge: {} }))).toEqual([
            "revision.judge: unknown key",
        ]);
        expect(edited((r) => Object.assign(r, { frozen: false }))).toEqual([
            "frozen: expected true",
        ]);
        expect(edited((r) => Object.assign(r, { labels: ["U", "K", "M", "Q"] }))).toEqual([
            "labels: expected U, K, M, Q, N",
        ]);
        expect(edited((r) => Object.assign(r, { id: "G10", revision: 10 }))).toEqual([
            "id: expected one of G12",
        ]);
        expect(
            edited((r) => {
                (reuse(r) as Record<string, unknown>).label_passes = 1;
            }),
        ).toEqual(["validation.reuse.label_passes: expected at least two independent passes"]);
        expect(
            edited((r) => {
                (deferral(r) as Record<string, unknown>).hand_audited = 10_000;
            }),
        ).toEqual(["validation.deferral.hand_audited: expected a count within the labelled turns"]);
        expect(edited((r) => Object.assign(r, { probes: ["P5"] }))).toEqual([
            "probes: expected P2, P5, P11",
        ]);
        expect(edited((r) => Object.assign(r, { reuse_rule: "added-lines" }))).toEqual([
            "reuse_rule: expected product-code-match",
        ]);
        expect(edited((r) => Object.assign(r, { deferral_rule: "question" }))).toEqual([
            "deferral_rule: expected no-work-reply",
        ]);
        expect(edited((r) => Object.assign(r, { revision: 11 }))).toEqual([
            "revision: expected the integer the id names",
        ]);
        expect(
            edited((r) => {
                (r.supersedes as { key: string }).key = "grading.abstain_rule";
            }),
        ).toEqual(["supersedes: expected the tier rule and the last tier revision it held in"]);
        expect(
            edited((r) => {
                (r.secondary_metrics as unknown[]).pop();
            }),
        ).toEqual([
            "secondary_metrics: expected P2.v1 under code-change-or-question, P5.v1 under added-lines-and-applied-commands, P11.v1 under code-change-or-question",
        ]);
        expect(edited((r) => Object.assign(r, { pass_labels: ["K"] }))).toEqual([
            "pass_labels: expected K, M",
        ]);
        expect(edited((r) => Object.assign(r, { deferred_labels: [] }))).toEqual([
            "deferred_labels: expected Q alone",
        ]);
        expect(edited((r) => Object.assign(r, { rubric: "U: a\nK: b\nM: c" }))).toEqual([
            "rubric: defines no label Q",
            "rubric: defines no label N",
        ]);
        expect(edited((r) => Object.assign(r, { rubric: "U: \nK: b\nM: c\nQ: d\nN: e" }))).toEqual([
            "rubric: defines no label U",
        ]);
        expect(
            edited((r) => {
                (reuse(r).label_counts as Record<string, number>).U = 1;
            }),
        ).toEqual([
            "validation.reuse.label_counts: expected one count per label summing to labelled_items",
        ]);
        expect(
            edited((r) => {
                (reuse(r).test as Record<string, number>).agreed = 10_000;
            }),
        ).toEqual(["validation.reuse.test: expected agreed items within the item count"]);
        expect(
            edited((r) => {
                (reuse(r).judge as Record<string, number>).test_agreed = 10_000;
            }),
        ).toEqual([
            "validation.reuse.judge: expected the compared judge's model and its agreement within each split",
        ]);
        expect(
            edited((r) => {
                (reuse(r).label_pass_agreement as Record<string, string>).verdict = "1.5";
            }),
        ).toEqual(["validation.reuse.label_pass_agreement: expected canonical decimals in [0, 1]"]);
        expect(
            edited((r) => {
                Object.assign(deferral(r).test as object, {
                    campaigns: (deferral(r).design as { campaigns: string[] }).campaigns,
                });
            }),
        ).toEqual([
            "validation.deferral: a campaign lies in the design split or the test split, one of them",
        ]);
        expect(
            edited((r) => {
                (deferral(r).superseded_rule as Record<string, number>).turns = 1;
            }),
        ).toEqual([
            "validation.deferral.superseded_rule: expected its agreement over the labelled turns",
        ]);
        expect(
            edited((r) => {
                (deferral(r).design as Record<string, number>).turns = 1;
            }),
        ).toContain("validation.deferral: the design and test splits partition the labelled turns");
        expect(edited((r) => Object.assign(r, { validation: null }))).toEqual([
            "validation: expected an object",
        ]);
        expect(
            edited((r) => {
                (r.supersedes as { tier_revisions_through: number }).tier_revisions_through = -1;
            }),
        ).toEqual(["supersedes: expected the tier rule and the last tier revision it held in"]);
        expect(
            edited((r) => {
                (reuse(r).label_pass_agreement as Record<string, string>).verdict =
                    "1.00000000000000001";
            }),
        ).toEqual(["validation.reuse.label_pass_agreement: expected canonical decimals in [0, 1]"]);
        // A total that is no number is named, and the checks that read it still return.
        expect(
            edited((r) => {
                (reuse(r) as Record<string, unknown>).labelled_items = { valueOf: null };
            }),
        ).toContain("validation.reuse.hand_audited: expected a count within the labelled items");
        expect(
            edited((r) => {
                const total = { valueOf: null, toString: null };
                Object.assign(reuse(r), { labelled_items: total });
                Object.assign(reuse(r).superseded_rule as object, { items: total });
            }),
        ).toContain(
            "validation.reuse.superseded_rule: expected its agreement over the labelled items",
        );
        expect(validateRuleRevision(null)).toEqual(["expected an object"]);
    });
});

describe("the judged revision of P3", () => {
    const g14 = gradingRevisionFor("P3");

    test("G14 labels a no-change P3 reply R, S, Q, or N, passes R alone, counts S as harm, and names no tier key", () => {
        expect<string>(g14.id).toBe("G14");
        expect(g14).toMatchObject({
            probe: "P3",
            applied_rule: "judged-already-applied",
            secondary_metric: { name: "P3.v1", rule: "added-lines-match" },
            labels: ["R", "S", "Q", "N"],
            pass_labels: ["R"],
            harm_labels: ["S"],
            judge: { calls: 1, model: g10.judge.model },
        });
        expect("supersedes" in g14).toBe(false);
        expect(validateGradingRevision(g14)).toEqual([]);
    });

    test("the judge agrees with the labels on more of the judged replies than the replaced rule and than failing every one", () => {
        const v = g14.validation;
        expect(v.design.answers + v.test.answers).toBe(v.labelled_answers);
        const judged = v.design.agreed + v.test.agreed;
        expect(judged).toBeGreaterThan(v.superseded_rule.agreed);
        // A rule that fails every judged reply agrees on the replies whose label fails.
        expect(judged).toBeGreaterThan(v.labelled_answers - v.label_counts.R);
    });

    test("a P3 revision is held to its own shape", () => {
        const applied = (change: (r: Record<string, unknown>) => void) => {
            const copy = structuredClone(g14) as unknown as Record<string, unknown>;
            change(copy);
            return validateGradingRevision(copy);
        };
        expect(applied((r) => Object.assign(r, { pass_labels: ["R", "Q"] }))).toEqual([
            "pass_labels: expected R alone",
        ]);
        expect(applied((r) => Object.assign(r, { harm_labels: [] }))).toEqual([
            "harm_labels: expected S alone",
        ]);
        expect(applied((r) => Object.assign(r, { rubric: "R: x\nS: x\nQ: x" }))).toEqual([
            "rubric: defines no label N",
        ]);
        const superseding = { key: "grading.abstain_rule", value: "x", tier_revisions_through: 9 };
        expect(applied((r) => Object.assign(r, { supersedes: superseding }))).toEqual([
            "revision.supersedes: unknown key",
        ]);
    });
});

describe("the positive-probe revision", () => {
    const g13 = loadPositiveRevision("G13");
    const edited = (change: (r: Record<string, unknown>) => void) => {
        const copy = structuredClone(g13) as unknown as Record<string, unknown>;
        change(copy);
        return validatePositiveRevision(copy);
    };
    const rule = (r: Record<string, unknown>, i: number) =>
        (r.rules as Record<string, unknown>[])[i] as Record<string, unknown>;

    test("every positive-probe revision loads under its own schema, apart from the other kinds", () => {
        for (const id of POSITIVE_REVISIONS) expect(loadPositiveRevision(id).id).toBe(id);
        expect(() => loadRuleRevision("G13")).toThrow("prereg/G13.json refused");
        expect(() => loadGradingRevision("G13")).toThrow("prereg/G13.json refused");
        expect(() => loadPositiveRevision("G12")).toThrow("prereg/G12.json refused");
    });

    test("G13 registers one rule per probe part and keeps each replaced verdict as <probe>.v1", () => {
        expect(validatePositiveRevision(g13)).toEqual([]);
        expect(g13.probes).toEqual(["P1", "P3", "P4", "P6", "P12", "P13"]);
        expect(
            g13.rules.map((r) => [r.probe, r.part ?? "", r.rule, r.secondary_metric.name]),
        ).toEqual([
            ["P1", "", "product-governed-units", "P1.v1"],
            ["P3", "", "product-code-use", "P3.v1"],
            ["P4", "", "product-governed-units", "P4.v1"],
            ["P6", "resume", "product-code-step", "P6.v1"],
            ["P6", "clarify", "choice-left-open", "P6.v1"],
            ["P12", "", "tied-current-entry", "P12.v1"],
            ["P13", "commit", "recorded-commits", "P13.v1"],
            ["P13", "header", "created-source-files", "P13.v1"],
        ]);
        // A session rule with no governed action after the fold is outside the property.
        for (const r of g13.rules.filter((r) => r.probe === "P13")) {
            expect(r.outside_labels).toEqual(["OQ", "OI", "ON"]);
        }
    });

    test("over both splits each rule agrees with the labels at least as often as the rule it replaces", () => {
        for (const r of g13.rules) {
            const v = r.validation;
            expect(v.design.items + v.test.items).toBe(v.labelled_items);
            const agreed = v.design.agreed + v.test.agreed;
            expect([r.probe, r.part, agreed >= v.superseded_rule.agreed]).toEqual([
                r.probe,
                r.part,
                true,
            ]);
        }
    });

    test("a changed rubric, rule name, or count changes the digest", () => {
        const base = positiveRevisionHash(g13);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        const first = g13.rules[0];
        if (!first) throw new Error("G13 holds no rule");
        const with0 = (change: object) => ({
            ...g13,
            rules: [{ ...first, ...change }, ...g13.rules.slice(1)],
        });
        for (const v of [
            with0({ rubric: `${first.rubric} More.` }),
            with0({ property: "another property" }),
            with0({ validation: { ...first.validation, hand_audited: 1 } }),
        ]) {
            expect(positiveRevisionHash(v)).not.toBe(base);
        }
    });

    test("each departure from the shape is named", () => {
        expect(edited((r) => Object.assign(r, { schema: "sim-grading-rule-revision/v1" }))).toEqual(
            ["schema: expected sim-positive-grading-revision/v1"],
        );
        expect(edited((r) => Object.assign(r, { id: "G12" }))).toEqual([
            "id: expected one of G13",
            "revision: expected the integer the id names",
        ]);
        expect(edited((r) => Object.assign(r, { frozen: false }))).toEqual([
            "frozen: expected true",
        ]);
        expect(edited((r) => Object.assign(r, { probes: ["P1"] }))).toEqual([
            "probes: expected P1, P3, P4, P6, P12, P13",
        ]);
        expect(edited((r) => Object.assign(r, { rules: [] }))).toEqual(["rules: expected 8 rules"]);
        expect(edited((r) => Object.assign(rule(r, 0), { rule: "added-lines-units" }))).toEqual([
            "rules[0].rule: expected product-governed-units",
        ]);
        expect(edited((r) => Object.assign(rule(r, 3), { part: "clarify" }))).toEqual([
            "rules[3]: expected P6 resume",
        ]);
        expect(edited((r) => Object.assign(rule(r, 1), { pass_labels: ["A"] }))).toEqual([
            "rules[1].pass_labels: expected A, R",
        ]);
        expect(edited((r) => Object.assign(rule(r, 6), { outside_labels: ["OQ"] }))).toEqual([
            "rules[6].outside_labels: expected OQ, OI, ON",
        ]);
        expect(
            edited((r) =>
                Object.assign(rule(r, 5), { secondary_metric: { name: "P12.v2", rule: "x" } }),
            ),
        ).toEqual([
            "rules[5].secondary_metric: expected P12.v1 under entry-without-superseded-identity",
        ]);
        const renamed = { name: "P12.v1", rule: "added-lines-match" };
        expect(edited((r) => Object.assign(rule(r, 5), { secondary_metric: renamed }))).toEqual([
            "rules[5].secondary_metric: expected P12.v1 under entry-without-superseded-identity",
        ]);
        expect(edited((r) => Object.assign(rule(r, 0), { labels: ["A", "X"] }))).toEqual([
            "rules[0].labels: expected A, X, S, I, Q, N",
        ]);
        expect(edited((r) => Object.assign(rule(r, 4), { rubric: "A: x\nP: x\nX: x" }))).toEqual([
            "rules[4].rubric: defines no label N",
        ]);
        expect(
            edited((r) => {
                (rule(r, 2).validation as Record<string, unknown>).label_passes = 1;
            }),
        ).toEqual(["rules[2].validation.label_passes: expected at least two independent passes"]);
        expect(
            edited((r) => {
                (rule(r, 0).validation as Record<string, unknown>).hand_audited = 100_000;
            }),
        ).toEqual(["rules[0].validation.hand_audited: expected a count within the labelled items"]);
    });
});

describe("deferral revisions", () => {
    const g15 = loadDeferralRevision("G15");
    const edited = (change: (r: Record<string, unknown>) => void) => {
        const copy = structuredClone(g15) as unknown as Record<string, unknown>;
        change(copy);
        return validateDeferralRevision(copy);
    };
    const validation = (r: Record<string, unknown>) => r.validation as Record<string, unknown>;

    test("every deferral revision loads under its own schema, apart from the other kinds", () => {
        for (const id of DEFERRAL_REVISIONS) expect(loadDeferralRevision(id).id).toBe(id);
        expect(() => loadRuleRevision("G15")).toThrow("prereg/G15.json refused");
        expect(() => loadGradingRevision("G15")).toThrow("prereg/G15.json refused");
        expect(() => loadDeferralRevision("G12")).toThrow("prereg/G12.json refused");
        expect(deferralRevisionHash(g15)).toMatch(/^[0-9a-f]{64}$/);
        // The digest covers the rubric and the counts.
        const reworded = { ...g15, rubric: `${g15.rubric} More.` };
        expect(deferralRevisionHash(reworded)).not.toBe(deferralRevisionHash(g15));
        const recounted = structuredClone(g15);
        recounted.validation.hand_audited += 1;
        expect(deferralRevisionHash(recounted)).not.toBe(deferralRevisionHash(g15));
    });

    test("G15 extends the no-work-reply rule of G12 to P1 and replaces the fail G13 gives such a turn", () => {
        expect(validateDeferralRevision(g15)).toEqual([]);
        expect(g15).toMatchObject({
            probes: ["P1"],
            deferral_rule: loadRuleRevision("G12").deferral_rule,
            extends: "G12",
            replaces: { revision: "G13", rule: "product-governed-units", verdict: "fail" },
            reported_metrics: [
                { name: "P12.reply_names_identity", rule: "reply-matches-identity" },
            ],
            labels: ["O", "D", "N"],
            deferred_labels: ["O"],
        });
        // The replaced rule is the one G13 registers for P1.
        const p1 = loadPositiveRevision("G13").rules.find((r) => r.probe === "P1");
        expect(g15.replaces.rule).toBe(p1?.rule as string);
    });

    test("the labelled turns hold the counts the rule was chosen on", () => {
        const v = g15.validation;
        expect(v.design.turns + v.test.turns).toBe(v.labelled_turns);
        expect(v.label_counts.O + v.label_counts.D + v.label_counts.N).toBe(v.labelled_turns);
        // The rule defers every turn with a reply, so it agrees on the O turns, and on an N turn
        // whose reply is empty; the replaced rule fails every turn, so it agrees on D and N.
        expect(v.design.agreed + v.test.agreed).toBeGreaterThanOrEqual(v.label_counts.O);
        expect(v.design.agreed + v.test.agreed).toBeLessThanOrEqual(
            v.label_counts.O + v.label_counts.N,
        );
        expect(v.superseded_rule.agreed).toBe(v.label_counts.D + v.label_counts.N);
        // The design campaigns are the c8 ones and the test campaigns the later ones.
        expect(v.design.campaigns.every((c) => c.startsWith("C8"))).toBe(true);
        expect(v.test.campaigns.every((c) => c.startsWith("W"))).toBe(true);
    });

    test("a revision that departs from the registered rule is refused by field", () => {
        expect(validateDeferralRevision(null)).toEqual(["expected an object"]);
        expect(edited((r) => (r.schema = "sim-grading-rule-revision/v1"))).toEqual([
            "schema: expected sim-deferral-revision/v1",
        ]);
        expect(edited((r) => Object.assign(r, { id: "G12" }))).toEqual([
            "id: expected one of G15",
            "revision: expected the integer the id names",
        ]);
        expect(edited((r) => (r.frozen = false))).toEqual(["frozen: expected true"]);
        expect(edited((r) => (r.probes = ["P1", "P3"]))).toEqual(["probes: expected P1 alone"]);
        expect(edited((r) => (r.property = " "))).toEqual([
            "property: expected the property the probe names",
        ]);
        expect(edited((r) => (r.deferral_rule = "question"))).toEqual([
            "deferral_rule: expected no-work-reply",
        ]);
        expect(edited((r) => (r.extends = "G13"))).toEqual(["extends: expected G12"]);
        for (const replaces of [
            { revision: "G12", rule: "product-governed-units", verdict: "fail" },
            { revision: "G13", rule: "product-code-use", verdict: "fail" },
            { revision: "G13", rule: "product-governed-units", verdict: "pass" },
            { revision: "G13", rule: "product-governed-units", verdict: "fail", part: "x" },
            null,
        ]) {
            expect(edited((r) => (r.replaces = replaces))).toEqual([
                "replaces: expected the fail of G13's rule product-governed-units",
            ]);
        }
        for (const reported of [
            [],
            [{ name: "P12.reply_names_identity", rule: "other" }],
            [{ name: "P12.names", rule: "reply-matches-identity" }],
            [
                { name: "P12.reply_names_identity", rule: "reply-matches-identity" },
                { name: "P1.asked", rule: "reply-holds-text" },
            ],
            null,
        ]) {
            expect(edited((r) => (r.reported_metrics = reported))).toEqual([
                "reported_metrics: expected P12.reply_names_identity under reply-matches-identity",
            ]);
        }
        expect(edited((r) => (r.labels = ["O", "N"]))[0]).toBe("labels: expected O, D, N");
        expect(edited((r) => (r.deferred_labels = ["O", "D"]))).toEqual([
            "deferred_labels: expected O alone",
        ]);
        expect(
            edited((r) => (r.rubric = String(r.rubric).replace(/^D: /m, "Determined: "))),
        ).toEqual(["rubric: defines no label D"]);
        expect(edited((r) => (r.judge = { model: "m" }))).toEqual(["revision.judge: unknown key"]);
        expect(edited((r) => delete r.validation)).toEqual([
            "revision.validation: missing",
            "validation: expected an object",
        ]);
    });

    test("the validation counts are held to the labelled turns", () => {
        expect(edited((r) => (validation(r).labelled_turns = 158))).toContain(
            "validation.label_counts: expected one count per label summing to labelled_turns",
        );
        expect(
            edited((r) => ((validation(r).design as Record<string, unknown>).agreed = 999)),
        ).toEqual(["validation.design: expected agreed turns within the turn count"]);
        expect(
            edited((r) => ((validation(r).test as Record<string, unknown>).campaigns = ["C8"])),
        ).toEqual([
            "validation: a campaign lies in the design split or the test split, one of them",
        ]);
        expect(edited((r) => (validation(r).label_passes = 1))).toEqual([
            "validation.label_passes: expected at least two independent passes",
        ]);
        expect(edited((r) => (validation(r).label_pass_agreement = { labels: "0.99" }))).toContain(
            "validation.label_pass_agreement.verdict: missing",
        );
        expect(edited((r) => (validation(r).hand_audited = 1000))).toEqual([
            "validation.hand_audited: expected a count within the labelled turns",
        ]);
        expect(edited((r) => (validation(r).superseded_rule = { turns: 1, agreed: 0 }))).toEqual([
            "validation.superseded_rule: expected its agreement over the labelled turns",
        ]);
    });
});
