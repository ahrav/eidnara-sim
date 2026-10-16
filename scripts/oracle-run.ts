import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRun } from "../src/oracle/logs";
import { ledger, oracleReport, runOracles } from "../src/oracle/oracles";
import { recoveries } from "../src/oracle/recovery";
import { TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { loadPrereg } from "../src/scenario/inputs";

const dirs = process.argv.slice(2).map((d) => resolve(d));
if (dirs.length === 0 || dirs.some((d) => !existsSync(join(d, "manifest.json")))) {
    console.error("usage: bun scripts/oracle-run.ts <run dir>...");
    process.exit(2);
}
const results = dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const tier = manifest.tier as Tier;
    if (!TIERS.includes(tier)) throw new Error(`${dir}: unknown tier ${tier}`);
    const prereg = loadPrereg(tier);
    const prereg_sha256 = preregistrationHash(prereg);
    if (prereg_sha256 !== manifest.prereg_sha256) {
        console.error(
            `${dir}: ran under pre-registration ${manifest.prereg_sha256}; oracles use ${prereg_sha256}`,
        );
    }
    const run = loadRun(dir, prereg);
    const ledgers = Object.fromEntries(run.arms.map((a) => [a.arm, ledger(a)]));
    const result = {
        prereg_sha256,
        activations: runOracles(run),
        ledgers,
        recoveries: recoveries(run),
    };
    writeFileSync(join(dir, "oracles.json"), `${JSON.stringify(result, null, 2)}\n`);
    return { run, result };
});
const recovered = results.flatMap(({ run, result }) =>
    result.recoveries.map((r) => ({ run: run.dir, ...r })),
);
console.log(
    JSON.stringify(
        { oracles: oracleReport(results.map((r) => r.run)), recoveries: recovered },
        null,
        2,
    ),
);
