import { auditEidnara, renderAudit } from "../src/hosts/audit";

const USAGE = "usage: bun scripts/audit-eidnara.ts <eidnara checkout> [<commit>]";
const [checkout, commit = "HEAD", ...rest] = process.argv.slice(2);
if (!checkout || rest.length > 0 || checkout.startsWith("--")) {
    console.error(USAGE);
    process.exit(64);
}
try {
    const report = auditEidnara(checkout, commit);
    console.log(renderAudit(report));
    process.exit({ unchanged: 0, reread: 1, broken: 2 }[report.verdict]);
} catch (caught) {
    console.error(`${(caught as Error).message}\n${USAGE}`);
    process.exit(64);
}
