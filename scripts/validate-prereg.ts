import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    gradingRevisionHash,
    JUDGED_REVISIONS,
    loadGradingRevision,
    loadRuleRevision,
    RULE_REVISIONS,
    ruleRevisionHash,
} from "../src/prereg/grading";
import { QUALIFICATIONS, qualificationHash, referenceErrors } from "../src/prereg/qualification";
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
const revisions: [readonly string[], (id: string) => string][] = [
    [
        JUDGED_REVISIONS,
        (id) => {
            const revision = loadGradingRevision(id, dir);
            return `${gradingRevisionHash(revision)} over ${revision.probe}`;
        },
    ],
    [
        RULE_REVISIONS,
        (id) => {
            const revision = loadRuleRevision(id, dir);
            return `${ruleRevisionHash(revision)} over ${revision.probes.join(", ")}`;
        },
    ],
];
for (const [ids, accept] of revisions) {
    for (const id of ids) {
        try {
            console.log(`${id}: accepted ${accept(id)}`);
        } catch (cause) {
            failed = true;
            console.error(
                `${id}: refused\n  ${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
    }
}
process.exit(failed ? 1 : 0);
