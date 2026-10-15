import type { Preregistration } from "./schema";
import { preregistrationHash } from "./validate";

/** The verdict vocabulary of SIM-P53; a report has no other verdict kind. */
export const VERDICT_KINDS = [
    "better",
    "worse",
    "no-difference-above-x-pp-detectable-at-n",
    "inconclusive",
    "failed-gate",
    "insufficient-runs",
    "descriptive",
] as const;

export interface FamilyVerdict {
    family: string;
    verdict: (typeof VERDICT_KINDS)[number];
    n: number;
    /** The minimum detectable effect at `n` in the family's margin scale. */
    mde: string;
}

export interface TierReport {
    tier: string;
    prereg_hash: string;
    families: FamilyVerdict[];
}

/**
 * Refusals for a tier report checked against the pre-registration it claims: another tier or
 * hash, a pre-registered family the report lacks or a family it adds, a verdict outside the
 * vocabulary, a verdict without `n` and MDE, and the token `parity` anywhere in the report.
 */
export function checkReport(report: TierReport, prereg: Preregistration): string[] {
    const errors: string[] = [];
    if (report.tier !== prereg.tier)
        errors.push(`tier: report ${report.tier}, pre-registration ${prereg.tier}`);
    if (report.prereg_hash !== preregistrationHash(prereg)) {
        errors.push("prereg_hash: does not match the pre-registration");
    }
    const reported = new Map(report.families.map((f) => [f.family, f]));
    for (const family of prereg.families) {
        if (!reported.has(family.id)) errors.push(`families[${family.id}]: missing from report`);
    }
    const registered = new Set(prereg.families.map((f) => f.id));
    for (const f of report.families) {
        if (!registered.has(f.family)) errors.push(`families[${f.family}]: not pre-registered`);
        if (!VERDICT_KINDS.includes(f.verdict))
            errors.push(`families[${f.family}].verdict: ${f.verdict}`);
        if (!Number.isSafeInteger(f.n) || f.n < 0) errors.push(`families[${f.family}].n: missing`);
        if (typeof f.mde !== "string" || f.mde === "")
            errors.push(`families[${f.family}].mde: missing`);
    }
    if (/parity/i.test(JSON.stringify(report))) errors.push("report: contains the token parity");
    return errors;
}
