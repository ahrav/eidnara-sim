import { expect, test } from "bun:test";
import { loadPrereg, loadQualification } from "../scenario/inputs";
import { qualificationHash, validateQualification } from "./qualification";
import { preregistrationHash } from "./validate";

const S = loadPrereg("S");
const Q = loadQualification("Q");
const edit = (patch: (q: Record<string, unknown>) => void) => {
    const q = structuredClone(Q) as unknown as Record<string, unknown>;
    patch(q);
    return validateQualification(q, S);
};

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
        edit((q) => {
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
        edit((q) => {
            (q.arms as { order_by_seed: string[][] }).order_by_seed = [
                ["host", "eidnara"],
                ["host"],
            ];
        }),
    ).toEqual([
        "arms.order_by_seed[0]: is not a permutation of arms.run",
        "arms.order_by_seed[1]: is not a permutation of arms.run",
    ]);
    expect(edit((q) => (q.contrasts = [["eidnara", "eidnara-kl"]]))).toEqual([
        "contrasts[0]: both arms must be run arms",
    ]);
    expect(
        edit((q) => {
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
