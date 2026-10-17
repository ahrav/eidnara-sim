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
for (const [tier, { prereg, runs }] of loaded) {
    const report = tierReport(prereg, runs, boundary, cusumScale(prereg, scales));
    const text = renderTier(report);
    if (out) {
        mkdirSync(out, { recursive: true });
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
    } else console.log(text);
}
