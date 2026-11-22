/**
 * A qualification registration (`sim-qualification/v1`): the arms and controls one requalification
 * campaign runs over a tier's scenarios. It binds the tier pre-registration by hash and registers
 * descriptive contrasts only.
 */

import { SPLITS, type Split } from "../corpus/repos";
import {
    type AuditedBuild,
    armProfile,
    auditedBuild,
    capabilityGaps,
    deliveryOf,
    isArmName,
    PROMPT_CACHING,
    type PromptCaching,
} from "../hosts/profiles";
import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import { HOSTS, type Preregistration, TIERS, type Tier } from "./schema";
import {
    checkShape,
    list,
    literal,
    oneOf,
    posInt,
    preregistrationHash,
    type Shape,
    sameSet,
    text,
    uint32,
} from "./validate";

export const QUALIFICATION_SCHEMA = "sim-qualification/v1";
export const QUALIFICATIONS = [
    "Q",
    "H",
    "C8",
    "C8H",
    "C8X",
    "C8XH",
    "W2S",
    "W2SH",
    "W2S2",
    "W2S2H",
    "PCH",
    "W3S",
    "W3SH",
    "W3P",
    "W4S",
    "W4SH",
    "W4P",
] as const;
/**
 * Control items a qualification adds to its scenarios. `wrong-project-lookup` asks each P8 lookup
 * again in the twin project (`P8-twin`), where the right answer is that the value belongs to the
 * other project.
 */
export const QUALIFICATION_CONTROLS = ["wrong-project-lookup"] as const;
export type QualificationControl = (typeof QUALIFICATION_CONTROLS)[number];

/**
 * The item classes the delivery-mode ranking gate reads: the positive sourced probes, whose right
 * answer applies, answers with, or resumes from a source. A P4 item counts on its `in` side and a
 * P6 item when it expects `resume`. Avoid, abstain, and should-not-apply items (P2, P5, P9, P10,
 * P11, P8-twin, a P4 `out` item, a P6 `clarify` item) stay outside the gate: their
 * right answer withholds or leaves out what a source says, and the oracle note quotes it.
 */
export const RANKING_GATE_ITEMS = ["P1", "P3", "P4:in", "P6:resume", "P8", "P12", "P13"] as const;
/** The delivery modes in the order the ranking gate expects their pass rates to hold. */
const RANKED_DELIVERY = ["oracle-context", "automatic", "none"] as const;

