import { checkCorpus } from "../src/corpus/check";
import { waived } from "../src/corpus/distributions";

const { problems, percentiles } = checkCorpus();
console.table(
    percentiles.map((check) => ({
        quantity: check.quantity,
        q: check.q,
        cited: check.cited,
        measured: check.measured,
        band: `[${check.low.toFixed(0)}, ${check.high.toFixed(0)}]`,
        status: check.within ? "within" : waived(check) ? "recorded deviation" : "OUT",
    })),
);
for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);
console.log("corpus: ok");
