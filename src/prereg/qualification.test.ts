import { expect, test } from "bun:test";
import { loadPrereg, loadQualification } from "../scenario/inputs";
import {
    qualificationHash,
    qualificationSeed,
    RANKING_GATE_ITEMS,
    validateQualification,
} from "./qualification";
import { preregistrationHash } from "./validate";

const S = loadPrereg("S");
const Q = loadQualification("Q");
const edit = (patch: (q: Record<string, unknown>) => void) => {
    const q = structuredClone(Q) as unknown as Record<string, unknown>;
    patch(q);
    return validateQualification(q, S);
};
/** Edits a copy without its optional sections, whose checks read the arms an edit replaces. */
const editArms = (patch: (q: Record<string, unknown>) => void) =>
    edit((q) => {
        for (const k of ["aa_controls", "holdout", "ranking_gate", "no_source_control"]) {
            delete q[k];
        }
        patch(q);
    });

test("Q binds the current S pre-registration and runs the three delivery modes it can", () => {
    expect(validateQualification(Q, S)).toEqual([]);
    expect(Q.tier_preregistration_sha256).toBe(preregistrationHash(S));
    expect(Q.arms.run).toEqual(["host", "eidnara", "host-oracle"]);
    expect(Q.controls).toEqual(["wrong-project-lookup"]);
    expect(qualificationHash(Q)).toMatch(/^[0-9a-f]{64}$/);
});

test("a stale tier digest, a foreign seed or host, and an unknown field are refused", () => {
    expect(edit((q) => (q.tier_preregistration_sha256 = "0".repeat(64)))[0]).toMatch(
        /hashes to 583e428d/,
    );
    expect(edit((q) => (q.seeds = [101, 201]))).toContain("seeds: 201 is not a S seed");
    expect(edit((q) => (q.hosts = ["opencode", "cursor"]))[0]).toMatch(
        /^hosts\[?.*expected one of/,
    );
    expect(edit((q) => (q.extra = 1))).toContain("extra: unknown field");
});

test("an arm without a profile or with a capability gap cannot be registered", () => {
    const run = (arms: string[]) =>
        editArms((q) => {
            q.arms = { run: arms, order_by_seed: [arms, [...arms].reverse()] };
            q.contrasts = [[arms[1], arms[0]]];
        });
    expect(run(["host", "eidnara-x"])).toContain("arms.run: eidnara-x has no profile");
    const gaps = run(["host", "eidnara-search"]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(
        /eidnara-search \(explicit-search-only\) needs memory_injection=switchable/,
    );
    expect(run(["host", "eidnara-hybrid"])[0]).toMatch(/needs side_calls=proxy/);
});

test("orders must permute the run arms, and contrasts must cross delivery modes", () => {
    expect(
        editArms((q) => {
            (q.arms as { order_by_seed: string[][] }).order_by_seed = [
                ["host", "eidnara"],
                ["host"],
            ];
        }),
    ).toEqual([
        "arms.order_by_seed[0]: is not a permutation of arms.run",
        "arms.order_by_seed[1]: is not a permutation of arms.run",
    ]);
    expect(editArms((q) => (q.contrasts = [["eidnara", "eidnara-kl"]]))).toEqual([
        "contrasts[0]: both arms must be run arms",
    ]);
    expect(
        editArms((q) => {
            q.arms = {
                run: ["host", "eidnara", "eidnara-kl"],
                order_by_seed: [
                    ["host", "eidnara", "eidnara-kl"],
                    ["eidnara-kl", "eidnara", "host"],
                ],
            };
            q.contrasts = [["eidnara-kl", "eidnara"]];
        }),
    ).toEqual(["contrasts[0]: eidnara-kl and eidnara deliver the same way"]);
});

test("revision 3 names host as the no-source control beside revision 2's sections", () => {
    expect(Q.revision).toBe(3);
    expect(Q.no_source_control).toBe("host");
    expect(qualificationSeed(Q, 102)).toEqual({
        order: ["host-oracle", "eidnara", "host"],
        run: ["host", "eidnara", "host-oracle"],
        pairs: [
            ["host", "host"],
            ["eidnara", "eidnara"],
        ],
        holdout: false,
    });
    expect(qualificationSeed(Q, 101)?.pairs).toEqual([]);
    expect(qualificationSeed(Q, 103)).toEqual({
        order: ["eidnara", "host"],
        run: ["host", "eidnara"],
        pairs: [],
        holdout: true,
    });
    expect(qualificationSeed(Q, 104)).toBeNull();
    expect(S.seeds).not.toContain(103);
    expect(Q.ranking_gate).toEqual({
        order: ["host-oracle", "eidnara", "host"],
        items: [...RANKING_GATE_ITEMS],
    });
});

test("the no-source control must be a run arm that delivers no memory", () => {
    const control = (value: unknown) => edit((q) => (q.no_source_control = value));
    expect(control("eidnara")).toEqual([
        "no_source_control: eidnara delivers automatic; expected none",
    ]);
    expect(control("host-oracle")).toEqual([
        "no_source_control: host-oracle delivers oracle-context; expected none",
    ]);
    expect(control("eidnara-kl")).toEqual(["no_source_control: expected a run arm"]);
    expect(control(7)).toEqual(["no_source_control: expected a run arm"]);
    expect(edit((q) => delete q.no_source_control)).toEqual([]);
});

test("A/A seeds and pairs, hold-out seeds and orders, and the ranking gate are checked", () => {
    const section = (field: string, value: unknown) => edit((q) => (q[field] = value));
    expect(section("aa_controls", { seeds: [103], pairs: [["host", "host"]] })).toEqual([
        "aa_controls.seeds: 103 is not a registered seed",
    ]);
    expect(section("aa_controls", { seeds: [102], pairs: [["host", "eidnara"]] })).toEqual([
        "aa_controls.pairs[0]: expected one run arm twice",
    ]);
    expect(section("aa_controls", { seeds: [102] })).toEqual(["aa_controls.pairs: missing"]);
    const holdout = (h: Record<string, unknown>) =>
        section("holdout", {
            seeds: [103],
            arms: ["host", "eidnara"],
            order_by_seed: [["eidnara", "host"]],
            pooled: false,
            ...h,
        });
    expect(holdout({ seeds: [102] })).toEqual(["holdout.seeds: 102 is a registered seed"]);
    expect(
        holdout({ arms: ["host", "eidnara-kl"], order_by_seed: [["host", "eidnara-kl"]] }),
    ).toEqual(["holdout.arms: eidnara-kl is not a run arm"]);
    expect(holdout({ order_by_seed: [["host"]] })).toEqual([
        "holdout.order_by_seed[0]: is not a permutation of holdout.arms",
    ]);
    expect(holdout({ seeds: [103, 104] })).toEqual([
        "holdout.order_by_seed: needs one order per hold-out seed",
    ]);
    expect(holdout({ pooled: true })[0]).toMatch(/^holdout\.pooled: /);
    const gate = (g: Record<string, unknown>) =>
        section("ranking_gate", {
            order: ["host-oracle", "eidnara", "host"],
            items: [...RANKING_GATE_ITEMS],
            ...g,
        });
    expect(gate({ order: ["eidnara", "host-oracle", "host"] })).toEqual([
        "ranking_gate.order: expected run arms delivering oracle-context, automatic, none, in that order",
    ]);
    expect(gate({ items: ["P1", "P2"] })[0]).toMatch(/^ranking_gate\.items/);
    expect(gate({ items: ["P1"] })).toEqual([
        `ranking_gate.items: expected ${RANKING_GATE_ITEMS.join(", ")}`,
    ]);
});
