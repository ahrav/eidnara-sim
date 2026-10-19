import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultConfigPath } from "../src/config/config";
import { TIERS, type Tier } from "../src/prereg/schema";
import { renderTier } from "../src/report/render";
import { aaScale, cusumScale, loadGraded, tierReport } from "../src/report/tier";
import { loadPrereg } from "../src/scenario/inputs";

const args = process.argv.slice(2);
const FLAGS = ["--out", "--recall-reference"];
const at = (name: string) => args.indexOf(name);
const value = (name: string) => (at(name) < 0 ? undefined : args[at(name) + 1]);
const missing = FLAGS.filter((f) => at(f) >= 0 && value(f) === undefined);
const dest = value("--out");
const out = dest === undefined ? null : resolve(dest);
const refArg = value("--recall-reference");
const refPath = refArg === undefined ? null : resolve(refArg);
const flagged = new Set(FLAGS.flatMap((f) => (at(f) < 0 ? [] : [at(f), at(f) + 1])));
const dirs = args.filter((_, i) => !flagged.has(i)).map((d) => resolve(d));
if (
    missing.length > 0 ||
    dirs.length === 0 ||
    dirs.some((d) => !existsSync(join(d, "manifest.json")))
) {
    console.error(
        "usage: bun scripts/report.ts <run dir>... [--out <dir>] [--recall-reference <continuity json>]",
    );
    process.exit(2);
}
const reference = refPath
    ? { source: refPath, continuity: JSON.parse(readFileSync(refPath, "utf8")) }
    : undefined;
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
    const report = tierReport(prereg, runs, boundary, {
        catalog,
        reference,
        scale: cusumScale(prereg, scales),
    });
    violated += report.witness.filter((w) => w.status === "violated").length;
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
        const staged = [
            [join(out, `report-${tier}.md`), text],
            [
                join(out, `report-${tier}.json`),
                `${JSON.stringify(report.verdict, (_, v) => (v === Number.POSITIVE_INFINITY ? "Infinity" : v), 2)}\n`,
            ],
            [
                join(out, `continuity-${tier}.json`),
                `${JSON.stringify(report.continuity, null, 2)}\n`,
            ],
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
