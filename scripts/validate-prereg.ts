import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    DEFERRAL_REVISIONS,
    deferralRevisionHash,
    gradingRevisionHash,
    JUDGED_REVISIONS,
    loadDeferralRevision,
    loadGradingRevision,
    loadPositiveRevision,
    loadRuleRevision,
    POSITIVE_REVISIONS,
    positiveRevisionHash,
    RULE_REVISIONS,
    ruleRevisionHash,
} from "../src/prereg/grading";
import { QUALIFICATIONS, qualificationHash, referenceErrors } from "../src/prereg/qualification";
import {
    loadReviewerRevision,
    REVIEWER_REVISIONS,
    reviewerRevisionHash,
} from "../src/prereg/reviewer";
import { type Preregistration, TIERS } from "../src/prereg/schema";
import { preregistrationHash, validatePreregistration } from "../src/prereg/validate";
import { loadQualification } from "../src/scenario/inputs";

const dir = resolve(import.meta.dir, "../prereg");
let failed = false;
for (const tier of TIERS) {
    let value: { tier?: string };
    try {
        value = JSON.parse(readFileSync(join(dir, `${tier}.json`), "utf8"));
    } catch (cause) {
        failed = true;
        console.error(
            `${tier}: refused\n  ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        continue;
    }
    const errors = validatePreregistration(value);
    if (errors.length === 0 && value.tier !== tier) {
        errors.push(`tier: ${value.tier} differs from the file name ${tier}.json`);
    }
    if (errors.length > 0) {
        failed = true;
        console.error(`${tier}: refused\n  ${errors.join("\n  ")}`);
    } else {
        // SAFETY: validatePreregistration reported no error, so value has the Preregistration shape.
        console.log(`${tier}: accepted ${preregistrationHash(value as Preregistration)}`);
    }
}
for (const id of QUALIFICATIONS) {
    try {
        const q = loadQualification(id, dir);
        const named = q.reference_runs?.registration;
        const errors = named ? referenceErrors(q, loadQualification(named, dir)) : [];
        if (errors.length > 0) throw new Error(errors.join("\n  "));
        console.log(`${id}: accepted ${qualificationHash(q)} over ${q.tier}`);
    } catch (cause) {
        failed = true;
        console.error(
            `${id}: refused\n  ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
}
/** Prints the digest `accept` returns for a revision, or the reason it is refused. */
const report = (id: string, accept: () => string) => {
    try {
        console.log(`${id}: accepted ${accept()}`);
    } catch (cause) {
        failed = true;
        console.error(
            `${id}: refused\n  ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
};
for (const id of JUDGED_REVISIONS) {
    report(id, () => {
        const revision = loadGradingRevision(id, dir);
        return `${gradingRevisionHash(revision)} over ${revision.probe}`;
    });
}
for (const id of RULE_REVISIONS) {
    report(id, () => {
        const revision = loadRuleRevision(id, dir);
        return `${ruleRevisionHash(revision)} over ${revision.probes.join(", ")}`;
    });
}
for (const id of DEFERRAL_REVISIONS) {
    report(id, () => {
        const revision = loadDeferralRevision(id, dir);
        return `${deferralRevisionHash(revision)} over ${revision.probes.join(", ")}`;
    });
}
for (const id of POSITIVE_REVISIONS) {
    report(id, () => {
        const revision = loadPositiveRevision(id, dir);
        return `${positiveRevisionHash(revision)} over ${revision.probes.join(", ")}`;
    });
}
for (const id of REVIEWER_REVISIONS) {
    report(id, () => {
        const revision = loadReviewerRevision(id, dir);
        return `${reviewerRevisionHash(revision)} over ${revision.subject}`;
    });
}
process.exit(failed ? 1 : 0);
