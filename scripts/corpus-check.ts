import { checkCorpus } from "../src/corpus/check";

const { problems, percentiles } = checkCorpus();
console.table(
    percentiles.map(({ quantity, q, cited, measured, low, high, within, deviation }) => ({
        quantity,
        q,
        cited,
        measured,
        band: `[${low.toFixed(0)}, ${high.toFixed(0)}]`,
        status: within ? "within" : deviation ? "recorded deviation" : "OUT",
    })),
);
for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);
console.log("corpus: ok");
