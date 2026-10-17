import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import type { Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { bootstrapMean, disagreementRate, pairedDiffs } from "../src/report/paired";
import { readJournal } from "../src/run/journal";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import type { PairingRecord } from "../src/usersim/usersim";

/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;

export function aaReport(dir: string) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const prereg = loadPrereg(manifest.tier as Tier);
    const prereg_sha256 = preregistrationHash(prereg);
    if (prereg_sha256 !== manifest.prereg_sha256) {
        throw new Error(
            `${dir}: ran under pre-registration ${manifest.prereg_sha256}; this report uses ${prereg_sha256}`,
        );
    }
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
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
    // SAFETY: Each line in `pairing.jsonl` must contain a `PairingRecord`.
    const pairing = readJournal(join(dir, "pairing.jsonl")) as unknown as PairingRecord[];
    const controls = (manifest.order as string[]).filter((a) => a.includes("~"));
    const report = controls.map((control) => {
        const arm = armBase(control);
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
            every_interval_covers_zero: informative.every((m) => m.covers_zero),
            intervals_missing_zero: informative.filter((m) => !m.covers_zero).map((m) => m.metric),
            expected_by_chance: 0.05 * informative.length,
            uninformative: metrics.filter((m) => m.clusters < MIN_CLUSTERS).map((m) => m.metric),
            disagreement_rate: disagreementRate(grades, arm, control),
            sessions: sessions.size,
            sessions_diverged: diverged.length,
            divergence_indices: diverged.map((r) => r.index),
        };
    });
    writeFileSync(join(dir, "aa.json"), `${JSON.stringify(report, null, 2)}\n`);
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
