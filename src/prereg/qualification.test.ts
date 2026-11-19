import { expect, test } from "bun:test";
import { auditedBuild, DAEMON_VARIANTS } from "../hosts/profiles";
import { loadPrereg, loadQualification } from "../scenario/inputs";
import {
    buildRefusal,
    promptCachingOf,
    qualificationHash,
    qualificationSeed,
    RANKING_GATE_ITEMS,
    referenceBuildArms,
    referenceErrors,
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
        /hashes to 2a9773e7/,
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
    expect(run(["host", "eidnara-search"])).toEqual([]);
    expect(run(["host", "eidnara-hybrid"])).toEqual([]);
    const fixture = DAEMON_VARIANTS["direct-host-fixture"];
    fixture.memory_injection = "always-on";
    try {
        const gaps = run(["host", "eidnara-search"]);
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatch(
            /eidnara-search \(explicit-search-only\) needs memory_injection=switchable/,
        );
    } finally {
        fixture.memory_injection = "switchable";
    }
});

test("orders must permute the run arms, and contrasts must cross delivery modes or search routes", () => {
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
    ).toEqual(["contrasts[0]: eidnara-kl and eidnara deliver and search the same way"]);
    expect(
        editArms((q) => {
            q.arms = {
                run: ["host", "eidnara", "eidnara-hybrid"],
                order_by_seed: [
                    ["host", "eidnara", "eidnara-hybrid"],
                    ["eidnara-hybrid", "eidnara", "host"],
                ],
            };
            q.contrasts = [["eidnara-hybrid", "eidnara"]];
        }),
    ).toEqual([]);
});