export interface Qualification {
    schema: typeof QUALIFICATION_SCHEMA;
    id: string;
    revision: number;
    frozen: true;
    tier: Tier;
    /** `preregistrationHash` of `prereg/<tier>.json`. */
    tier_preregistration_sha256: string;
    seeds: number[];
    hosts: string[];
    /** `order_by_seed[i]` is the arm execution order for `seeds[i]`. */
    arms: { run: string[]; order_by_seed: string[][] };
    /**
     * `[treatment, reference]` pairs of run arms whose delivery modes or search routes differ; empty
     * only when the registration runs one arm and `reference_runs` names its contrasts.
     */
    contrasts: string[][];
    controls: QualificationControl[];
    /**
     * Whole-scenario A/A controls: on each listed seed, each `[arm, arm]` pair runs a second copy
     * of the arm, labelled `<arm>~aa`, right after it.
     */
    aa_controls?: { seeds: number[]; pairs: string[][] };
    /**
     * Exploratory hold-out seeds, run over `arms` in `order_by_seed[i]` and reported apart; they
     * never enter the registered contrasts. Their seeds lie outside `seeds`, and need not be tier
     * seeds.
     */
    holdout?: { seeds: number[]; arms: string[]; order_by_seed: string[][]; pooled: false };
    /**
     * The qualification gate: on the items of `RANKING_GATE_ITEMS`, the pooled pass rates of
     * `order` hold from first to last (oracle context, then automatic delivery, then none).
     */
    ranking_gate?: { order: string[]; items: string[] };
    /**
     * The run arm that serves as the memory-free control: it meets every scripted conveyance and
     * receives no memory between sessions, so its pass rate on an item is the item's base rate.
     */
    no_source_control?: string;
    /**
     * `corpus` selects the registration's corpus split and defaults to `diagnosed`. A `held-out`
     * registration's seeds lie outside the tier's seeds; a `diagnosed` one's lie inside them unless
     * it sets `fresh_seeds`.
     */
    corpus?: Split;
    /**
     * A diagnosed registration over seeds outside the tier's: they compile from the diagnosed
     * split at the tier's per-scenario item count. No earlier campaign ran them, or they are
     * seeds of the registration it reruns: exactly those with `reference_runs`, and those plus
     * added seeds for a rerun of every arm, which `docs/scenario.md` lists seed by seed.
     */
    fresh_seeds?: true;
    /**
     * A rerun of some arms of an earlier registration over its seeds, split, and controls, so each
     * scenario holds the same items: `contrasts` pairs each of this registration's run arms with
     * a run arm of `registration`, whose runs on the same seeds are the reference.
     */
    reference_runs?: { registration: string; contrasts: string[][] };
    /**
     * The two audited Eidnara builds the registration compares, each named by its label and commit
     * in `AUDITED_BUILDS`. Every run arm with a daemon runs on `current`. Each `contrasts` pair is
     * `[treatment, reference]`: a run arm on `current` against a run arm on `reference`, which
     * runs as its own run over the same seed and scenario. The two builds differ, so a pair may
     * name one arm twice.
     */
    builds?: { current: BuildRef; reference: BuildRef; contrasts: string[][] };
    /**
     * Run-level A/A replicates: on each listed seed, each listed arm runs a second time as its own
     * run, launched together with the first.
     */
    replicates?: { seeds: number[]; arms: string[] };
    /** The analysis plan the registration fixes before any measured run. */
    analysis?: Analysis;
    /**
     * The prompt-caching condition every arm of the registration runs under; `off` when absent.
     * Under `on` the run makes Pi place its Bedrock cache points for the measured model
     * (`piModelName`), refuses an arm with a host caller's request that carries none, records the
     * cache gap of each call a host under test makes, and prices its calls at `CACHED_PRICE_TABLE`. OpenCode places its own
     * cache points for a Claude model under either value.
     */
    prompt_caching?: PromptCaching;
    /**
     * The bound on a fused-route arm's degraded search answers. The product answers one
     * `eidnara_search` call from the legacy snapshot scan when the route ends that call on a
     * transient reason (`TRANSIENT_FALLBACK_REASONS`, `src/run/capabilities.ts`); the arm's
     * capability record counts each such result as a degraded answer, and the arm is refused when
     * their share of its answered searches exceeds `max_degraded_share` (a canonical decimal in
     * (0, 1)) or when a fallback names any other reason. The check counts the results in Pi's
     * transcripts, so a registration with the section runs on Pi. A registration without the
     * section refuses every fallback answer on a fused arm.
     */
    search_fallback?: { max_degraded_share: string };
    claim: "descriptive";
}

/** The prompt-caching condition a registration's runs take; a tier run and an unnamed one run `off`. */
export const promptCachingOf = (q: Pick<Qualification, "prompt_caching"> | null): PromptCaching =>
    q?.prompt_caching ?? "off";

/** One audited Eidnara build as a registration names it: the integration branch and its commit. */
export interface BuildRef {
    label: string;
    commit: string;
}

/**
 * The run (one arm on one seed) is the analysis unit; contrasts are also read against an earlier
 * campaign at the seed level. `harm_probes` must not regress, and the budget states the expected
 * spend range and the cost per arm-seed it rests on.
 */
export interface Analysis {
    unit: "run";
    reference: { campaign: string; level: "seed" };
    harm_probes: string[];
    budget_usd: { low: number; high: number };
    cost_per_arm_seed_usd: Record<string, number>;
}

const SHARE_BOUND = "expected a canonical decimal in (0, 1)";
/**
 * Whether `v` is a share bound as a registration holds it: a canonical decimal above 0 and below
 * 1, read from its digits, so a bound of any length is told from its endpoints.
 */
export const isShareBound = (v: unknown): v is string =>
    isCanonicalDecimal(v) && v.startsWith("0.");

const commitHash = (v: unknown) =>
    typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? null : "expected a full commit hash";

/** The probe types a registration may name: P1 to P14 and the wrong-project control P8-twin. */
const PROBE_TYPES = [...Array.from({ length: 14 }, (_, i) => `P${i + 1}`), "P8-twin"];

