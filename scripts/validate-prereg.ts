import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TIERS } from "../src/prereg/schema";
import { preregistrationHash, validatePreregistration } from "../src/prereg/validate";

const dir = resolve(import.meta.dir, "../prereg");
let failed = false;
for (const tier of TIERS) {
    const value = JSON.parse(readFileSync(join(dir, `${tier}.json`), "utf8"));
    const errors = validatePreregistration(value);
    if (errors.length > 0) {
        failed = true;
        console.error(`${tier}: refused\n  ${errors.join("\n  ")}`);
    } else console.log(`${tier}: accepted ${preregistrationHash(value)}`);
}
process.exit(failed ? 1 : 0);
