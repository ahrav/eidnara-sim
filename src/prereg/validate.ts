import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import {
    ARMS,
    CLAIMS,
    CLUSTER_KEYS,
    DIRECTIONS,
    type Family,
    HOSTS,
    INTERVAL_METHODS,
    MARGIN_SCALES,
    MULTIPLICITY,
    OUTCOMES,
    PREREG_SCHEMA,
    type Preregistration,
    REQUIRED_FAMILIES,
    TIERS,
    UNITS,
} from "./schema";

type Check = (value: unknown) => string | null;
type Obj = Record<string, unknown>;

const literal =
    (expected: unknown): Check =>
    (v) =>
        v === expected ? null : `expected ${JSON.stringify(expected)}`;
const oneOf =
    (allowed: readonly string[]): Check =>
    (v) =>
        typeof v === "string" && allowed.includes(v)
            ? null
            : `expected one of ${allowed.join(", ")}`;
const posInt: Check = (v) =>
    Number.isSafeInteger(v) && (v as number) > 0 ? null : "expected a positive integer";
const nonNegInt: Check = (v) =>
    Number.isSafeInteger(v) && (v as number) >= 0 ? null : "expected a non-negative integer";
const decimal: Check = (v) =>
    isCanonicalDecimal(v) ? null : "expected a canonical decimal string";
const unitRate: Check = (v) =>
    isCanonicalDecimal(v) && Number(v) > 0 && Number(v) < 1
        ? null
        : "expected a canonical decimal in (0, 1)";
const text: Check = (v) =>
    typeof v === "string" && v.trim() !== "" ? null : "expected a non-blank string";
const list =
    (item: Check): Check =>
    (v) => {
        if (!Array.isArray(v) || v.length === 0) return "expected a non-empty array";
        const bad = v.map(item).find((e) => e !== null);
        return (
            bad ??
            (new Set(v.map((x) => JSON.stringify(x))).size === v.length
                ? null
                : "duplicate entries")
        );
    };

/** The required fields of one object, each with the check its value must pass. */
interface Shape {
    [field: string]: Check | Shape;
}

const FAMILY_SHAPE: Shape = {
    id: text,
    metrics: list(text),
    outcome: oneOf(OUTCOMES),
    treatment_unit: literal("run"),
    analysis_unit: oneOf(UNITS),
    cluster_key: oneOf(CLUSTER_KEYS),
    direction: oneOf(DIRECTIONS),
    margin: { value: decimal, scale: oneOf(MARGIN_SCALES) },
    alpha: unitRate,
    interval_method: oneOf(INTERVAL_METHODS),
    multiplicity: oneOf(MULTIPLICITY),
    claim: oneOf(CLAIMS),
    min_paired_runs: posInt,
};

const PREREG_SHAPE: Shape = {
    schema: literal(PREREG_SCHEMA),
    tier: oneOf(TIERS),
    revision: posInt,
    frozen: literal(true),
    arms: {
        default: literal("eidnara"),
        run: list(oneOf(ARMS)),
        order: literal("alternate-per-seed"),
    },
    hosts: list(oneOf(HOSTS)),
    seeds: list(nonNegInt),
    scenario: { simulated_days: posInt, sessions_per_project: posInt, forced_p90_sessions: posInt },
    stopping_rule: {
        kind: literal("fixed_n"),
        items_per_probe_type: posInt,
        cusum: (v) => (Array.isArray(v) ? null : "expected an array"),
    },
    missingness_policy: {
        in_flight_at_interrupt: literal("failed(interrupted)"),
        failed_turn_items: literal("exclude-from-recall-and-count"),
        excluded_counts_reported_per_arm: literal(true),
        failed_items_counted_in: literal("dependability"),
    },
    divergence_policy: {
        hash_input: literal("normalised-last-agent-output"),
        normalisation: list(text),
        diagnostic_hash: literal("agent-visible-prefix"),
        on_divergence: literal("record-then-live"),
    },
    liveness_bounds: {
        turn_deadline_ms: posInt,
        job_deadline_ms: posInt,
        tier_wall_budget_ms: posInt,
    },
    bootstrap: { replicates: posInt, seed: nonNegInt },
    leak_bound: { c_bytes_per_session: posInt, r2_threshold: unitRate, sample_interval_ms: posInt },
    families: (v) => (Array.isArray(v) ? null : "expected an array"),
};