const SHAPE: Shape = {
    schema: literal(QUALIFICATION_SCHEMA),
    id: oneOf(QUALIFICATIONS),
    revision: posInt,
    frozen: literal(true),
    tier: oneOf(TIERS),
    tier_preregistration_sha256: (v) =>
        typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? null : "expected a sha256 hex digest",
    seeds: list(uint32),
    hosts: list(oneOf(HOSTS)),
    arms: { run: list(text), order_by_seed: list(list(text), false) },
    contrasts: (v) => (Array.isArray(v) && v.length === 0 ? null : list(list(text))(v)),
    controls: list(oneOf(QUALIFICATION_CONTROLS)),
    claim: literal("descriptive"),
};
/** Sections a registration may carry; each is checked against its shape when present. */
const SECTIONS: Record<string, Shape> = {
    aa_controls: { seeds: list(uint32), pairs: list(list(text, false)) },
    holdout: {
        seeds: list(uint32),
        arms: list(text),
        order_by_seed: list(list(text), false),
        pooled: literal(false),
    },
    ranking_gate: { order: list(text), items: list(oneOf(RANKING_GATE_ITEMS)) },
    replicates: { seeds: list(uint32), arms: list(text) },
    reference_runs: { registration: oneOf(QUALIFICATIONS), contrasts: list(list(text)) },
    builds: {
        current: { label: text, commit: commitHash },
        reference: { label: text, commit: commitHash },
        // A pair may name one arm twice, since its two sides run on different builds.
        contrasts: list(list(text, false)),
    },
    analysis: {
        unit: literal("run"),
        reference: { campaign: text, level: literal("seed") },
        harm_probes: list(oneOf(PROBE_TYPES)),
        budget_usd: { low: posInt, high: posInt },
        cost_per_arm_seed_usd: (v) =>
            v !== null &&
            typeof v === "object" &&
            !Array.isArray(v) &&
            Object.values(v).every((x) => posInt(x) === null)
                ? null
                : "expected an object of positive integer costs by arm",
    },
    search_fallback: { max_degraded_share: (v) => (isShareBound(v) ? null : SHARE_BOUND) },
};

/**
 * Refusals of `value` as a qualification over `tier`. A shape error is reported alone. Otherwise
 * the refusals name a stale tier digest, a seed or host the tier does not run, an arm without a
 * profile or with a capability gap, and an order that is not a permutation of the run arms; with
 * none of those, a contrast between arms of one delivery mode and one search route.
 */
