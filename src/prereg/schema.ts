/**
 * The per-tier pre-registration (`sim-prereg/v1`). `validatePreregistration` refuses a file
 * that omits a field this module declares without `?` or carries a field it does not declare.
 */

export const PREREG_SCHEMA = "sim-prereg/v1";

export const TIERS = ["S", "M", "L", "XL"] as const;
export type Tier = (typeof TIERS)[number];

export const ARMS = ["host", "eidnara", "eidnara-kl", "eidnara-cf"] as const;
export const HOSTS = ["pi", "opencode"] as const;

/** The families a tier report carries; `checkReport` refuses a report missing one by name. */
export const PROBE_FAMILIES = Array.from({ length: 14 }, (_, i) => `probe-P${i + 1}`);
export const RUN_FAMILIES = [
    "harm",
    "dependability",
    "latency",
    "resources",
    "intrusiveness",
    "cost",
] as const;
export const REQUIRED_FAMILIES: readonly string[] = [...PROBE_FAMILIES, ...RUN_FAMILIES];

export const OUTCOMES = ["binary", "graded", "count", "slope"] as const;
export const UNITS = ["item", "run"] as const;
export const CLUSTER_KEYS = ["ledger_fact_id", "run"] as const;
/**
 * `threshold` and `zero-tolerance` compare each run's observed value to a fixed bound and make
 * no paired claim; the other directions except `descriptive` are paired statistical claims.
 */
export const DIRECTIONS = [
    "superiority-two-sided",
    "noninferiority",
    "at-most",
    "threshold",
    "zero-tolerance",
    "descriptive",
] as const;
export const BOUND_DIRECTIONS: readonly string[] = ["threshold", "zero-tolerance"];
export const MARGIN_SCALES = ["pp", "ratio", "ms", "bytes", "count", "none"] as const;
export const INTERVAL_METHODS = [
    "exact-mcnemar-newcombe-cluster-bootstrap",
    "paired-percentile-bootstrap",
    "paired-bca-bootstrap",
    "negative-binomial-glm",
    "paired-sign-test",
    "slope-paired-bootstrap",
    "none",
] as const;
export const MULTIPLICITY = ["none", "holm"] as const;
export const CLAIMS = ["gate", "descriptive"] as const;

/** `value` is a canonical decimal string, so it hashes identically on every runtime. */
export interface Margin {
    value: string;
    scale: (typeof MARGIN_SCALES)[number];
}

/**
 * `mde` and `power` are design targets fixed before data. For a superiority family `mde` is the
 * smallest effect the pooled n detects at `power`; for a noninferiority or `at-most` family it is
 * the planned true value, and `power` is the power the registered n reaches there. `min_paired_runs` floors run-level
 * families; an item-level family's n is its paired item count.
 */
export interface Family {
    id: string;
    /**
     * A gate family passes when every metric passes at `alpha` under `multiplicity`; one failing
     * metric fails the gate and is named in the verdict.
     */
    metrics: string[];
    outcome: (typeof OUTCOMES)[number];
    treatment_unit: "run";
    analysis_unit: (typeof UNITS)[number];
    cluster_key: (typeof CLUSTER_KEYS)[number];
    direction: (typeof DIRECTIONS)[number];
    margin: Margin;
    mde: Margin;
    power: string;
    alpha: string;
    interval_method: (typeof INTERVAL_METHODS)[number];
    multiplicity: (typeof MULTIPLICITY)[number];
    claim: (typeof CLAIMS)[number];
    min_paired_runs: number;
}

/**
 * `k` and `h` are the reference value and decision threshold in units of the standard deviation
 * that `sd_source` names, applied to the sequence `statistic` names.
 */
export interface Cusum {
    kind: "harm" | "futility";
    metric: string;
    statistic: string;
    sd_source: string;
    k: string;
    h: string;
}

export interface Preregistration {
    schema: typeof PREREG_SCHEMA;
    tier: Tier;
    revision: number;
    frozen: true;
    /**
     * Every gate contrasts `default` against `host` (D1); `eidnara-kl` and `eidnara-cf` are
     * comparison arms with no registered gate. `order_by_seed[i]` is the arm execution order for
     * `seeds[i]`.
     */
    arms: { default: "eidnara"; run: string[]; order_by_seed: string[][] };
    hosts: string[];
    seeds: number[];
    scenario: {
        simulated_days: number;
        sessions_per_project: number;
        forced_p90_sessions: number;
        /** Compile-time SIM-P08 ceilings; decimals in [0, 1]. */
        cue_probe_similarity: { bm25_max: string; cosine_max: string; embedding_model: string };
    };
    /** `paired_items_per_probe_type` is pooled over the tier's paired runs. */
    stopping_rule: { kind: "fixed_n"; paired_items_per_probe_type: number; cusum: Cusum[] };
    missingness_policy: {
        in_flight_at_interrupt: "failed(interrupted)";
        failed_turn_items: "exclude-from-recall-and-count";
        excluded_counts_reported_per_arm: true;
        failed_items_counted_in: "dependability";
    };
    divergence_policy: {
        hash_input: "normalised-last-agent-output";
        normalisation: string[];
        diagnostic_hash: "agent-visible-prefix";
        on_divergence: "record-then-live";
    };
    liveness_bounds: {
        turn_deadline_ms: number;
        job_deadline_ms: number;
        tier_wall_budget_ms: number;
        /** Daemon CPU time per wall second above which the daemon holds the clock (OQ-2). */
        daemon_busy_cpu_fraction: string;
    };
    bootstrap: { replicates: number; seed: number };
    leak_bound: { c_bytes_per_session: number; r2_threshold: string; sample_interval_ms: number };
    /** Probe grading rules (M5), added in revision 4 before any run. */
    grading: {
        first_attempt_only: true;
        lookup_match: "whole-word";
        abstain_rule: "leading-UNKNOWN";
        /** P11 weights a false-positive injection this many times a hit (SIM-P50). */
        p11_false_positive_weight: string;
        /** Bounds on summary tokens per folded input token for a P13 fold. */
        p13_reduction_ratio: { min: string; max: string };
        judge: {
            model: string;
            cross_judge: string;
            calibration_min_pairs: number;
            human_sample_percent: number;
            arm_identification_ceiling_percent: number;
        };
    };
    families: Family[];
    /** S and M only: same-arm pairs under different labels, each run `repeats` times. */
    aa_controls?: { pairs: string[][]; repeats: number };
    /** L only: the planning count and the rule that re-sizes it from the M pilot. */
    resizing?: { planning_paired_items_per_probe_type: number; source_tier: "M"; rule: string };
    /** L only: the concurrent-arms load-stress profile. */
    load_stress?: {
        arms_concurrent: true;
        record_start_skew: true;
        margins_family: "dependability";
    };
}

/** A run-level gate with a paired claim needs six paired runs (SIM-P56); a bound gate needs none. */
export const MIN_PAIRED_RUNS_FOR_RUN_GATE = 6;
/** A compiled scenario holds at least three sessions in the p90 request-count regime (SIM-P09). */
export const MIN_FORCED_P90_SESSIONS = 3;

export function needsPairedRuns(f: Family): boolean {
    return (
        f.claim === "gate" && f.analysis_unit === "run" && !BOUND_DIRECTIONS.includes(f.direction)
    );
}