const CUSUM_SHAPE: Shape = {
    kind: oneOf(["harm", "futility"]),
    metric: text,
    k: decimal,
    h: decimal,
};
const RESIZING_SHAPE: Shape = {
    planning_items_per_probe_type: posInt,
    source_tier: literal("M"),
    rule: text,
};
const LOAD_STRESS_SHAPE: Shape = {
    arms_concurrent: literal(true),
    record_start_skew: literal(true),
    margins_family: literal("dependability"),
};

/**
 * A run-level gate that makes a paired statistical claim needs six paired runs. `threshold` and
 * `zero-tolerance` gates compare each run's observed value to a fixed bound and claim no effect.
 */
export const MIN_PAIRED_RUNS_FOR_RUN_GATE = 6;
const STATISTICAL_DIRECTIONS: readonly string[] = [
    "superiority-two-sided",
    "noninferiority",
    "at-most",
];
export const HARM_METRIC_COUNT = 5;

function checkShape(value: unknown, shape: Shape, path: string, errors: string[]): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected an object`);
        return;
    }
    const obj = value as Obj;
    for (const [field, check] of Object.entries(shape)) {
        const at = path === "" ? field : `${path}.${field}`;
        if (!(field in obj)) errors.push(`${at}: missing`);
        else if (typeof check === "function") {
            const error = check(obj[field]);
            if (error) errors.push(`${at}: ${error}`);
        } else checkShape(obj[field], check, at, errors);
    }
}

function checkFamilies(families: unknown[], errors: string[]): void {
    const seen = new Set<string>();
    families.forEach((family, index) => {
        const id = (family as Obj | null)?.id;
        const at = `families[${typeof id === "string" && id !== "" ? id : index}]`;
        checkShape(family, FAMILY_SHAPE, at, errors);
        if (typeof id !== "string") return;
        if (seen.has(id)) errors.push(`${at}: duplicate family id`);
        seen.add(id);
        if (!REQUIRED_FAMILIES.includes(id)) errors.push(`${at}: unknown family id`);
        const f = family as Family;
        if (
            f.claim === "gate" &&
            f.analysis_unit === "run" &&
            STATISTICAL_DIRECTIONS.includes(f.direction) &&
            f.min_paired_runs < MIN_PAIRED_RUNS_FOR_RUN_GATE
        ) {
            errors.push(
                `${at}.min_paired_runs: a run-level gate needs at least ${MIN_PAIRED_RUNS_FOR_RUN_GATE}`,
            );
        }
        if (
            id === "harm" &&
            (f.multiplicity !== "holm" || f.metrics?.length !== HARM_METRIC_COUNT)
        ) {
            errors.push(
                `${at}: the harm family is Holm-corrected over exactly ${HARM_METRIC_COUNT} metrics`,
            );
        }
    });
    for (const id of REQUIRED_FAMILIES) if (!seen.has(id)) errors.push(`families[${id}]: missing`);
}

/** Every refusal, each naming the field path it applies to; an empty list means accepted. */
export function validatePreregistration(value: unknown): string[] {
    const errors: string[] = [];
    checkShape(value, PREREG_SHAPE, "", errors);
    if (errors.some((e) => e.startsWith(": "))) return errors;
    const p = value as Obj;
    if (Array.isArray(p.families)) checkFamilies(p.families, errors);
    const stopping = p.stopping_rule as Obj | undefined;
    if (Array.isArray(stopping?.cusum)) {
        stopping.cusum.forEach((c, i) => {
            checkShape(c, CUSUM_SHAPE, `stopping_rule.cusum[${i}]`, errors);
        });
    }
    const runArms = (p.arms as Obj | undefined)?.run;
    if (Array.isArray(runArms) && !(runArms.includes("host") && runArms.includes("eidnara"))) {
        errors.push("arms.run: must include host and eidnara");
    }
    const isL = p.tier === "L";
    for (const [field, shape] of [
        ["resizing", RESIZING_SHAPE],
        ["load_stress", LOAD_STRESS_SHAPE],
    ] as const) {
        if (isL && !(field in p)) errors.push(`${field}: missing`);
        else if (isL) checkShape(p[field], shape, field, errors);
        else if (field in p) errors.push(`${field}: allowed only at tier L`);
    }
    return errors;
}

export class PreregistrationError extends Error {
    constructor(readonly errors: string[]) {
        super(`pre-registration refused:\n${errors.join("\n")}`);
    }
}

export function parsePreregistration(value: unknown): Preregistration {
    const errors = validatePreregistration(value);
    if (errors.length > 0) throw new PreregistrationError(errors);
    return value as Preregistration;
}

/** The digest a run journals at `StartRun` and a gate verdict carries (SIM-P52). */
export function preregistrationHash(prereg: Preregistration): string {
    return sha256Hex(canonicalJson(prereg));
}