export function validateQualification(value: unknown, tier: Preregistration): string[] {
    const errors: string[] = [];
    checkShape(value, SHAPE, "", errors, [
        ...Object.keys(SECTIONS),
        "no_source_control",
        "corpus",
        "fresh_seeds",
        "prompt_caching",
    ]);
    for (const [field, shape] of Object.entries(SECTIONS)) {
        const v = (value as Record<string, unknown> | null)?.[field];
        if (v !== undefined) checkShape(v, shape, field, errors);
    }
    const split = (value as Record<string, unknown> | null)?.corpus;
    if (split !== undefined) checkShape({ corpus: split }, { corpus: oneOf(SPLITS) }, "", errors);
    const fresh = (value as Record<string, unknown> | null)?.fresh_seeds;
    if (fresh !== undefined)
        checkShape({ fresh_seeds: fresh }, { fresh_seeds: literal(true) }, "", errors);
    const caching = (value as Record<string, unknown> | null)?.prompt_caching;
    if (caching !== undefined)
        checkShape(
            { prompt_caching: caching },
            { prompt_caching: oneOf(PROMPT_CACHING) },
            "",
            errors,
        );
    if (errors.length > 0) return errors;
    // SAFETY: checkShape found no error, so value has every field SHAPE declares.
    const q = value as Qualification;
    if (q.tier !== tier.tier) errors.push(`tier: ${q.tier} is not the bound ${tier.tier}`);
    const digest = preregistrationHash(tier);
    if (q.tier_preregistration_sha256 !== digest) {
        errors.push(
            `tier_preregistration_sha256: prereg/${tier.tier}.json hashes to ${digest}; revise the qualification`,
        );
    }
    const heldOut = q.corpus === "held-out";
    if (heldOut && q.fresh_seeds) {
        errors.push("fresh_seeds: a held-out registration's seeds lie outside the tier's already");
    }
    const outside = heldOut || q.fresh_seeds === true;
    for (const seed of q.seeds.filter((s) => tier.seeds.includes(s) === outside)) {
        errors.push(
            heldOut
                ? `seeds: ${seed} is a ${tier.tier} seed, which compiles from the diagnosed corpus`
                : outside
                  ? `seeds: ${seed} is a ${tier.tier} seed, and a fresh-seed registration runs none`
                  : `seeds: ${seed} is not a ${tier.tier} seed`,
        );
    }
    for (const seed of q.holdout?.seeds.filter((s) => heldOut && tier.seeds.includes(s)) ?? []) {
        errors.push(
            `holdout.seeds: ${seed} is a ${tier.tier} seed, which compiles from the diagnosed corpus`,
        );
    }
    for (const host of q.hosts.filter((h) => !tier.hosts.includes(h))) {
        errors.push(`hosts: ${tier.tier} runs no ${host} host`);
    }
    const builds = registeredBuilds(q, errors);
    for (const arm of q.arms.run) {
        if (!isArmName(arm)) {
            errors.push(`arms.run: ${arm} has no profile`);
            continue;
        }
        for (const gap of capabilityGaps(arm, builds?.current)) errors.push(`arms.run: ${gap}`);
    }
    if (q.arms.order_by_seed.length !== q.seeds.length) {
        errors.push("arms.order_by_seed: needs one order per seed");
    }
    q.arms.order_by_seed.forEach((order, i) => {
        if (!sameSet(order, q.arms.run)) {
            errors.push(`arms.order_by_seed[${i}]: is not a permutation of arms.run`);
        }
    });
    checkSections(q, errors);
    if (builds) checkBuildContrasts(q, builds.reference, errors);
    if (q.contrasts.length === 0 && q.arms.run.length > 1) {
        errors.push("contrasts: a registration that runs two or more arms names a contrast");
    }
    if (q.contrasts.length === 0 && q.arms.run.length === 1 && !q.reference_runs) {
        errors.push("contrasts: a one-arm registration names its contrasts in reference_runs");
    }
    if (errors.length > 0) return errors;
    q.contrasts.forEach((pair, i) => {
        const [a, b] = pair;
        if (pair.length !== 2 || a === undefined || b === undefined) {
            errors.push(`contrasts[${i}]: expected a [treatment, reference] pair`);
        } else if (!q.arms.run.includes(a) || !q.arms.run.includes(b)) {
            errors.push(`contrasts[${i}]: both arms must be run arms`);
        } else if (
            deliveryOf(armProfile(a)) === deliveryOf(armProfile(b)) &&
            armProfile(a).search === armProfile(b).search
        ) {
            errors.push(`contrasts[${i}]: ${a} and ${b} deliver and search the same way`);
        }
    });
    return errors;
}

/**
 * The audited builds `q.builds` names, or undefined without the section or when a name is refused:
 * each of `current` and `reference` is an `AUDITED_BUILDS` entry under its own label, and the two
 * are different commits.
 */
function registeredBuilds(
    q: Qualification,
    errors: string[],
): { current: AuditedBuild; reference: AuditedBuild } | undefined {
    if (!q.builds) return undefined;
    const resolve = (role: "current" | "reference"): AuditedBuild | undefined => {
        const named = q.builds?.[role] as BuildRef;
        const build = auditedBuild(named.commit);
        if (!build) {
            errors.push(`builds.${role}: ${named.commit} is not an audited build`);
        } else if (build.label !== named.label) {
            errors.push(
                `builds.${role}: ${named.commit} is the audited build ${build.label}, not ${named.label}`,
            );
        } else {
            return build;
        }
        return undefined;
    };
    const current = resolve("current");
    const reference = resolve("reference");
    if (!current || !reference) return undefined;
    if (current.commit === reference.commit) {
        errors.push("builds.reference: names the current build");
        return undefined;
    }
    return { current, reference };
}

/**
 * `builds.contrasts` against the run arms and the reference build's table: both sides are run
 * arms with a daemon, so the seed's registered order launches each, and the reference arm's
 * daemon variant is registered on the reference build with every capability the arm declares.
 */
function checkBuildContrasts(q: Qualification, reference: AuditedBuild, errors: string[]): void {
    q.builds?.contrasts.forEach((pair, i) => {
        const at = `builds.contrasts[${i}]`;
        const [a, b] = pair;
        if (pair.length !== 2 || a === undefined || b === undefined) {
            errors.push(`${at}: expected a [treatment, reference] pair`);
        } else if (!q.arms.run.includes(a) || !q.arms.run.includes(b)) {
            errors.push(`${at}: ${q.arms.run.includes(a) ? b : a} is not a run arm`);
        } else if (!isArmName(a) || !isArmName(b)) {
            errors.push(`${at}: ${isArmName(a) ? b : a} has no profile`);
        } else if (armProfile(a).daemon === null || armProfile(b).daemon === null) {
            errors.push(`${at}: ${armProfile(a).daemon === null ? a : b} runs no Eidnara build`);
        } else {
            for (const gap of capabilityGaps(b, reference)) errors.push(`${at}: ${gap}`);
        }
    });
}

