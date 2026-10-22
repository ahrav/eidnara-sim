/**
 * A qualification registration (`sim-qualification/v1`): the arms and controls one requalification
 * campaign runs over a tier's scenarios. It binds the tier pre-registration by hash and registers
 * descriptive contrasts only.
 */

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
export const QUALIFICATIONS = ["Q"] as const;
/**
 * Control items a qualification adds to its scenarios. `wrong-project-lookup` asks each P8 lookup
 * again in the twin project (`P8-twin`), where the right answer is that the value belongs to the
 * other project.
 */
export const QUALIFICATION_CONTROLS = ["wrong-project-lookup"] as const;
export type QualificationControl = (typeof QUALIFICATION_CONTROLS)[number];

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
    /** `[treatment, reference]` pairs of run arms whose delivery modes differ. */
    contrasts: string[][];
    controls: QualificationControl[];
    claim: "descriptive";
}

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

/**
 * Refusals of `value` as a qualification over `tier`. A shape error is reported alone. Otherwise
 * the refusals name a stale tier digest, a seed or host the tier does not run, an arm without a
 * profile or with a capability gap, and an order that is not a permutation of the run arms; with
 * none of those, a contrast between arms of one delivery mode.
 */
export function validateQualification(value: unknown, tier: Preregistration): string[] {
    const errors: string[] = [];
    checkShape(value, SHAPE, "", errors);
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
    for (const seed of q.seeds.filter((s) => !tier.seeds.includes(s))) {
        errors.push(`seeds: ${seed} is not a ${tier.tier} seed`);
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
    if (errors.length > 0) return errors;
    q.contrasts.forEach((pair, i) => {
        const [a, b] = pair;
        if (pair.length !== 2 || a === undefined || b === undefined) {
            errors.push(`contrasts[${i}]: expected a [treatment, reference] pair`);
        } else if (!q.arms.run.includes(a) || !q.arms.run.includes(b)) {
            errors.push(`contrasts[${i}]: both arms must be run arms`);
        } else if (deliveryOf(armProfile(a)) === deliveryOf(armProfile(b))) {
            errors.push(`contrasts[${i}]: ${a} and ${b} deliver the same way`);
        }
    });
    return errors;
}

export function parseQualification(value: unknown, tier: Preregistration): Qualification {
    const errors = validateQualification(value, tier);
    if (errors.length > 0) throw new Error(`qualification refused:\n${errors.join("\n")}`);
    return value as Qualification;
}

export function qualificationHash(q: Qualification): string {
    return sha256Hex(canonicalJson(q));
}
