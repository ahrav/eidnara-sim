import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultConfigPath } from "../src/config/config";
import { type Preregistration, TIERS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { CONTINUITY_SCHEMA, type ContinuityFile, parseContinuity } from "../src/report/conditions";
import type { GradedRun } from "../src/report/observe";
import { renderTier } from "../src/report/render";
import { aaScale, type CusumScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
import { contains, realExisting } from "../src/run/paths";
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
// The reference is read when the XL report needs it, after any earlier tier in this invocation
// has written or removed its own continuity file; an absent file is no reference.
const reference = (prereg: Preregistration) => {
    if (!refPath) return undefined;
    if (!existsSync(refPath)) {
        console.error(`${refPath}: no such recall reference; the XL report has no drift table`);
        return undefined;
    }
    // The documented reference is the tier XL resizes from, under that tier's registration.
    const source = prereg.resizing?.source_tier ?? "L";
    return {
        source: refPath,
        continuity: parseContinuity(
            JSON.parse(readFileSync(refPath, "utf8")),
            source,
            preregistrationHash(loadPrereg(source)),
        ),
    };
};
/** The path with its nearest existing ancestor resolved through symlinks. */
function canonical(path: string): string {
    let base = path;
    const tail: string[] = [];
    while (!existsSync(base)) {
        tail.unshift(relative(dirname(base), base));
        base = dirname(base);
    }
    return join(realpathSync.native(base), ...tail);
}
if (out) {
    const config = JSON.parse(readFileSync(defaultConfigPath(), "utf8")) as {
        eidnara_checkout?: string;
    };
    const checkout =
        config.eidnara_checkout === undefined ? null : canonical(resolve(config.eidnara_checkout));
    const rel = checkout === null ? null : relative(checkout, canonical(out));
    const inside =
        rel !== null && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/");
    if (inside) {
        console.error(
            `--out ${out} is inside the eidnara checkout ${checkout}; this tree writes nothing there`,
        );
        process.exit(2);
    }
}
const boundary = readFileSync(join(import.meta.dir, "../docs/claim-boundary.md"), "utf8");
const catalog = readFileSync(join(import.meta.dir, "../docs/properties/sim-v2/catalog.md"), "utf8");
const byTier = new Map<Tier, string[]>();
for (const dir of dirs) {
    const tier = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).tier as unknown;
    if (!TIERS.includes(tier as Tier)) {
        console.error(
            `${dir}: manifest tier ${JSON.stringify(tier)} is not one of ${TIERS.join(", ")}`,
        );
        process.exit(2);
    }
    byTier.set(tier as Tier, [...(byTier.get(tier as Tier) ?? []), dir]);
}
// Tiers report in size order, so an L report settles its continuity file before XL reads it.
const loaded = new Map(
    [...byTier]
        .sort(([a], [b]) => TIERS.indexOf(a) - TIERS.indexOf(b))
        .map(([tier, list]) => {
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
    // Containment is judged on resolved paths, so a symlink inside the campaign that leads
    // elsewhere counts as elsewhere.
    const campaign = record.campaign_dir === undefined ? null : realExisting(record.campaign_dir);
    const outside = dirs.filter(
        (d) => campaign === null || !contains(campaign, realExisting(d), true),
    );
    if (outside.length > 0) {
        console.error(
            `runs outside the resizing record's campaign directory: ${outside.join(", ")}`,
        );
        process.exit(2);
    }
    const prereg = loadPrereg(tier);
    const n = record.paired_items_per_probe_type;
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `the ${tier}-resizing.json beside the runs records paired_items_per_probe_type ${n}`,
        );
        process.exit(2);
    }
    const scales = Object.values(record.cusum_sd ?? {});
    if (scales.some((v) => v !== undefined && !(Number.isFinite(v) && v > 0))) {
        console.error(
            `the ${tier}-resizing.json beside the runs records a CUSUM scale that is not a positive number`,
        );
        process.exit(2);
    }
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
    const report = tierReport(prereg, runs, boundary, {
        catalog,
        scale,
        items: resizing?.paired_items_per_probe_type,
        reference: tier === "XL" ? reference(prereg) : undefined,
    });
    violated += report.witness.filter((w) => w.status === "violated").length;
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
        // The previous continuity reference goes first, so a failure while the new report
        // files land leaves no stale reference beside them.
        const continuityPath = join(out, `continuity-${tier}.json`);
        rmSync(continuityPath, { force: true });
        const staged = [
            [join(out, `report-${tier}.md`), text],
            [
                join(out, `report-${tier}.json`),
                `${JSON.stringify(report.verdict, (_, v) => (v === Number.POSITIVE_INFINITY ? "Infinity" : v), 2)}\n`,
            ],
        ] as const;
        const tmp = staged.map(([path]) => `${path}.${randomUUID()}.tmp`);
        for (const [i, [, body]] of staged.entries()) {
            writeFileSync(tmp[i] as string, body, { flag: "wx" });
        }
        for (const [i, [path]] of staged.entries()) renameSync(tmp[i] as string, path);
        // Only a complete, sound campaign's continuity rows serve as another tier's recall
        // reference: no violated property witness and nothing incomplete beyond a CUSUM scale.
        const sound = report.witness.every((w) => w.status !== "violated");
        if (sound && report.verdict.pass.incomplete.every((x) => x.startsWith("CUSUM "))) {
            const tmpPath = `${continuityPath}.${randomUUID()}.tmp`;
            const file: ContinuityFile = {
                schema: CONTINUITY_SCHEMA,
                tier,
                prereg_sha256: preregistrationHash(prereg),
                rows: report.continuity,
            };
            writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
            renameSync(tmpPath, continuityPath);
        } else {
            console.error(
                `${tier}: campaign ${sound ? "incomplete" : "unsound"}; no continuity-${tier}.json written`,
            );
        }
    } else console.log(text);
}
// A violated property means the runs broke an invariant the verdict rests on; the report stays
// written for reading, and the exit status says the campaign is not sound.
if (violated > 0) {
    console.error(`${violated} property record(s) violated; see the report's property witness`);
    process.exit(1);
}