/** The arms `q` runs on its reference build: the reference side of each build contrast. */
export const referenceBuildArms = (q: Qualification): string[] => [
    ...new Set((q.builds?.contrasts ?? []).map(([, arm]) => arm as string)),
];

/**
 * Why a run of `order` whose build clone bound `bound` is outside `q.builds`, or null: the run
 * binds the current build, or it binds the reference build and runs reference arms alone. A
 * registration without the section accepts any audited build, and a run without a daemon binds
 * none.
 */
export function buildRefusal(
    q: Qualification,
    bound: BuildRef | null,
    order: readonly string[],
): string | null {
    if (!q.builds || bound === null) return null;
    const { current, reference } = q.builds;
    if (bound.commit === current.commit) return null;
    const name = (b: BuildRef) => `${b.label} (${b.commit})`;
    if (bound.commit !== reference.commit) {
        return `qualification ${q.id} runs on ${name(current)} and its reference arms on ${name(reference)}; the build clone holds ${name(bound)}`;
    }
    const allowed = referenceBuildArms(q);
    const extra = order.filter((arm) => !allowed.includes(arm.split("~")[0] as string));
    if (extra.length === 0) return null;
    return `qualification ${q.id} runs ${allowed.join(", ")} on its reference build ${name(reference)}; ${extra.join(", ")} runs on ${name(current)}`;
}

/**
 * The A/A, hold-out, no-source control, and ranking gate sections against the registration's
 * seeds and arms.
 */
function checkSections(q: Qualification, errors: string[]): void {
    const aa = q.aa_controls;
    for (const seed of aa?.seeds.filter((s) => !q.seeds.includes(s)) ?? []) {
        errors.push(`aa_controls.seeds: ${seed} is not a registered seed`);
    }
    aa?.pairs.forEach((pair, i) => {
        if (pair.length !== 2 || pair[0] !== pair[1] || !q.arms.run.includes(pair[0] as string)) {
            errors.push(`aa_controls.pairs[${i}]: expected one run arm twice`);
        }
    });
    const h = q.holdout;
    if (h) {
        for (const seed of h.seeds.filter((s) => q.seeds.includes(s))) {
            errors.push(`holdout.seeds: ${seed} is a registered seed`);
        }
        for (const arm of h.arms.filter((a) => !q.arms.run.includes(a))) {
            errors.push(`holdout.arms: ${arm} is not a run arm`);
        }
        if (h.order_by_seed.length !== h.seeds.length) {
            errors.push("holdout.order_by_seed: needs one order per hold-out seed");
        }
        h.order_by_seed.forEach((order, i) => {
            if (!sameSet(order, h.arms)) {
                errors.push(`holdout.order_by_seed[${i}]: is not a permutation of holdout.arms`);
            }
        });
    }
    const r = q.replicates;
    for (const seed of r?.seeds.filter((s) => !q.seeds.includes(s)) ?? []) {
        errors.push(`replicates.seeds: ${seed} is not a registered seed`);
    }
    for (const arm of r?.arms.filter((a) => !q.arms.run.includes(a)) ?? []) {
        errors.push(`replicates.arms: ${arm} is not a run arm`);
    }
    const ref = q.reference_runs;
    if (ref?.registration === q.id) {
        errors.push("reference_runs.registration: names this registration");
    }
    ref?.contrasts.forEach((pair, i) => {
        const [a, b] = pair;
        if (pair.length !== 2 || a === undefined || b === undefined) {
            errors.push(`reference_runs.contrasts[${i}]: expected a [treatment, reference] pair`);
        } else if (!q.arms.run.includes(a)) {
            errors.push(`reference_runs.contrasts[${i}]: ${a} is not a run arm`);
        } else if (!isArmName(b)) {
            errors.push(`reference_runs.contrasts[${i}]: ${b} has no profile`);
        } else if (
            deliveryOf(armProfile(a)) === deliveryOf(armProfile(b)) &&
            armProfile(a).search === armProfile(b).search
        ) {
            errors.push(
                `reference_runs.contrasts[${i}]: ${a} and ${b} deliver and search the same way`,
            );
        }
    });
    const a = q.analysis;
    if (a) {
        if (a.budget_usd.low > a.budget_usd.high) {
            errors.push("analysis.budget_usd: low exceeds high");
        }
        if (!sameSet(Object.keys(a.cost_per_arm_seed_usd), q.arms.run)) {
            errors.push("analysis.cost_per_arm_seed_usd: expected one cost per run arm");
        }
    }
    if (q.search_fallback) {
        if (!q.arms.run.some((a) => isArmName(a) && armProfile(a).search === "fused")) {
            errors.push("search_fallback: expected a run arm that declares the fused route");
        }
        // The arm check counts search results from Pi's transcripts (`observeArm`), so the
        // bound is enforced on that host.
        for (const host of q.hosts.filter((h) => h !== "pi")) {
            errors.push(
                `search_fallback: the bound is read from Pi transcripts; hosts lists ${host}`,
            );
        }
    }
    const control = q.no_source_control;
    if (control !== undefined) {
        if (typeof control !== "string" || !q.arms.run.includes(control)) {
            errors.push("no_source_control: expected a run arm");
        } else {
            const mode = isArmName(control) ? deliveryOf(armProfile(control)) : "no profile";
            if (mode !== "none") {
                errors.push(`no_source_control: ${control} delivers ${mode}; expected none`);
            }
        }
    }
    const gate = q.ranking_gate;
    if (gate) {
        const modes = gate.order.map((a) =>
            q.arms.run.includes(a) && isArmName(a) ? deliveryOf(armProfile(a)) : null,
        );
        if (
            !sameSet(modes.map(String), [...RANKED_DELIVERY]) ||
            modes.some((m, i) => m !== RANKED_DELIVERY[i])
        ) {
            errors.push(
                `ranking_gate.order: expected run arms delivering ${RANKED_DELIVERY.join(", ")}, in that order`,
            );
        }
        if (!sameSet(gate.items, [...RANKING_GATE_ITEMS])) {
            errors.push(`ranking_gate.items: expected ${RANKING_GATE_ITEMS.join(", ")}`);
        }
    }
}