test("revision 5 re-pins S revision 9 and keeps host as the no-source control", () => {
    expect(Q.revision).toBe(5);
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

test("H binds the current M pre-registration and runs fresh seeds on the held-out corpus", () => {
    const M = loadPrereg("M");
    const H = loadQualification("H");
    expect(validateQualification(H, M)).toEqual([]);
    expect(H.tier_preregistration_sha256).toBe(preregistrationHash(M));
    expect(H.corpus).toBe("held-out");
    expect(H.seeds.filter((s) => M.seeds.includes(s))).toEqual([]);
    expect(Q.corpus).toBeUndefined();
    const editH = (patch: (q: Record<string, unknown>) => void) => {
        const q = structuredClone(H) as unknown as Record<string, unknown>;
        patch(q);
        return validateQualification(q, M);
    };
    expect(editH((q) => (q.seeds = [601, 201]))).toContain(
        "seeds: 201 is a M seed, which compiles from the diagnosed corpus",
    );
    expect(editH((q) => (q.corpus = "fresh"))[0]).toMatch(
        /^corpus: expected one of diagnosed, held-out/,
    );
    expect(edit((q) => (q.corpus = "held-out"))).toContain(
        "seeds: 101 is a S seed, which compiles from the diagnosed corpus",
    );
    expect(edit((q) => (q.corpus = "diagnosed"))).toEqual([]);
    expect(
        editH((q) => {
            q.holdout = { seeds: [201], arms: ["host"], order_by_seed: [["host"]], pooled: false };
        }),
    ).toEqual(["holdout.seeds: 201 is a M seed, which compiles from the diagnosed corpus"]);
});

test("C8 runs fresh diagnosed seeds, and C8H three of H's held-out seeds, over the four c8 arms", () => {
    const M = loadPrereg("M");
    const H = loadQualification("H");
    const C8 = loadQualification("C8");
    const C8H = loadQualification("C8H");
    for (const q of [C8, C8H]) {
        expect(validateQualification(q, M)).toEqual([]);
        expect(q.tier_preregistration_sha256).toBe(preregistrationHash(M));
        expect(q.arms.run).toEqual(["host", "eidnara", "eidnara-hybrid", "eidnara-search"]);
        expect(q.contrasts).toEqual([
            ["eidnara", "host"],
            ["eidnara-hybrid", "eidnara"],
            ["eidnara", "eidnara-search"],
        ]);
        expect(q.analysis?.unit).toBe("run");
    }
    expect(C8.corpus).toBe("diagnosed");
    expect(C8.fresh_seeds).toBe(true);
    expect(C8.seeds.filter((s) => M.seeds.includes(s))).toEqual([]);
    expect(C8H.corpus).toBe("held-out");
    expect(C8H.seeds.every((s) => H.seeds.includes(s))).toBe(true);
    expect(C8.seeds.filter((s) => C8H.seeds.includes(s))).toEqual([]);
    expect(C8.replicates).toEqual({ seeds: [204, 206], arms: ["host", "eidnara"] });
});

test("C8X and C8XH rerun the hybrid arm alone over C8's and C8H's seeds, with c8 as reference", () => {
    const M = loadPrereg("M");
    const pairs = [
        [loadQualification("C8X"), loadQualification("C8")],
        [loadQualification("C8XH"), loadQualification("C8H")],
    ] as const;
    for (const [rerun, original] of pairs) {
        expect(validateQualification(rerun, M)).toEqual([]);
        expect(rerun.arms.run).toEqual(["eidnara-hybrid"]);
        expect(rerun.contrasts).toEqual([]);
        expect(rerun.seeds).toEqual(original.seeds);
        expect(rerun.corpus).toBe(original.corpus);
        expect(rerun.fresh_seeds).toBe(original.fresh_seeds);
        // The controls decide the compiled items, so the rerun's scenarios match the original's.
        expect(rerun.controls).toEqual(original.controls);
        expect(rerun.analysis?.reference).toEqual({ campaign: "c8", level: "seed" });
        expect(rerun.analysis?.harm_probes).toEqual(original.analysis?.harm_probes);
        expect(rerun.reference_runs).toEqual({
            registration: original.id,
            contrasts: [["eidnara-hybrid", "eidnara"]],
        });
        expect(referenceErrors(rerun, original)).toEqual([]);
    }
    // The rerun keeps its reference registration's seeds, split, and controls, and pairs with one of
    // its run arms.
    const [C8X, C8] = pairs[0];
    const H = loadQualification("H");
    expect(referenceErrors(C8X, { ...C8, seeds: [204, 206] })).toEqual([
        "reference_runs: seeds differs from C8's",
    ]);
    expect(referenceErrors(C8X, { ...C8, controls: [] as never[] })).toEqual([
        "reference_runs: controls differs from C8's",
    ]);
    expect(referenceErrors(C8X, H)).toEqual([
        "reference_runs: corpus differs from H's",
        "reference_runs: fresh_seeds differs from H's",
        "reference_runs: seeds differs from H's",
    ]);
    expect(referenceErrors(C8X, { ...C8, arms: { run: ["host"], order_by_seed: [] } })).toEqual([
        "reference_runs.contrasts[0]: eidnara is not a C8 run arm",
    ]);
    const edit = (patch: (q: Record<string, unknown>) => void) => {
        const q = structuredClone(C8X) as unknown as Record<string, unknown>;
        patch(q);
        return validateQualification(q, M);
    };
    expect(
        edit((q) => {
            q.arms = {
                run: ["eidnara-hybrid", "eidnara"],
                order_by_seed: C8X.seeds.map(() => ["eidnara-hybrid", "eidnara"]),
            };
            q.analysis = {
                ...(C8X.analysis as object),
                cost_per_arm_seed_usd: { "eidnara-hybrid": 5489, eidnara: 5489 },
            };
        }),
    ).toEqual(["contrasts: a registration that runs two or more arms names a contrast"]);
    expect(edit((q) => delete q.reference_runs)).toEqual([
        "contrasts: a one-arm registration names its contrasts in reference_runs",
    ]);
    const runs = (contrasts: string[][], registration = "C8") =>
        edit((q) => (q.reference_runs = { registration, contrasts }));
    expect(runs([["eidnara-hybrid", "eidnara"]], "C8X")).toEqual([
        "reference_runs.registration: names this registration",
    ]);
    expect(runs([["eidnara", "host"]])).toEqual([
        "reference_runs.contrasts[0]: eidnara is not a run arm",
    ]);
    expect(runs([["eidnara-hybrid", "nope"]])).toEqual([
        "reference_runs.contrasts[0]: nope has no profile",
    ]);
});

test("fresh seeds, replicates, and the analysis plan are checked against the registration", () => {
    const M = loadPrereg("M");
    const C8 = loadQualification("C8");
    const editC = (patch: (q: Record<string, unknown>) => void) => {
        const q = structuredClone(C8) as unknown as Record<string, unknown>;
        patch(q);
        return validateQualification(q, M);
    };
    expect(editC((q) => (q.seeds = [201, 206, 207, 208, 209]))).toContain(
        "seeds: 201 is a M seed, and a fresh-seed registration runs none",
    );
    expect(editC((q) => delete q.fresh_seeds)).toContain("seeds: 204 is not a M seed");
    expect(editC((q) => (q.fresh_seeds = false))).toContain("fresh_seeds: expected true");
    expect(editC((q) => (q.corpus = "held-out"))).toContain(
        "fresh_seeds: a held-out registration's seeds lie outside the tier's already",
    );
    expect(editC((q) => (q.replicates = { seeds: [205], arms: ["host"] }))).toEqual([
        "replicates.seeds: 205 is not a registered seed",
    ]);
    expect(editC((q) => (q.replicates = { seeds: [204], arms: ["host-oracle"] }))).toEqual([
        "replicates.arms: host-oracle is not a run arm",
    ]);
    const analysis = C8.analysis as unknown as Record<string, unknown>;
    expect(
        editC((q) => (q.analysis = { ...analysis, budget_usd: { low: 300000, high: 204000 } })),
    ).toEqual(["analysis.budget_usd: low exceeds high"]);
    expect(
        editC((q) => (q.analysis = { ...analysis, cost_per_arm_seed_usd: { host: 5735 } })),
    ).toEqual(["analysis.cost_per_arm_seed_usd: expected one cost per run arm"]);
    expect(editC((q) => (q.analysis = { ...analysis, harm_probes: ["P99"] }))[0]).toMatch(
        /^analysis\.harm_probes/,
    );
    expect(editC((q) => (q.analysis = { ...analysis, unit: "item" }))[0]).toMatch(
        /^analysis\.unit/,
    );
});

test("W2S and W2SH compare one arm across two audited builds on fresh S seeds", () => {
    const S = loadPrereg("S");
    const Q = loadQualification("Q");
    const H = loadQualification("H");
    const W2S = loadQualification("W2S");
    const W2SH = loadQualification("W2SH");
    const used = [...S.seeds, ...Q.seeds, ...(Q.holdout?.seeds ?? [])];
    for (const q of [W2S, W2SH]) {
        expect(validateQualification(q, S)).toEqual([]);
        expect(q.arms.run).toEqual(["host", "eidnara", "eidnara-hybrid"]);
        expect(q.controls).toEqual(["wrong-project-lookup"]);
        expect(q.no_source_control).toBe("host");
        expect(q.seeds.filter((s) => used.includes(s) || H.seeds.includes(s))).toEqual([]);
        // The registration names the builds its runs bind by the commits the capability tables hold.
        expect(q.builds?.current).toEqual({
            label: "eval/w2",
            commit: auditedBuild("eval/w2")?.commit as string,
        });
        expect(q.builds?.reference).toEqual({
            label: "eval/c8",
            commit: auditedBuild("eval/c8")?.commit as string,
        });
        expect(q.builds?.contrasts).toEqual([
            ["eidnara", "eidnara"],
            ["eidnara-hybrid", "eidnara"],
        ]);
        expect(referenceBuildArms(q)).toEqual(["eidnara"]);
    }
    expect(W2S.corpus).toBe("diagnosed");
    expect(W2S.fresh_seeds).toBe(true);
    expect(W2S.seeds).toHaveLength(2);
    expect(W2SH.corpus).toBe("held-out");
    expect(W2SH.seeds).toHaveLength(1);
});

test("W2S2 and W2S2H rerun the focused run's seeds on the current build and add one fresh seed each", () => {
    const S = loadPrereg("S");
    const Q = loadQualification("Q");
    const H = loadQualification("H");
    const pairs = [
        [loadQualification("W2S2"), loadQualification("W2S")],
        [loadQualification("W2S2H"), loadQualification("W2SH")],
    ] as const;
    const used = [...S.seeds, ...Q.seeds, ...(Q.holdout?.seeds ?? []), ...H.seeds];
    for (const [rerun, first] of pairs) {
        expect(validateQualification(rerun, S)).toEqual([]);
        expect(rerun.corpus).toBe(first.corpus);
        expect(rerun.arms.run).toEqual(first.arms.run);
        expect(rerun.contrasts).toEqual(first.contrasts);
        expect(rerun.controls).toEqual(first.controls);
        expect(rerun.no_source_control).toBe(first.no_source_control);
        expect(rerun.arms.order_by_seed).toHaveLength(rerun.seeds.length);
        // The first run's seeds lead, and exactly one seed follows that no registration lists.
        expect(rerun.seeds.slice(0, first.seeds.length)).toEqual(first.seeds);
        const added = rerun.seeds.slice(first.seeds.length);
        expect(added).toHaveLength(1);
        expect(added.filter((s) => used.includes(s))).toEqual([]);
        expect(rerun.builds?.current).toEqual({
            label: "eval/w2b",
            commit: auditedBuild("eval/w2b")?.commit as string,
        });
        expect(rerun.builds?.reference).toEqual(first.builds?.reference);
        expect(rerun.builds?.contrasts).toEqual(first.builds?.contrasts);
        expect(referenceBuildArms(rerun)).toEqual(["eidnara"]);
        const { current, reference } = rerun.builds as NonNullable<typeof rerun.builds>;
        expect(buildRefusal(rerun, current, ["host", "eidnara", "eidnara-hybrid"])).toBeNull();
        expect(buildRefusal(rerun, reference, ["eidnara"])).toBeNull();
        // A clone that holds the first focused run's build is refused for the rerun.
        const earlier = first.builds?.current as NonNullable<typeof first.builds>["current"];
        expect(buildRefusal(rerun, earlier, ["eidnara"])).toBe(
            `qualification ${rerun.id} runs on eval/w2b (${current.commit}) and its reference arms on eval/c8 (${reference.commit}); the build clone holds eval/w2 (${earlier.commit})`,
        );
    }
    expect(pairs[0][0].fresh_seeds).toBe(true);
    expect(pairs[0][0].seeds).toEqual([104, 105, 106]);
    expect(pairs[1][0].seeds).toEqual([610, 613]);
});

test("a build contrast needs two registered builds, a run arm, and a reference arm its build provides", () => {
    const S = loadPrereg("S");
    const W2S = loadQualification("W2S");
    const builds = W2S.builds as NonNullable<typeof W2S.builds>;
    const edit = (patch: (b: Record<string, unknown>) => void) => {
        const q = structuredClone(W2S) as unknown as Record<string, unknown>;
        patch(q.builds as Record<string, unknown>);
        return validateQualification(q, S);
    };
    // The arm contrasts take one arm per side, so only `builds.contrasts` can pair an arm with itself.
    const plain = structuredClone(W2S) as unknown as Record<string, unknown>;
    delete plain.builds;
    plain.contrasts = [["eidnara", "eidnara"]];
    expect(validateQualification(plain, S)).toEqual(["contrasts: duplicate entries"]);
    expect(edit((b) => (b.current = { label: "eval/w2", commit: "0".repeat(40) }))).toEqual([
        `builds.current: ${"0".repeat(40)} is not an audited build`,
    ]);
    const short = builds.current.commit.slice(0, 9);
    expect(edit((b) => (b.current = { label: "eval/w2", commit: short }))[0]).toMatch(
        /^builds\.current\.commit: expected a full commit hash/,
    );
    expect(edit((b) => (b.reference = { ...builds.reference, label: "eval/w2" }))).toEqual([
        `builds.reference: ${builds.reference.commit} is the audited build eval/c8, not eval/w2`,
    ]);
    expect(edit((b) => (b.reference = builds.current))).toEqual([
        "builds.reference: names the current build",
    ]);
    expect(edit((b) => (b.contrasts = [["eidnara-search", "eidnara"]]))).toEqual([
        "builds.contrasts[0]: eidnara-search is not a run arm",
    ]);
    // The reference side launches under the seed's registered order, so it is a run arm too.
    expect(edit((b) => (b.contrasts = [["eidnara", "eidnara-search"]]))).toEqual([
        "builds.contrasts[0]: eidnara-search is not a run arm",
    ]);
    expect(edit((b) => (b.contrasts = [["eidnara", "nope"]]))).toEqual([
        "builds.contrasts[0]: nope is not a run arm",
    ]);
    expect(edit((b) => (b.contrasts = [["host", "eidnara"]]))).toEqual([
        "builds.contrasts[0]: host runs no Eidnara build",
    ]);
    expect(edit((b) => (b.contrasts = [["eidnara", "eidnara", "host"]]))).toEqual([
        "builds.contrasts[0]: expected a [treatment, reference] pair",
    ]);
    // The c8 build registers the legacy fixture alone, so it cannot carry the fused arm.
    const fused = edit((b) => (b.contrasts = [["eidnara-hybrid", "eidnara-hybrid"]]));
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatch(
        /^builds\.contrasts\[0\]: eidnara-hybrid \(production-hybrid\) runs direct-host-fixture-fused, which the audited build eval\/c8 /,
    );
    // A run arm is read against the registration's current build, so the fused arm is refused
    // when the current build is the one without the fused fixture.
    const swapped = edit((b) => {
        b.current = builds.reference;
        b.reference = builds.current;
    });
    expect(swapped.some((e) => /^arms\.run: eidnara-hybrid .* eval\/c8 /.test(e))).toBe(true);
});

test("a run binds the registration's current build, or its reference build for reference arms alone", () => {
    const W2S = loadQualification("W2S");
    const { current, reference } = W2S.builds as NonNullable<typeof W2S.builds>;
    expect(buildRefusal(W2S, current, ["host", "eidnara", "eidnara-hybrid"])).toBeNull();
    expect(buildRefusal(W2S, reference, ["eidnara"])).toBeNull();
    // A host-only run starts no daemon and binds no build.
    expect(buildRefusal(W2S, null, ["host"])).toBeNull();
    expect(buildRefusal(W2S, reference, ["eidnara", "eidnara-hybrid"])).toBe(
        `qualification W2S runs eidnara on its reference build eval/c8 (${reference.commit}); eidnara-hybrid runs on eval/w2 (${current.commit})`,
    );
    const other = { label: "eval/c8h", commit: "837c3bab3".padEnd(40, "0") };
    expect(buildRefusal(W2S, other, ["eidnara"])).toBe(
        `qualification W2S runs on eval/w2 (${current.commit}) and its reference arms on eval/c8 (${reference.commit}); the build clone holds eval/c8h (${other.commit})`,
    );
    // A registration without the section accepts whichever audited build the clone binds.
    expect(buildRefusal(loadQualification("C8H"), reference, ["eidnara-hybrid"])).toBeNull();
});

test("a registration names its prompt-caching condition, and one that names none runs with it off", () => {
    expect(promptCachingOf(null)).toBe("off");
    expect(promptCachingOf(Q)).toBe("off");
    expect(edit((q) => (q.prompt_caching = "on"))).toEqual([]);
    expect(edit((q) => (q.prompt_caching = "off"))).toEqual([]);
    for (const value of ["1h", true, null]) {
        expect(edit((q) => (q.prompt_caching = value))).toEqual([
            "prompt_caching: expected one of off, on",
        ]);
    }
    // The condition is part of the registration a run binds by hash.
    const on = { ...structuredClone(Q), prompt_caching: "on" as const };
    expect(promptCachingOf(on)).toBe("on");
    expect(qualificationHash(on)).not.toBe(qualificationHash(Q));
});

test("the registrations before the caching condition keep their digests", () => {
    const digests: Record<string, string> = {
        C8: "c3762c53df8901401cbe5c990b773016cc97367d280645145628094a07723ff9",
        C8H: "fc1448b33d715e11794b91d6c1f5444a182817d534886d8e65f92c691f723d02",
        W2S: "c3a0a2df1e3bdcbfa4028e33c85253b5d0ac20a89d5a3260683f4fda444ee4f0",
        W2SH: "8802f2ac4cf0fdc3e558ff3fd3b76734db02ac671ec3f0cdfbde24b34fc263ad",
        W2S2: "c2621c571e56cdf27952c74a04d4a6bb9f8349d8f5044f183f5cb8378aafe01a",
        W2S2H: "1023e9ad1a5880850676d0e4302b8bbe2a5179f81ecaa70d661110aea4f45b36",
    };
    for (const [id, digest] of Object.entries(digests)) {
        const q = loadQualification(id);
        expect(qualificationHash(q)).toBe(digest);
        expect(promptCachingOf(q)).toBe("off");
    }
});

test("PCH runs host and eidnara on C8H's held-out seed 605 with prompt caching on", () => {
    const pch = loadQualification("PCH");
    const c8h = loadQualification("C8H");
    expect(validateQualification(pch, loadPrereg("M"))).toEqual([]);
    expect(promptCachingOf(pch)).toBe("on");
    expect(pch.seeds).toEqual([605]);
    expect(c8h.seeds).toContain(605);
    expect(pch.arms.run).toEqual(["host", "eidnara"]);
    expect(pch.contrasts).toEqual([["eidnara", "host"]]);
    // The split and the controls decide a scenario's items, so seed 605 holds C8H's.
    expect([pch.tier, pch.corpus, pch.controls]).toEqual([c8h.tier, c8h.corpus, c8h.controls]);
    expect(pch.no_source_control).toBe("host");
});

test("W3S and W3SH retest the current build against the w2b build with prompt caching on", () => {
    const S = loadPrereg("S");
    const listed = (ids: string[]) => ids.flatMap((id) => loadQualification(id).seeds);
    const w3s = loadQualification("W3S");
    const w3sh = loadQualification("W3SH");
    for (const [retest, earlier] of [
        [w3s, loadQualification("W2S2")],
        [w3sh, loadQualification("W2S2H")],
    ] as const) {
        expect(validateQualification(retest, S)).toEqual([]);
        expect(promptCachingOf(retest)).toBe("on");
        expect(retest.corpus).toBe(earlier.corpus);
        expect(retest.arms.run).toEqual(earlier.arms.run);
        expect(retest.contrasts).toEqual(earlier.contrasts);
        expect(retest.controls).toEqual(earlier.controls);
        expect(retest.no_source_control).toBe(earlier.no_source_control);
        expect(retest.analysis?.harm_probes).toEqual(earlier.analysis?.harm_probes);
        expect(retest.arms.order_by_seed).toHaveLength(retest.seeds.length);
        // The current build is the treatment, and the build the earlier rerun treated is the reference.
        expect(retest.builds?.current).toEqual({
            label: "eval/w3-all",
            commit: auditedBuild("eval/w3-all")?.commit as string,
        });
        expect(retest.builds?.reference).toEqual(earlier.builds?.current);
        expect(retest.builds?.contrasts).toEqual(earlier.builds?.contrasts);
        expect(referenceBuildArms(retest)).toEqual(["eidnara"]);
        const { current, reference } = retest.builds as NonNullable<typeof retest.builds>;
        expect(buildRefusal(retest, current, ["host", "eidnara", "eidnara-hybrid"])).toBeNull();
        expect(buildRefusal(retest, reference, ["eidnara"])).toBeNull();
        expect(buildRefusal(retest, reference, ["eidnara-hybrid"])).not.toBeNull();
        // A seed the earlier rerun ran keeps its arm order.
        for (const [i, seed] of retest.seeds.entries()) {
            const at = earlier.seeds.indexOf(seed);
            if (at >= 0) {
                expect(retest.arms.order_by_seed[i]).toEqual(earlier.arms.order_by_seed[at]);
            }
        }
    }
    expect(w3s.fresh_seeds).toBe(true);
    expect(w3s.seeds).toEqual([104, 106, 107]);
    expect(w3sh.seeds).toEqual([613, 614]);
    // Each registration adds one seed that no earlier registration lists.
    const earlier = listed(["Q", "H", "C8", "C8H", "C8X", "C8XH", "W2S", "W2SH", "W2S2", "W2S2H"]);
    const used = [...S.seeds, ...earlier, ...(loadQualification("Q").holdout?.seeds ?? [])];
    expect(w3s.seeds.filter((s) => !used.includes(s))).toEqual([107]);
    expect(w3sh.seeds.filter((s) => !used.includes(s))).toEqual([614]);
});

test("W3P runs the retest's three arms on C8H's held-out seed 605 with prompt caching on", () => {
    const w3p = loadQualification("W3P");
    const pch = loadQualification("PCH");
    const w3s = loadQualification("W3S");
    expect(validateQualification(w3p, loadPrereg("M"))).toEqual([]);
    expect(promptCachingOf(w3p)).toBe("on");
    // The pilot's scenario: PCH's tier, split, seed, and control decide its items.
    expect([w3p.tier, w3p.corpus, w3p.seeds, w3p.controls]).toEqual([
        pch.tier,
        pch.corpus,
        pch.seeds,
        pch.controls,
    ]);
    expect(w3p.arms.run).toEqual(w3s.arms.run);
    expect(w3p.builds).toEqual(w3s.builds);
    expect(w3p.no_source_control).toBe("host");
});
