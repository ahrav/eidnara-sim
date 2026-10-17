import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import type { Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { bootstrapMean, disagreementRate, pairedDiffs } from "../src/report/paired";
import { releaseLease, takeLease } from "../src/run/journal";
import { type Scenario, scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { readPairing } from "../src/usersim/usersim";

/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;

export function aaReport(dir: string) {
    takeLease(dir);
    try {
        return report(dir);
    } finally {
        releaseLease(dir);
    }
}

function report(dir: string) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const prereg = loadPrereg(manifest.tier as Tier);
    const prereg_sha256 = preregistrationHash(prereg);
    if (prereg_sha256 !== manifest.prereg_sha256) {
        throw new Error(
            `${dir}: ran under pre-registration ${manifest.prereg_sha256}; this report uses ${prereg_sha256}`,
        );
    }
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const scenario_hash = scenarioHash(scenario);
    if (scenario_hash !== manifest.scenario_hash) {
        throw new Error(
            `${dir}: scenario_hash ${scenario_hash} differs from the manifest's ${manifest.scenario_hash}`,
        );
    }
    const fact = new Map(scenario.probes.map((p) => [p.id, p.fact ?? p.id]));
    // A family keyed by run has one cluster in a one-run report, so it stays uninformative.
    const probeType = (metric: string) => metric.split(".")[0] as string;
    const runLevel = new Set(
        prereg.families
            .filter((f) => f.cluster_key === "run")
            .flatMap((f) => f.metrics.map(probeType)),
    );
    const clusterOf = (metric: string) => (item: string) =>
        runLevel.has(probeType(metric)) ? "run" : (fact.get(item) ?? item);
    const grades = new GradeLog(join(dir, "grades.jsonl")).latest();
    const version = new Map(grades.map((g) => [`${g.arm}/${g.item}`, g.version]));
    const pairing = readPairing(join(dir, "pairing.jsonl"), manifest.order as string[]);
    const controls = (manifest.order as string[]).filter((a) => a.includes("~"));
    const report = controls.map((control) => {
        const arm = armBase(control);
        // Grading commits every arm of an item in one batch, so a version split marks a torn batch.
        for (const [key, v] of version) {
            const [a, item] = key.split("/") as [string, string];
            const other = version.get(`${control}/${item}`);
            if (a === arm && other !== undefined && other !== v) {
                throw new Error(
                    `${dir}: ${item} is graded ${arm} v${v} but ${control} v${other}; grade the run again`,
                );
            }
        }
        const metrics = [...pairedDiffs(grades, arm, control)].map(([m, d]) =>
            bootstrapMean(m, d, clusterOf(m), prereg.bootstrap.replicates, prereg.bootstrap.seed),
        );
        const informative = metrics.filter((m) => m.clusters >= MIN_CLUSTERS);
        const sessions = new Set(
            pairing.filter((r) => r.kind === "turn" && r.arm === control).map((r) => r.session),
        );
        const diverged = pairing.filter((r) => r.kind === "divergedAt" && r.arm === control);
        return {
            arm,
            control,
            prereg_sha256,
            metrics,
            method: "cluster percentile bootstrap, 95%",
            every_interval_covers_zero:
                informative.length === 0 ? null : informative.every((m) => m.covers_zero),
            intervals_missing_zero: informative.filter((m) => !m.covers_zero).map((m) => m.metric),
            expected_by_chance: 0.05 * informative.length,
            uninformative: metrics.filter((m) => m.clusters < MIN_CLUSTERS).map((m) => m.metric),
            disagreement_rate: disagreementRate(grades, arm, control),
            sessions: sessions.size,
            sessions_diverged: diverged.length,
            divergence_indices: diverged.map((r) => r.index),
        };
    });
    // Written beside and renamed over, so a symlink at `aa.json` is replaced, never followed.
    const out = join(dir, "aa.json");
    writeFileSync(`${out}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(`${out}.tmp`, out);
    return report;
}

if (import.meta.main) {
    const dir = resolve(process.argv[2] ?? "");
    if (!existsSync(join(dir, "grades.jsonl"))) {
        console.error("usage: bun scripts/aa-report.ts <graded run dir>");
        process.exit(2);
    }
    console.log(JSON.stringify(aaReport(dir), null, 2));
}
