import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Preregistration, Tier } from "../src/prereg/schema";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, loadGraded, tierReport } from "../src/report/tier";
import { loadPrereg } from "../src/scenario/inputs";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const dest = at < 0 ? undefined : args[at + 1];
const out = dest === undefined ? null : resolve(dest);
const dirs = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1)).map((d) => resolve(d));
if (
    (at >= 0 && dest === undefined) ||
    dirs.length === 0 ||
    dirs.some((d) => !existsSync(join(d, "manifest.json")))
) {
    console.error("usage: bun scripts/report.ts <run dir>... [--out <dir>]");
    process.exit(2);
}
const boundary = readFileSync(join(import.meta.dir, "../docs/claim-boundary.md"), "utf8");
const byTier = new Map<Tier, string[]>();
for (const dir of dirs) {
    const tier = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).tier as Tier;
    byTier.set(tier, [...(byTier.get(tier) ?? []), dir]);
}
const loaded = new Map(
    [...byTier].map(([tier, list]) => {
        const prereg = loadPrereg(tier);
        return [tier, { prereg, runs: list.map((d) => loadGraded(d, prereg)) }] as const;
    }),
);
const scales = new Map([...loaded].map(([tier, t]) => [tier, aaScale(t.prereg, t.runs)]));
function cusumScale(prereg: Preregistration): CusumScale {
    const scale: CusumScale = {};
    for (const rule of prereg.stopping_rule.cusum) {
        const named = /^the (\w+) tier's/.exec(rule.sd_source)?.[1] as Tier | undefined;
        scale[rule.kind] = scales.get(named ?? prereg.tier)?.[rule.kind];
    }
    return scale;
}
for (const [tier, { prereg, runs }] of loaded) {
    const report = tierReport(prereg, runs, boundary, cusumScale(prereg));
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `report-${tier}.md`), text);
        writeFileSync(
            join(out, `report-${tier}.json`),
            `${JSON.stringify(report.verdict, null, 2)}\n`,
        );
    } else console.log(text);
}
