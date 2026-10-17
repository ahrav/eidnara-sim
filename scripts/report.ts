import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { parseContinuity } from "../src/report/conditions";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
import { loadPrereg } from "../src/scenario/inputs";

const args = process.argv.slice(2);
const USAGE =
    "usage: bun scripts/report.ts <run dir>... [--out <dir>] [--recall-reference <continuity json>]";
const flagged = new Set<number>();
const flag = (name: string): string | null => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return null;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
        console.error(USAGE);
        process.exit(2);
    }
    flagged.add(i).add(i + 1);
    return resolve(value);
};
const out = flag("out");
const refPath = flag("recall-reference");
const dirs = args.filter((_, i) => !flagged.has(i)).map((d) => resolve(d));
if (dirs.length === 0 || dirs.some((d) => !existsSync(join(d, "manifest.json")))) {
    console.error(USAGE);
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
const scales = new Map(
    [...loaded].map(([tier, t]) => {
        const own = tierReport(t.prereg, t.runs, boundary);
        const complete = own.verdict.pass.incomplete.every((x) => x.startsWith("CUSUM "));
        return [tier, { scale: aaScale(t.prereg, t.runs), complete }];
    }),
);
const recorded = (tier: Tier, dirs: string[]) => {
    const texts = dirs.map((d) => {
        const parents = [dirname(d), dirname(dirname(d))];
        const beside = parents.map((p) => join(p, `${tier}-resizing.json`)).find(existsSync);
        return beside ? readFileSync(beside, "utf8") : null;
    });
    if (new Set(texts).size > 1) {
        console.error(`the ${tier} runs bind to different resizing records: ${dirs.join(", ")}`);
        process.exit(2);
    }
    const text = texts[0] ?? null;
    if (text === null && loadPrereg(tier).resizing) {
        console.error(
            `the ${tier} runs have no ${tier}-resizing.json beside them: ${dirs.join(", ")}`,
        );
        process.exit(2);
    }
    return text === null
        ? undefined
        : (JSON.parse(text) as {
              cusum_sd: CusumScale | null;
              paired_items_per_probe_type: number;
          });
};
let violated = 0;
for (const [tier, { prereg, runs }] of loaded) {
    const resizing = recorded(tier, byTier.get(tier) ?? []);
    const scale = cusumScale(prereg, scales, resizing?.cusum_sd ?? undefined);
    const report = tierReport(
        prereg,
        runs,
        boundary,
        scale,
        catalog,
        resizing?.paired_items_per_probe_type,
        reference,
    );
    violated += report.witness.filter((w) => w.status === "violated").length;
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
// A violated property means the runs broke an invariant the verdict rests on; the report stays
// written for reading, and the exit status says the campaign is not sound.
if (violated > 0) {
    console.error(`${violated} property record(s) violated; see the report's property witness`);
    process.exit(1);
}
