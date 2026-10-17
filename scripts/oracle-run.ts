import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../src/oracle/logs";
import { ledger, oracleReport, runOracles } from "../src/oracle/oracles";
import { TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { releaseLease, takeLease } from "../src/run/journal";
import { loadPrereg } from "../src/scenario/inputs";

/** A run directory named more than once, by any path, is one run; the tier report counts it once. */
export function runDirs(args: string[]): string[] {
    return [...new Set(args.map((d) => realpathSync(d)))];
}

/** Writes each run's `oracles.json` through a rename, so a symlink at that name is replaced, never followed. */
export function oracleRun(dirs: string[]) {
    const runs = dirs.map((dir) => {
        takeLease(dir);
        try {
            return oracleOne(dir);
        } finally {
            releaseLease(dir);
        }
    });
    return oracleReport(runs);
}

/** Loads and evaluates one run while holding its lease, so a run still finishing is refused rather than read half-written. */
function oracleOne(dir: string) {
    {
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
        const out = join(dir, "oracles.json");
        writeFileSync(`${out}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
        renameSync(`${out}.tmp`, out);
        return run;
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.some((d) => !existsSync(join(d, "manifest.json")))) {
        console.error("usage: bun scripts/oracle-run.ts <run dir>...");
        process.exit(2);
    }
    console.log(JSON.stringify(oracleRun(runDirs(args)), null, 2));
}
