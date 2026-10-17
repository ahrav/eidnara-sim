import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { parseContinuity } from "../src/report/conditions";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
import { loadPrereg } from "../src/scenario/inputs";

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? null : resolve(args[i + 1] ?? ".");
};
const out = flag("out");
const refPath = flag("recall-reference");
const flagged = new Set(
    ["--out", "--recall-reference"].flatMap((f) => {
        const i = args.indexOf(f);
        return i < 0 ? [] : [i, i + 1];
    }),
);
const dirs = args.filter((_, i) => !flagged.has(i)).map((d) => resolve(d));
if (dirs.length === 0 || dirs.some((d) => !existsSync(join(d, "manifest.json")))) {
    console.error(
        "usage: bun scripts/report.ts <run dir>... [--out <dir>] [--recall-reference <continuity json>]",
    );
    process.exit(2);
}
const reference = refPath
    ? { source: refPath, continuity: parseContinuity(JSON.parse(readFileSync(refPath, "utf8"))) }
    : undefined;
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
    const report = tierReport(prereg, runs, boundary, scale, catalog, reference);
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `report-${tier}.md`), text);
        writeFileSync(
            join(out, `report-${tier}.json`),
            `${JSON.stringify(report.verdict, null, 2)}\n`,
        );
        writeFileSync(
            join(out, `continuity-${tier}.json`),
            `${JSON.stringify(report.continuity, null, 2)}\n`,
        );
    } else console.log(text);
}
