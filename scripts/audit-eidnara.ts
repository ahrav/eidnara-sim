import { auditEidnara, renderAudit } from "../src/hosts/audit";
import { AUDITED_BUILDS, auditedBuild, type VariantRecord } from "../src/hosts/profiles";

const BUILDS = AUDITED_BUILDS.map((b) => `${b.label} (${b.commit})`).join(", ");
const USAGE = `usage: bun scripts/audit-eidnara.ts <eidnara checkout> [<commit> [<audited build>]]\naudited builds, the first by default: ${BUILDS}`;
const [checkout, commit = "HEAD", from, ...rest] = process.argv.slice(2);
if (!checkout || rest.length > 0 || checkout.startsWith("--")) {
    console.error(USAGE);
    process.exit(64);
}
try {
    const build = from === undefined ? AUDITED_BUILDS[0] : auditedBuild(from);
    if (!build) throw new Error(`${from} names no audited build`);
    const report = auditEidnara(
        checkout,
        commit,
        build.commit,
        build.variants as Record<string, VariantRecord>,
    );
    console.log(`build:     ${build.label}\n${renderAudit(report)}`);
    process.exit({ unchanged: 0, reread: 1, broken: 2 }[report.verdict]);
} catch (caught) {
    console.error(`${(caught as Error).message}\n${USAGE}`);
    process.exit(64);
}
