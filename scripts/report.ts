import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
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
const catalog = readFileSync(join(import.meta.dir, "../docs/properties/sim-v2/catalog.md"), "utf8");
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
const recorded = (tier: Tier, dirs: string[]) => {
    const beside = dirs.map((d) => join(dirname(d), `${tier}-resizing.json`)).find(existsSync);
    return beside
        ? (JSON.parse(readFileSync(beside, "utf8")) as {
              cusum_sd: CusumScale | null;
              paired_items_per_probe_type: number;
          })
        : undefined;
};
for (const [tier, { prereg, runs }] of loaded) {
    const resizing = recorded(tier, byTier.get(tier) ?? []);
    const scale = cusumScale(prereg, scales, resizing?.cusum_sd ?? undefined);
    const effective = resizing
        ? {
              ...prereg,
              stopping_rule: {
                  ...prereg.stopping_rule,
                  paired_items_per_probe_type: resizing.paired_items_per_probe_type,
              },
          }
        : prereg;
    const report = tierReport(effective, runs, boundary, scale, catalog);
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
