import { isCanonicalDecimal } from "./canonical";
import { BOUND_DIRECTIONS, type Family, needsPairedRuns, type Preregistration } from "./schema";
import { preregistrationHash } from "./validate";

export const CLAIM_BOUNDARY = "sim-claim-boundary/v1";

/**
 * The verdict vocabulary: SIM-P53's four kinds, `inconclusive` from #1032, SIM-P56's
 * `insufficient-runs`, `passed-gate` for a bound gate every run satisfied or a noninferiority or
 * `at-most` gate whose interval stays inside its margin, and `descriptive` for a family the
 * pre-registration does not gate.
 */
export const VERDICT_KINDS = [
    "better",
    "worse",
    "no-difference-above-x-pp-detectable-at-n",
    "inconclusive",
    "passed-gate",
    "failed-gate",
    "insufficient-runs",
    "descriptive",
] as const;

/** A bound gate compares each run to a fixed value and makes no paired claim. */
const BOUND_VERDICTS: readonly string[] = ["passed-gate", "failed-gate"];
/** A one-sided paired gate: its pass is `passed-gate`, and it registers no superiority claim. */
const MARGIN_DIRECTIONS: readonly string[] = ["noninferiority", "at-most"];
const MARGIN_VERDICTS: readonly string[] = [
    "passed-gate",
    "failed-gate",
    "inconclusive",
    "insufficient-runs",
];
const SUPERIORITY_VERDICTS: readonly string[] = [
    "better",
    "worse",
    "no-difference-above-x-pp-detectable-at-n",
    "inconclusive",
    "insufficient-runs",
];
const REPORT_FIELDS = ["tier", "claim_boundary", "prereg_hash", "families"];
const VERDICT_FIELDS = [
    "family",
    "verdict",
    "n",
    "mde",
    "resolution_ratio",
    "failed_metric",
    "failed_items",
];

const NULL_VERDICT = "no-difference-above-x-pp-detectable-at-n";

/**
 * `mde` is the minimum detectable effect at `n` in the family's margin scale; `resolution_ratio`
 * accompanies the null verdict alone.
 */
export interface FamilyVerdict {
    family: string;
    verdict: (typeof VERDICT_KINDS)[number];
    n: number;
    mde: string;
    resolution_ratio?: string;
    failed_metric?: string;
    failed_items?: string[];
}

export interface TierReport {
    tier: string;
    claim_boundary: typeof CLAIM_BOUNDARY;
    prereg_hash: string;
    families: FamilyVerdict[];
}