/**
 * Refusals of `q`'s `reference_runs` against `reference`, the registration it names: the rerun
 * keeps its tier, split, fresh-seed flag, seeds, and controls, so each scenario compiles to the
 * same items, and each reference arm is one of its run arms.
 */
export function referenceErrors(q: Qualification, reference: Qualification): string[] {
    const r = q.reference_runs;
    if (!r) return [];
    const errors: string[] = [];
    const same = (field: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            errors.push(`reference_runs: ${field} differs from ${reference.id}'s`);
        }
    };
    same("tier", q.tier, reference.tier);
    same("corpus", q.corpus ?? "diagnosed", reference.corpus ?? "diagnosed");
    same("fresh_seeds", q.fresh_seeds ?? false, reference.fresh_seeds ?? false);
    same("seeds", q.seeds, reference.seeds);
    same("controls", q.controls, reference.controls);
    r.contrasts.forEach(([, arm], i) => {
        if (arm !== undefined && !reference.arms.run.includes(arm)) {
            errors.push(`reference_runs.contrasts[${i}]: ${arm} is not a ${reference.id} run arm`);
        }
    });
    return errors;
}

/** The arms a qualification runs on `seed`: its order, its A/A pairs, and whether it is a hold-out. */
export function qualificationSeed(
    q: Qualification,
    seed: number,
): { order: string[]; run: string[]; pairs: string[][]; holdout: boolean } | null {
    const at = q.seeds.indexOf(seed);
    if (at >= 0) {
        const pairs = q.aa_controls?.seeds.includes(seed) ? q.aa_controls.pairs : [];
        return {
            order: q.arms.order_by_seed[at] ?? q.arms.run,
            run: q.arms.run,
            pairs,
            holdout: false,
        };
    }
    const h = q.holdout;
    const held = h?.seeds.indexOf(seed) ?? -1;
    if (!h || held < 0) return null;
    return { order: h.order_by_seed[held] ?? h.arms, run: h.arms, pairs: [], holdout: true };
}

export function parseQualification(value: unknown, tier: Preregistration): Qualification {
    const errors = validateQualification(value, tier);
    if (errors.length > 0) throw new Error(`qualification refused:\n${errors.join("\n")}`);
    return value as Qualification;
}

export function qualificationHash(q: Qualification): string {
    return sha256Hex(canonicalJson(q));
}
