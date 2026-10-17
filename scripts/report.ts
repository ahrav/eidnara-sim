import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import type { GradedRun } from "../src/report/observe";
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
const scales = new Map(
    [...loaded].map(([tier, t]) => {
        const own = tierReport(t.prereg, t.runs, boundary);
        const complete = own.verdict.pass.incomplete.every((x) => x.startsWith("CUSUM "));
        return [tier, { scale: aaScale(t.prereg, t.runs), complete }];
    }),
);
const recorded = (tier: Tier, dirs: string[], runs: GradedRun[]) => {
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
    if (text === null) return undefined;
    const record = JSON.parse(text) as {
        cusum_sd: CusumScale | null;
        paired_items_per_probe_type: number;
        target_prereg_sha256: string;
        campaign_dir?: string;
    };
    const outside = dirs.filter(
        (d) => record.campaign_dir === undefined || !d.startsWith(`${record.campaign_dir}/`),
    );
    if (outside.length > 0) {
        console.error(
            `runs outside the resizing record's campaign directory: ${outside.join(", ")}`,
        );
        process.exit(2);
    }
    const prereg = loadPrereg(tier);
    if (record.target_prereg_sha256 !== preregistrationHash(prereg)) {
        console.error(
            `the ${tier}-resizing.json beside the runs was recorded under another ${tier} pre-registration`,
        );
        process.exit(2);
    }
    const want = Math.ceil(
        record.paired_items_per_probe_type / (prereg.seeds.length * prereg.hosts.length),
    );
    const other = runs.filter((g) => g.scenario.manifest.probes_per_type !== want);
    if (other.length > 0) {
        console.error(
            `runs compiled for another count than the resizing record: ${other.map((g) => g.run.dir).join(", ")}`,
        );
        process.exit(2);
    }
    return record;
};
let violated = 0;
for (const [tier, { prereg, runs }] of loaded) {
    const resizing = recorded(tier, byTier.get(tier) ?? [], runs);
    const scale = cusumScale(prereg, scales, resizing?.cusum_sd ?? undefined);
    const report = tierReport(
        prereg,
        runs,
        boundary,
        scale,
        catalog,
        resizing?.paired_items_per_probe_type,
    );
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
