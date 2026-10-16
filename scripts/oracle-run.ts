import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../src/oracle/logs";
import { ledger, oracleReport, runOracles } from "../src/oracle/oracles";
import { TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { loadPrereg } from "../src/scenario/inputs";

/** A run directory named more than once, by any path, is one run; the tier report counts it once. */
export function runDirs(args: string[]): string[] {
    return [...new Set(args.map((d) => realpathSync(d)))];
}

export function oracleRun(dirs: string[]) {
    const runs = dirs.map((dir) => {
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
        const result = { prereg_sha256, activations: runOracles(run), ledgers };
        writeFileSync(join(dir, "oracles.json"), `${JSON.stringify(result, null, 2)}\n`);
        return run;
    });
    return oracleReport(runs);
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.some((d) => !existsSync(join(d, "manifest.json")))) {
        console.error("usage: bun scripts/oracle-run.ts <run dir>...");
        process.exit(2);
    }
    console.log(JSON.stringify(oracleRun(runDirs(args)), null, 2));
}
