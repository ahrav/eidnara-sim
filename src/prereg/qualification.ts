/**
 * A qualification registration (`sim-qualification/v1`): the arms and controls one requalification
 * campaign runs over a tier's scenarios. It binds the tier pre-registration by hash and registers
 * descriptive contrasts only.
 */

import { SPLITS, type Split } from "../corpus/repos";
import { armProfile, capabilityGaps, deliveryOf, isArmName } from "../hosts/profiles";
import { canonicalJson, sha256Hex } from "./canonical";
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
export const QUALIFICATIONS = ["Q", "H", "C8", "C8H"] as const;
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
    /** `[treatment, reference]` pairs of run arms whose delivery modes or search routes differ. */
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
     * split at the tier's per-scenario item count, and no earlier campaign ran them.
     */
    fresh_seeds?: true;
    /**
     * Run-level A/A replicates: on each listed seed, each listed arm runs a second time as its own
     * run, launched together with the first.
     */
    replicates?: { seeds: number[]; arms: string[] };
    /** The analysis plan the registration fixes before any measured run. */
    analysis?: Analysis;
    claim: "descriptive";
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
    contrasts: list(list(text)),
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
    for (const arm of q.arms.run) {
        if (!isArmName(arm)) {
            errors.push(`arms.run: ${arm} has no profile`);
            continue;
        }
        for (const gap of capabilityGaps(arm)) errors.push(`arms.run: ${gap}`);
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
    const a = q.analysis;
    if (a) {
        if (a.budget_usd.low > a.budget_usd.high) {
            errors.push("analysis.budget_usd: low exceeds high");
        }
        if (!sameSet(Object.keys(a.cost_per_arm_seed_usd), q.arms.run)) {
            errors.push("analysis.cost_per_arm_seed_usd: expected one cost per run arm");
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
