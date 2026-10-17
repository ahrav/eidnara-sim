import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase, requireOrder } from "../src/hosts/arms";
import type { Tier } from "../src/prereg/schema";
import { preregistrationHash } from "../src/prereg/validate";
import { bootstrapMean, disagreementRate, pairedDiffs } from "../src/report/paired";
import {
    readJournal,
    releaseLease,
    requireComplete,
    stagingPath,
    takeLease,
} from "../src/run/journal";
import { referenceArm } from "../src/run/run";
import { type Scenario, scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { pairingMismatches, readPairing } from "../src/usersim/usersim";

/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;
const VERDICTS: readonly string[] = ["pass", "fail", "excluded"];
/** docs/claim-boundary.md: every report carries this document's version. */
const CLAIM_BOUNDARY = "sim-claim-boundary/v1";

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
    const compiled = scenario.manifest as { seed: number; tier: string };
    if (compiled.tier !== manifest.tier || compiled.seed !== manifest.seed) {
        throw new Error(
            `${dir}: scenario.json is ${compiled.tier} seed ${compiled.seed}, the manifest ${manifest.tier} seed ${manifest.seed}`,
        );
    }
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
    // GradeLog repairs a cut last line in place, so only a file that is nobody else's may be opened.
    const gradesPath = join(dir, "grades.jsonl");
    const stat = lstatSync(gradesPath);
    if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`${gradesPath} is not a regular file with one link`);
    }
    const grades = new GradeLog(gradesPath).latest();
    const order = manifest.order as string[];
    requireOrder(order, prereg.arms.run, prereg.aa_controls?.pairs ?? []);
    const count: unknown = manifest.events;
    if (
        !Number.isInteger(count) ||
        (count as number) < 1 ||
        (count as number) > scenario.events.length
    ) {
        throw new Error(
            `${dir}: manifest events ${String(count)} is outside 1..${scenario.events.length}`,
        );
    }
    const scheduled = scenario.events.slice(0, manifest.events).map((e) => String(e.id));
    const prefix = scenario.events.slice(0, manifest.events);
    const userTurns = prefix.filter((e) => e.kind === "user_turn").map((e) => String(e.id));
    // A probe is reached through its turn's event; a P14 item, which has no turn, through its
    // session ending inside the prefix.
    const ended = new Set(
        prefix.filter((e) => e.kind === "session_end").map((e) => String(e.session)),
    );
    const reached = [
        ...prefix.flatMap((e) => {
            const probe = (e as { probe?: string }).probe;
            return probe === undefined ? [] : [probe];
        }),
        ...scenario.probes.filter((p) => p.type === "P14" && ended.has(p.session)).map((p) => p.id),
    ];
    requireComplete(readJournal(join(dir, "journal.jsonl")), order, scheduled);
    const typeOf = new Map(scenario.probes.map((p) => [p.id, p.type]));
    for (const g of grades) {
        const sound =
            order.includes(g.arm) &&
            typeOf.get(g.item) === g.probe_type &&
            (g.probe_type === "P7" || reached.includes(g.item)) &&
            Number.isInteger(g.version) &&
            VERDICTS.includes(g.verdict) &&
            typeof g.metrics === "object" &&
            g.metrics !== null;
        if (!sound)
            throw new Error(`${dir}/grades.jsonl: ${g.arm}/${g.item} is not a grade of this run`);
    }
    const pairing = readPairing(join(dir, "pairing.jsonl"), order);
    // Each pairing row names a scheduled event and sits at that event's session and index.
    const turnOf = new Map(
        prefix
            .filter((e) => e.kind === "user_turn")
            .map((e) => [String(e.id), e as { session?: string; index?: number }]),
    );
    const seen = new Set<string>();
    for (const r of pairing) {
        const identity =
            r.kind === "turn" ? `${r.arm} turn ${r.event}` : `${r.arm} divergence in ${r.session}`;
        if (seen.has(identity)) {
            throw new Error(`${dir}/pairing.jsonl: ${identity} is recorded twice`);
        }
        seen.add(identity);
        const e = turnOf.get(r.event);
        if (!e || e.session !== r.session || e.index !== r.index) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} ${r.kind} for ${r.event} at ${r.session} index ${r.index} matches no scheduled turn`,
            );
        }
    }
    const mismatched = pairingMismatches(pairing, referenceArm(order));
    const controls = order.filter((a) => a !== armBase(a));
    const report = controls.map((control) => {
        const arm = armBase(control);
        for (const a of [arm, control]) {
            const delivered = new Set(
                pairing.filter((r) => r.kind === "turn" && r.arm === a).map((r) => r.event),
            );
            const lost = userTurns.filter((e) => !delivered.has(e));
            if (lost.length > 0) {
                throw new Error(`${dir}: ${a} has no pairing record for ${lost.join(", ")}`);
            }
        }
        const broken = mismatched.filter((m) => m.startsWith(`${control} `));
        if (broken.length > 0) {
            throw new Error(
                `${dir}: ${control} received other text than ${arm} before diverging: ${broken.join(", ")}`,
            );
        }
        // P7 grades come from judgments against the host arm, so they stay out of the pairing.
        const diagnosed = grades.filter((g) => g.probe_type !== "P7");
        const graded = (a: string, verdict: (v: string) => boolean) =>
            diagnosed.filter((g) => g.arm === a && verdict(g.verdict)).map((g) => g.item);
        const missing = Object.fromEntries(
            [arm, control].map((a) => {
                const mine = new Set(graded(a, () => true));
                const none = [...reached].filter((id) => typeOf.get(id) !== "P7" && !mine.has(id));
                return [a, none.length];
            }),
        );
        const excluded = Object.fromEntries(
            [arm, control].map((a) => [a, graded(a, (v) => v === "excluded").length]),
        );
        const kept = (a: string) => new Set(graded(a, (v) => v !== "excluded"));
        const [mineItems, theirItems] = [kept(control), kept(arm)];

        const unpaired_items = [...new Set([...mineItems, ...theirItems])]
            .filter((i) => !(mineItems.has(i) && theirItems.has(i)))
            .sort();
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
            claim_boundary: CLAIM_BOUNDARY,
            metrics,
            method: "cluster percentile bootstrap, 95%",
            every_interval_covers_zero:
                informative.length === 0 ? null : informative.every((m) => m.covers_zero),
            intervals_missing_zero: informative.filter((m) => !m.covers_zero).map((m) => m.metric),
            expected_by_chance: 0.05 * informative.length,
            uninformative: metrics.filter((m) => m.clusters < MIN_CLUSTERS).map((m) => m.metric),
            excluded,
            missing,
            unpaired_items,
            disagreement_rate: disagreementRate(grades, arm, control),
            sessions: sessions.size,
            sessions_diverged: diverged.length,
            divergence_indices: diverged.map((r) => r.index),
        };
    });
    // Staged under an exclusive create at a name of its own, then renamed over `aa.json`, so a
    // symlink at either name is replaced and a leftover of a killed report blocks nothing.
    const out = join(dir, "aa.json");
    const staged = stagingPath(out);
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
