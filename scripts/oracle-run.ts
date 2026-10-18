import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRun } from "../src/oracle/logs";
import { ledger, oracleReport, runOracles } from "../src/oracle/oracles";
import { recoveries } from "../src/oracle/recovery";
import { TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { releaseLease, takeLease } from "../src/run/journal";
import { loadPrereg } from "../src/scenario/inputs";

/** A run directory named more than once, by any path, is one run; the tier report counts it once. */
export function runDirs(args: string[]): string[] {
    return [...new Set(args.map((d) => realpathSync(d)))];
}

/**
 * Evaluates each run under its lease and writes its `oracles.json` through a rename, so a
 * symlink at that name is replaced, never followed. Returns the tier report and every run's
 * recoveries.
 */
export function oracleRun(dirs: string[]) {
    const results = dirs.map((dir) => {
        const lease = takeLease(dir);
        try {
            return oracleOne(dir);
        } finally {
            releaseLease(dir, lease);
        }
    });
    return {
        oracles: oracleReport(results),
        recoveries: results.flatMap((r) => r.recoveries.map((x) => ({ run: r.dir, ...x }))),
    };
}

/** Loads and evaluates one run while holding its lease, so a run still finishing is refused rather than read half-written; only the tier, activations, and recoveries outlive the call. */
function oracleOne(dir: string) {
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
    const out = join(dir, "oracles.json");
    writeFileSync(`${out}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(`${out}.tmp`, out);
    return {
        dir: run.dir,
        tier: run.tier,
        activations: result.activations,
        recoveries: result.recoveries,
    };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.some((d) => !existsSync(join(d, "manifest.json")))) {
        console.error("usage: bun scripts/oracle-run.ts <run dir>...");
        process.exit(2);
    }
    console.log(JSON.stringify(oracleRun(runDirs(args)), null, 2));
}
