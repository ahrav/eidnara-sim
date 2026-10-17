import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
import { loadPrereg } from "../src/scenario/inputs";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at < 0 ? null : resolve(args[at + 1] ?? ".");
const dirs = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1)).map((d) => resolve(d));
if (dirs.length === 0 || dirs.some((d) => !existsSync(join(d, "manifest.json")))) {
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
const recorded = (tier: Tier, dirs: string[]): CusumScale | undefined => {
    const beside = dirs.map((d) => join(dirname(d), `${tier}-resizing.json`)).find(existsSync);
    return beside ? (JSON.parse(readFileSync(beside, "utf8")).cusum_sd ?? undefined) : undefined;
};
for (const [tier, { prereg, runs }] of loaded) {
    const scale = cusumScale(prereg, scales, recorded(tier, byTier.get(tier) ?? []));
    const report = tierReport(prereg, runs, boundary, scale, catalog);
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
