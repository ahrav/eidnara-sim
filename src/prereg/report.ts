import { isCanonicalDecimal } from "./canonical";
import { BOUND_DIRECTIONS, type Family, needsPairedRuns, type Preregistration } from "./schema";
import { preregistrationHash } from "./validate";

export const CLAIM_BOUNDARY = "sim-claim-boundary/v1";

/**
 * The verdict vocabulary: SIM-P53's four kinds, `inconclusive` from #1032, SIM-P56's
 * `insufficient-runs`, `passed-gate` for a bound gate every run satisfied, and `descriptive` for
 * a family the pre-registration does not gate.
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

/** `mde` is the minimum detectable effect at `n` in the family's margin scale. */
export interface FamilyVerdict {
    family: string;
    verdict: (typeof VERDICT_KINDS)[number];
    n: number;
    mde: string;
    failed_metric?: string;
    failed_items?: string[];
}

export interface TierReport {
    tier: string;
    claim_boundary: typeof CLAIM_BOUNDARY;
    prereg_hash: string;
    families: FamilyVerdict[];
}

function checkVerdict(f: FamilyVerdict, family: Family, errors: string[]): void {
    const at = `families[${f.family}]`;
    if (!VERDICT_KINDS.includes(f.verdict)) errors.push(`${at}.verdict: ${f.verdict}`);
    if (!Number.isSafeInteger(f.n) || f.n < 0) errors.push(`${at}.n: missing`);
    if (!isCanonicalDecimal(f.mde)) errors.push(`${at}.mde: expected a canonical decimal string`);
    if ((family.claim === "descriptive") !== (f.verdict === "descriptive")) {
        errors.push(`${at}.verdict: a ${family.claim} family cannot report ${f.verdict}`);
    }
    const bound = BOUND_DIRECTIONS.includes(family.direction);
    if (bound && !BOUND_VERDICTS.includes(f.verdict)) {
        errors.push(
            `${at}.verdict: a ${family.direction} gate compares each run to a bound and reports passed-gate or failed-gate`,
        );
    } else if (!bound && f.verdict === "passed-gate") {
        errors.push(
            `${at}.verdict: a ${family.direction} family makes a paired claim, never passed-gate`,
        );
    }
    const belowFloor = needsPairedRuns(family) && f.n < family.min_paired_runs;
    if (belowFloor !== (f.verdict === "insufficient-runs")) {
        errors.push(
            `${at}.verdict: insufficient-runs is the verdict exactly when n is below ${family.min_paired_runs}`,
        );
    }
    const failed = f.verdict === "failed-gate";
    const payload =
        typeof f.failed_metric === "string" &&
        family.metrics.includes(f.failed_metric) &&
        Array.isArray(f.failed_items) &&
        f.failed_items.length > 0 &&
        f.failed_items.every((item) => typeof item === "string" && item !== "");
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
    if (r.tier !== prereg.tier)
        errors.push(`tier: report ${r.tier}, pre-registration ${prereg.tier}`);
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
        else checkVerdict(f, family, errors);
    });
    for (const id of registered.keys())
        if (!seen.has(id)) errors.push(`families[${id}]: missing from report`);
    if (/parity/i.test(JSON.stringify(report))) errors.push("report: contains the token parity");
    return errors;
}
