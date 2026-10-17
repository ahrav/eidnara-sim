import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase, requireOrder } from "../src/hosts/arms";
import { ARMS, type Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { bootstrapMean, disagreementRate, pairedDiffs } from "../src/report/paired";
import { readJournal, releaseLease, requireComplete, takeLease } from "../src/run/journal";
import { referenceArm } from "../src/run/run";
import { type Scenario, scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { pairingMismatches, readPairing } from "../src/usersim/usersim";

/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;

export function aaReport(dir: string) {
    // The lease, the staging file, and aa.json land in `dir` itself, never through a link.
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
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
    // GradeLog repairs a cut last line in place, so only a regular file may be opened.
    const gradesPath = join(dir, "grades.jsonl");
    if (!lstatSync(gradesPath).isFile()) throw new Error(`${gradesPath} is not a regular file`);
    const grades = new GradeLog(gradesPath).latest();
    const order = manifest.order as string[];
    requireOrder(order, ARMS, prereg.aa_controls?.pairs ?? []);
    const scheduled = scenario.events.slice(0, manifest.events).map((e) => String(e.id));
    requireComplete(readJournal(join(dir, "journal.jsonl")), order, scheduled);
    const typeOf = new Map(scenario.probes.map((p) => [p.id, p.type]));
    for (const g of grades) {
        const sound =
            order.includes(g.arm) &&
            typeOf.get(g.item) === g.probe_type &&
            Number.isInteger(g.version) &&
            typeof g.verdict === "string" &&
            typeof g.metrics === "object" &&
            g.metrics !== null;
        if (!sound)
            throw new Error(`${dir}/grades.jsonl: ${g.arm}/${g.item} is not a grade of this run`);
    }
    const pairing = readPairing(join(dir, "pairing.jsonl"), order);
    const mismatched = pairingMismatches(pairing, referenceArm(order));
    const controls = order.filter((a) => a !== armBase(a));
    const report = controls.map((control) => {
        const arm = armBase(control);
        const events = (a: string) =>
            new Set(pairing.filter((r) => r.kind === "turn" && r.arm === a).map((r) => r.event));
        const [mine, theirs] = [events(control), events(arm)];
        const unpaired = [...mine, ...theirs].filter((e) => !(mine.has(e) && theirs.has(e)));
        if (mine.size === 0) throw new Error(`${dir}: no paired turns for ${control}`);
        if (unpaired.length > 0) {
            throw new Error(
                `${dir}: turns without a counterpart between ${arm} and ${control}: ${unpaired.join(", ")}`,
            );
        }
        const broken = mismatched.filter((m) => m.startsWith(`${control} `));
        if (broken.length > 0) {
            throw new Error(
                `${dir}: ${control} received other text than ${arm} before diverging: ${broken.join(", ")}`,
            );
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
    // Staged under an exclusive create, which refuses an existing path or symlink, then renamed
    // over `aa.json`, so neither name is written through.
    const out = join(dir, "aa.json");
    const staged = `${out}.${process.pid}.tmp`;
    try {
        writeFileSync(staged, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        renameSync(staged, out);
    } finally {
        rmSync(staged, { force: true });
    }
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
