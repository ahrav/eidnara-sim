import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { renderTier } from "../src/report/render";
import { aaScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
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
const scales = new Map(
    [...loaded].map(([tier, t]) => {
        const own = tierReport(t.prereg, t.runs, boundary);
        const complete = own.verdict.pass.incomplete.every((x) => x.startsWith("CUSUM "));
        return [tier, { scale: aaScale(t.prereg, t.runs), complete }];
    }),
);
let violated = 0;
for (const [tier, { prereg, runs }] of loaded) {
    const report = tierReport(prereg, runs, boundary, cusumScale(prereg, scales), catalog);
    violated += report.witness.filter((w) => w.status === "violated").length;
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
        const staged = [
            [join(out, `report-${tier}.md`), text],
            [join(out, `report-${tier}.json`), `${JSON.stringify(report.verdict, null, 2)}\n`],
        ] as const;
        const tmp = staged.map(([path]) => `${path}.${randomUUID()}.tmp`);
        for (const [i, [, body]] of staged.entries()) {
            writeFileSync(tmp[i] as string, body, { flag: "wx" });
        }
        for (const [i, [path]] of staged.entries()) renameSync(tmp[i] as string, path);
    } else console.log(text);
}
// A violated property means the runs broke an invariant the verdict rests on; the report stays
// written for reading, and the exit status says the campaign is not sound.
if (violated > 0) {
    console.error(`${violated} property record(s) violated; see the report's property witness`);
    process.exit(1);
}
