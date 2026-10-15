import { checkCorpus } from "../src/corpus/check";

const { problems, percentiles } = checkCorpus();
console.log("quantity                  q      cited   measured  band            status");
for (const r of percentiles) {
    const status = r.within ? "within" : r.deviation ? "recorded deviation" : "OUT";
    const band = `[${r.low.toFixed(0)}, ${r.high.toFixed(0)}]`;
    console.log(
        `${r.quantity.padEnd(25)} p${String(r.q * 100).padEnd(4)} ${String(r.cited).padStart(7)}` +
            ` ${String(r.measured).padStart(10)}  ${band.padEnd(15)} ${status}`,
    );
}
for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);
console.log("corpus: ok");
