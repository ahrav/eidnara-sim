import { canonicalJson, isCanonicalDecimal, sha256Hex } from "./canonical";
import {
    ARMS,
    BOUND_DIRECTIONS,
    CLAIMS,
    CLUSTER_KEYS,
    DIRECTIONS,
    EMBEDDING_MODELS,
    type Family,
    HOSTS,
    INTERVAL_METHODS,
    MARGIN_SCALES,
    MIN_PAIRED_RUNS_FOR_RUN_GATE,
    MULTIPLICITY,
    needsPairedRuns,
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
const uint32: Check = (v) =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff_ffff
        ? null
        : "expected an integer in [0, 4294967295]";
const decimal: Check = (v) =>
    isCanonicalDecimal(v) ? null : "expected a canonical decimal string";
const unitRate: Check = (v) =>
    isCanonicalDecimal(v) && Number(v) > 0 && Number(v) < 1
        ? null
        : "expected a canonical decimal in (0, 1)";
const unitClosed: Check = (v) =>
    isCanonicalDecimal(v) && (v === "0" || v === "1" || /^0\.\d+$/.test(v))
        ? null
        : "expected a canonical decimal in [0, 1]";
const intAtLeast =
    (min: number): Check =>
    (v) =>
        Number.isSafeInteger(v) && (v as number) >= min
            ? null
            : `expected an integer of at least ${min}`;
const text: Check = (v) =>
    typeof v === "string" && v.trim() !== "" ? null : "expected a non-blank string";
const list =
    (item: Check, distinct = true): Check =>
    (v) => {
        if (!Array.isArray(v) || v.length === 0) return "expected a non-empty array";
        const bad = v.map(item).find((e) => e !== null);
        if (bad) return bad;
        return !distinct || new Set(v.map((x) => JSON.stringify(x))).size === v.length
            ? null
            : "duplicate entries";
    };

/** An array whose every item has `shape`. */
class ArrayOf {
    constructor(readonly shape: Shape) {}
}

/** The fields of one object, each with the check its value must pass or its nested shape. */
interface Shape {
    [field: string]: Check | Shape | ArrayOf;
}

const MARGIN_SHAPE: Shape = { value: decimal, scale: oneOf(MARGIN_SCALES) };

const FAMILY_SHAPE: Shape = {
    id: text,
    metrics: list(text),
    outcome: oneOf(OUTCOMES),
    treatment_unit: literal("run"),
    analysis_unit: oneOf(UNITS),
    cluster_key: oneOf(CLUSTER_KEYS),
    direction: oneOf(DIRECTIONS),
    margin: MARGIN_SHAPE,
    mde: MARGIN_SHAPE,
    power: unitRate,
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
        order_by_seed: list(list(oneOf(ARMS)), false),
    },
    hosts: list(oneOf(HOSTS)),
    seeds: list(uint32),
    scenario: {
        simulated_days: posInt,
        sessions_per_project: posInt,
        forced_p90_sessions: intAtLeast(3),
        cue_probe_similarity: {
            bm25_max: unitClosed,
            cosine_max: unitClosed,
            embedding_model: oneOf(EMBEDDING_MODELS),
        },
    },
    stopping_rule: {
        kind: literal("fixed_n"),
        paired_items_per_probe_type: posInt,
        cusum: new ArrayOf({
            kind: oneOf(["harm", "futility"]),
            metric: text,
            statistic: text,
            sd_source: text,
            k: decimal,
            h: decimal,
        }),
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
    families: new ArrayOf(FAMILY_SHAPE),
};

/** Sections a tier must carry and every other tier must omit. */
const TIER_SECTIONS: Record<string, { tiers: readonly string[]; shape: Shape }> = {
    aa_controls: {
        tiers: ["S", "M"],
        shape: { pairs: list(list(oneOf(ARMS), false)), repeats: posInt },
    },
    resizing: {
        tiers: ["L"],
        shape: {
            planning_paired_items_per_probe_type: posInt,
            source_tier: literal("M"),
            rule: text,
        },
    },
    load_stress: {
        tiers: ["L"],
        shape: {
            arms_concurrent: literal(true),
            record_start_skew: literal(true),
            margins_family: literal("dependability"),
        },
    },
};

export const HARM_METRIC_COUNT = 5;

function isObject(value: unknown): value is Obj {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Array items are named by their `id` when they carry one, otherwise by index. */
function itemPath(path: string, item: unknown, index: number): string {
    const id = isObject(item) ? item.id : undefined;
    return `${path}[${typeof id === "string" && id !== "" ? id : index}]`;
}

function checkShape(
    value: unknown,
    shape: Shape,
    path: string,
    errors: string[],
    extra: string[] = [],
): void {
    if (!isObject(value)) {
        errors.push(`${path || "pre-registration"}: expected an object`);
        return;
    }
    for (const [field, check] of Object.entries(shape)) {
        const at = path === "" ? field : `${path}.${field}`;
        if (!(field in value)) errors.push(`${at}: missing`);
        else if (typeof check === "function") {
            const error = check(value[field]);
            if (error) errors.push(`${at}: ${error}`);
        } else if (check instanceof ArrayOf) {
            const items = value[field];
            if (!Array.isArray(items)) errors.push(`${at}: expected an array`);
            else {
                items.forEach((item, i) => {
                    checkShape(item, check.shape, itemPath(at, item, i), errors);
                });
            }
        } else checkShape(value[field], check, at, errors);
    }
    for (const field of Object.keys(value)) {
        if (!(field in shape) && !extra.includes(field)) {
            errors.push(`${path === "" ? field : `${path}.${field}`}: unknown field`);
        }
    }
}

function checkFamilies(p: Preregistration, errors: string[]): void {
    const runs = p.seeds.length * p.hosts.length;
    const seen = new Set<string>();
    p.families.forEach((f: Family, index) => {
        const at = itemPath("families", f, index);
        if (typeof f.id !== "string") return;
        if (seen.has(f.id)) errors.push(`${at}: duplicate family id`);
        seen.add(f.id);
        if (!REQUIRED_FAMILIES.includes(f.id)) errors.push(`${at}: unknown family id`);
        const bound = BOUND_DIRECTIONS.includes(f.direction);
        if (bound && f.interval_method !== "none") {
            errors.push(
                `${at}.interval_method: a ${f.direction} gate compares each run to a bound and takes none`,
            );
        }
        const paired = !bound && f.direction !== "descriptive";
        if (paired && f.interval_method === "none") {
            errors.push(`${at}.interval_method: a ${f.direction} family needs a paired interval`);
        }
        if ((f.claim === "descriptive") !== (f.direction === "descriptive")) {
            errors.push(`${at}.claim: a descriptive claim and a descriptive direction go together`);
        }
        if (needsPairedRuns(f) && f.min_paired_runs < MIN_PAIRED_RUNS_FOR_RUN_GATE) {
            errors.push(
                `${at}.min_paired_runs: a run-level gate needs at least ${MIN_PAIRED_RUNS_FOR_RUN_GATE}`,
            );
        }
        if (f.min_paired_runs > runs) {
            errors.push(`${at}.min_paired_runs: exceeds the ${runs} paired runs the tier produces`);
        }
        if (
            f.id === "harm" &&
            (f.multiplicity !== "holm" || f.metrics.length !== HARM_METRIC_COUNT)
        ) {
            errors.push(
                `${at}: the harm family is Holm-corrected over exactly ${HARM_METRIC_COUNT} metrics`,
            );
        }
    });
    for (const id of REQUIRED_FAMILIES) if (!seen.has(id)) errors.push(`families[${id}]: missing`);
    p.stopping_rule.cusum.forEach((c, i) => {
        if (!seen.has(c.metric)) errors.push(`stopping_rule.cusum[${i}].metric: names no family`);
    });
}

function checkItemSplit(p: Preregistration, errors: string[]): void {
    const runs = p.seeds.length * p.hosts.length;
    const items = p.stopping_rule.paired_items_per_probe_type;
    if (runs > 0 && items % runs !== 0) {
        errors.push(
            `stopping_rule.paired_items_per_probe_type: ${items} is not a multiple of the ${runs} seed-host runs`,
        );
    }
}

function checkArms(p: Preregistration, errors: string[]): void {
    if (!(p.arms.run.includes("host") && p.arms.run.includes("eidnara"))) {
        errors.push("arms.run: must include host and eidnara");
    }
    if (p.arms.order_by_seed.length !== p.seeds.length) {
        errors.push("arms.order_by_seed: needs one order per seed");
    }
    p.aa_controls?.pairs.forEach((pair, i) => {
        if (pair.length !== 2 || pair[0] !== pair[1] || !p.arms.run.includes(pair[0] as string)) {
            errors.push(`aa_controls.pairs[${i}]: expected one run arm twice`);
        }
    });
    const runSet = [...p.arms.run].sort().join(",");
    p.arms.order_by_seed.forEach((order, i) => {
        if ([...order].sort().join(",") !== runSet) {
            errors.push(`arms.order_by_seed[${i}]: is not a permutation of arms.run`);
        }
    });
}

/** Every refusal, each naming the field path it applies to; an empty list means accepted. */
export function validatePreregistration(value: unknown): string[] {
    const errors: string[] = [];
    if (!isObject(value)) return ["pre-registration: expected an object"];
    checkShape(value, PREREG_SHAPE, "", errors, Object.keys(TIER_SECTIONS));
    for (const [field, { tiers, shape }] of Object.entries(TIER_SECTIONS)) {
        const required = tiers.includes(value.tier as string);
        if (required && !(field in value)) errors.push(`${field}: missing`);
        else if (required) checkShape(value[field], shape, field, errors);
        else if (field in value) errors.push(`${field}: allowed only at tier ${tiers.join(", ")}`);
    }
    if (errors.length > 0) return errors;
    // SAFETY: checkShape found no error, so value has every field PREREG_SHAPE requires with the declared type.
    const p = value as unknown as Preregistration;
    checkFamilies(p, errors);
    checkArms(p, errors);
    checkItemSplit(p, errors);
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
