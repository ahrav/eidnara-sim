import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import type { Tier } from "../src/prereg/schema";
import { bootstrapMean, disagreementRate, pairedDiffs } from "../src/report/paired";
import { readJsonl } from "../src/run/journal";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import type { PairingRecord } from "../src/usersim/usersim";

const dir = resolve(process.argv[2] ?? "");
if (!existsSync(join(dir, "manifest.json"))) {
    console.error("usage: bun scripts/aa-report.ts <run dir>");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const { bootstrap, aa_controls } = loadPrereg(manifest.tier as Tier);
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
const fact = new Map(scenario.probes.map((p) => [p.id, p.fact ?? p.id]));
const clusterOf = (item: string) => fact.get(item) ?? item;
const graded = join(dir, "grades.jsonl");
const grades = existsSync(graded) ? new GradeLog(graded).latest() : [];
const pairing = readJsonl<PairingRecord>(join(dir, "pairing.jsonl"));
/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;
const controls = (manifest.order as string[]).filter((a) => a.includes("~"));
const report = controls.map((control) => {
    const arm = armBase(control);
    const metrics = [...pairedDiffs(grades, arm, control)].map(([m, d]) =>
        bootstrapMean(m, d, clusterOf, bootstrap.replicates, bootstrap.seed),
    );
    const informative = metrics.filter((m) => m.clusters >= MIN_CLUSTERS);
    const sessions = new Set(
        pairing.filter((r) => r.kind === "turn" && r.arm === control).map((r) => r.session),
    );
    const diverged = pairing.filter((r) => r.kind === "divergedAt" && r.arm === control);
    return {
        arm,
        control,
        metrics,
        method: "ledger-fact cluster percentile bootstrap, 95%",
        every_interval_covers_zero:
            informative.length > 0 ? informative.every((m) => m.covers_zero) : null,
        graded_items: grades.filter((g) => g.arm === arm || g.arm === control).length,
        intervals_missing_zero: informative.filter((m) => !m.covers_zero).map((m) => m.metric),
        expected_by_chance: 0.05 * informative.length,
        uninformative: metrics.filter((m) => m.clusters < MIN_CLUSTERS).map((m) => m.metric),
        descriptive: (aa_controls?.repeats ?? 0) < 5,
        disagreement_rate: disagreementRate(grades, arm, control),
        sessions: sessions.size,
        sessions_diverged: diverged.length,
        divergence_indices: diverged.map((r) => r.index),
    };
});
writeFileSync(join(dir, "aa.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