function checkVerdict(
    f: FamilyVerdict,
    family: Family,
    prereg: Preregistration,
    errors: string[],
): void {
    const at = `families[${f.family}]`;
    const verdict = typeof f.verdict === "string" ? f.verdict : "";
    if (verdict === "") errors.push(`${at}.verdict: expected a verdict kind`);
    else if (!VERDICT_KINDS.includes(f.verdict)) errors.push(`${at}.verdict: ${verdict}`);
    if (!Number.isSafeInteger(f.n) || f.n < 0) errors.push(`${at}.n: missing`);
    else if (
        family.analysis_unit === "item" &&
        f.n > prereg.stopping_rule.paired_items_per_probe_type
    ) {
        errors.push(
            `${at}.n: exceeds the ${prereg.stopping_rule.paired_items_per_probe_type} paired items the tier issues`,
        );
    } else if (family.analysis_unit === "run" && f.n > prereg.seeds.length * prereg.hosts.length) {
        errors.push(
            `${at}.n: exceeds the ${prereg.seeds.length * prereg.hosts.length} paired runs the tier produces`,
        );
    }
    if (!isCanonicalDecimal(f.mde)) errors.push(`${at}.mde: expected a canonical decimal string`);
    else if (verdict === NULL_VERDICT && Number(f.mde) <= 0) {
        errors.push(`${at}.mde: a null verdict states a positive detectable effect`);
    }
    if ((family.claim === "descriptive") !== (verdict === "descriptive")) {
        errors.push(`${at}.verdict: a ${family.claim} family cannot report ${verdict}`);
    }
    const bound = BOUND_DIRECTIONS.includes(family.direction);
    if (bound && !BOUND_VERDICTS.includes(verdict)) {
        errors.push(
            `${at}.verdict: a ${family.direction} gate compares each run to a bound and reports passed-gate or failed-gate`,
        );
    } else if (MARGIN_DIRECTIONS.includes(family.direction) && !MARGIN_VERDICTS.includes(verdict)) {
        errors.push(
            `${at}.verdict: a ${family.direction} gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs`,
        );
    } else if (
        family.direction === "superiority-two-sided" &&
        verdict !== "" &&
        !SUPERIORITY_VERDICTS.includes(verdict)
    ) {
        errors.push(
            `${at}.verdict: a superiority-two-sided family reports ${SUPERIORITY_VERDICTS.slice(0, -1).join(", ")}, or ${SUPERIORITY_VERDICTS.at(-1)}`,
        );
    }
    for (const key of Object.keys(f)) {
        if (!VERDICT_FIELDS.includes(key)) errors.push(`${at}.${key}: unknown field`);
    }
    const ratio = isCanonicalDecimal(f.resolution_ratio) && Number(f.resolution_ratio) > 0;
    const ratioAllowed = verdict === NULL_VERDICT ? ratio : f.resolution_ratio === undefined;
    if (!ratioAllowed) {
        errors.push(
            `${at}.resolution_ratio: a null verdict carries its resolution ratio as a positive canonical decimal; other verdicts omit it`,
        );
    }
    const belowFloor = needsPairedRuns(family) && f.n < family.min_paired_runs;
    if (belowFloor !== (verdict === "insufficient-runs")) {
        errors.push(
            `${at}.verdict: insufficient-runs is the verdict exactly when n is below ${family.min_paired_runs}`,
        );
    }
    const failed = verdict === "failed-gate";
    const payload =
        typeof f.failed_metric === "string" &&
        family.metrics.includes(f.failed_metric) &&
        Array.isArray(f.failed_items) &&
        f.failed_items.length > 0 &&
        f.failed_items.every((item) => typeof item === "string" && item.trim() !== "");
    const anyPayload = f.failed_metric !== undefined || f.failed_items !== undefined;
    if (failed ? !payload : anyPayload) {
        errors.push(
            `${at}: failed-gate names one of the family's metrics and its failing items; other verdicts neither`,
        );
    }
}

/**
 * Refusals for a tier report checked against the pre-registration it claims: another tier or
 * hash, a claim-boundary version other than `sim-claim-boundary/v1`, a pre-registered family the
 * report lacks, repeats, or adds, a verdict the family's claim does not allow, a verdict without
 * `n` and MDE, and the token `parity` anywhere in the report.
 */
export function checkReport(report: unknown, prereg: Preregistration): string[] {
    const r = report as Partial<TierReport> | null;
    if (!Array.isArray(r?.families)) return ["families: expected an array"];
    const errors: string[] = [];
    if (typeof r.tier !== "string") errors.push("tier: expected a tier name");
    else if (r.tier !== prereg.tier) {
        errors.push(`tier: report ${r.tier}, pre-registration ${prereg.tier}`);
    }
    for (const key of Object.keys(r)) {
        if (!REPORT_FIELDS.includes(key)) errors.push(`${key}: unknown field`);
    }
    if (r.claim_boundary !== CLAIM_BOUNDARY) {
        errors.push(`claim_boundary: expected ${JSON.stringify(CLAIM_BOUNDARY)}`);
    }
    if (r.prereg_hash !== preregistrationHash(prereg)) {
        errors.push("prereg_hash: does not match the pre-registration");
    }
    const registered = new Map(prereg.families.map((f) => [f.id, f]));
    const seen = new Set<string>();
    r.families.forEach((f: FamilyVerdict, i) => {
        if (typeof f?.family !== "string") {
            errors.push(`families[${i}]: expected a verdict object with a family`);
            return;
        }
        const family = registered.get(f.family);
        if (seen.has(f.family)) errors.push(`families[${f.family}]: duplicate`);
        seen.add(f.family);
        if (!family) errors.push(`families[${f.family}]: not pre-registered`);
        else checkVerdict(f, family, prereg, errors);
    });
    for (const id of registered.keys())
        if (!seen.has(id)) errors.push(`families[${id}]: missing from report`);
    if (/parity/i.test(JSON.stringify(report))) errors.push("report: contains the token parity");
    return errors;
}
