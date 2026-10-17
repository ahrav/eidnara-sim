import {
    existsSync,
    lstatSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GradeLog } from "../src/grade/probes";
import { armBase, requireOrder } from "../src/hosts/arms";
import { sha256Hex } from "../src/prereg/canonical";
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
import {
    behaviourPlan,
    deliveredTurns,
    type Label,
    pinnedTurns,
    realisedRates,
} from "../src/usersim/plan";
import {
    pairingMismatches,
    readPairing,
    type TurnRecord,
    tapeDigests,
} from "../src/usersim/usersim";

/** A percentile interval over fewer clusters than this undercovers, so it decides nothing. */
const MIN_CLUSTERS = 5;
const VERDICTS: readonly string[] = ["pass", "fail", "excluded"];
/** docs/claim-boundary.md: every report carries this document's version. */
const CLAIM_BOUNDARY = "sim-claim-boundary/v1";
/** Labels whose text the model writes, so their turns come from the tape or a live call. */
const REACTIVE = new Set(["pushback", "redirect", "abandon", "clarify"]);

export function aaReport(dir: string) {
    // The lease, the staging file, and aa.json land in `dir` itself, never through a link.
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
    if (realpathSync(dir) !== dir) {
        throw new Error(`${dir} is not a real path; pass ${realpathSync(dir)}`);
    }
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
    const order = manifest.order as string[];
    requireOrder(order, prereg.arms.run, prereg.aa_controls?.pairs ?? []);
    // The run arms keep the seed's pre-registered relative order, as the run command schedules them.
    const seedIndex = prereg.seeds.indexOf(manifest.seed);
    if (seedIndex < 0) {
        throw new Error(`${dir}: seed ${manifest.seed} is not pre-registered for ${manifest.tier}`);
    }
    const seedOrder: string[] = prereg.arms.order_by_seed[seedIndex] ?? prereg.arms.run;
    const runArms = order.filter((a) => a === armBase(a));
    const kept = seedOrder.filter((a) => runArms.includes(a));
    if (JSON.stringify(kept) !== JSON.stringify(runArms)) {
        throw new Error(
            `${dir}: manifest order ${runArms.join(",")} is not the order seed ${manifest.seed} pre-registers (${seedOrder.join(",")})`,
        );
    }
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
    const journalPath = join(dir, "journal.jsonl");
    const entries = readJournal(journalPath);
    // readJournal drops a terminated line it cannot parse; a completed run's journal has none.
    const terminated = existsSync(journalPath)
        ? readFileSync(journalPath, "utf8").split("\n").length - 1
        : 0;
    if (terminated !== entries.length) {
        throw new Error(`${journalPath}: a terminated line is corrupt`);
    }
    requireComplete(entries, order, scheduled);
    // GradeLog repairs a cut last line in place, so only a file that is nobody else's may be opened.
    const gradesPath = join(dir, "grades.jsonl");
    const stat = lstatSync(gradesPath);
    if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`${gradesPath} is not a regular file with one link`);
    }
    const log = new GradeLog(gradesPath);
    // Only a P7 grade names an opponent, and each item/arm sequence runs 1..n once.
    const versions = new Map<string, number[]>();
    for (const g of log.all()) {
        if ((g.probe_type === "P7") !== (typeof g.against === "string")) {
            throw new Error(
                `${gradesPath}: ${g.arm}/${g.item} has an against value only P7 carries`,
            );
        }
        const key = `${g.arm}/${g.item}/${g.against ?? ""}`;
        versions.set(key, [...(versions.get(key) ?? []), g.version]);
    }
    for (const [key, seen] of versions) {
        const sorted = [...seen].sort((a, b) => a - b);
        if (sorted.some((v, i) => v !== i + 1)) {
            throw new Error(
                `${gradesPath}: ${key} versions ${seen.join(",")} are not 1..${seen.length} once each`,
            );
        }
    }
    const grades = log.latest();
    // grade-run grades an item from the arm's first journaled snapshot, when its turn ended ok.
    const eventOf = new Map(
        prefix.flatMap((e) => {
            const probe = (e as { probe?: string }).probe;
            return probe === undefined ? [] : [[probe, String(e.id)] as const];
        }),
    );
    const endedOk = new Set(
        entries
            .filter((e) => e.kind === "EndTurn" && e.outcome === "ok")
            .map((e) => `${String(e.arm)}/${String(e.event)}/${String(e.snapshot)}`),
    );
    const okSnapshot = new Map<string, string>();
    for (const e of entries.filter((e) => e.kind === "SnapshotArtefacts")) {
        const key = `${String(e.arm)}/${String(e.item)}`;
        const ended = `${String(e.arm)}/${eventOf.get(String(e.item))}/${String(e.snapshot)}`;
        if (!okSnapshot.has(key) && endedOk.has(ended)) {
            okSnapshot.set(key, String(e.snapshot));
        }
    }
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
        // A metric is a boolean or a finite number, which pairedDiffs pairs, or a categorical
        // string such as the grader's P3.reliance, which it leaves out; the verdict metric states
        // the verdict.
        const odd = Object.entries(g.metrics ?? {}).find(
            ([, v]) =>
                typeof v !== "boolean" &&
                typeof v !== "string" &&
                !(typeof v === "number" && Number.isFinite(v)),
        );
        if (odd) {
            throw new Error(
                `${dir}/grades.jsonl: ${g.arm}/${g.item} ${odd[0]} is not a boolean, a string, or a finite number`,
            );
        }
        const pass = g.metrics?.[`${g.probe_type}.pass`];
        if (g.verdict !== "excluded" && pass !== undefined && pass !== (g.verdict === "pass")) {
            throw new Error(
                `${dir}/grades.jsonl: ${g.arm}/${g.item} ${g.probe_type}.pass contradicts its verdict`,
            );
        }
        if (!sound)
            throw new Error(`${dir}/grades.jsonl: ${g.arm}/${g.item} is not a grade of this run`);
        const expected = okSnapshot.get(`${g.arm}/${g.item}`);
        if (g.probe_type !== "P7" && (expected === undefined || g.snapshot !== expected)) {
            throw new Error(
                `${dir}/grades.jsonl: ${g.arm}/${g.item} snapshot ${g.snapshot} is not the journaled first snapshot of a turn that ended ok`,
            );
        }
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
    const reference = referenceArm(order);
    const tapes = (manifest.tapes ?? []) as string[];
    if (JSON.stringify(tapeDigests(tapes)) !== JSON.stringify(manifest.tape_sha256 ?? [])) {
        throw new Error(`${dir}: replay sources changed since the manifest hashed them`);
    }
    // Every replay source's turn for an arm's event is a (digest, context) the runner may have
    // recorded against.
    const recorded = new Map<string, { digest: string; context: string }[]>();
    for (const tape of tapes) {
        for (const r of readPairing(join(dirname(tape), "pairing.jsonl"))) {
            if (r.kind !== "turn") continue;
            const key = `${r.arm}/${r.event}`;
            recorded.set(key, [
                ...(recorded.get(key) ?? []),
                { digest: r.digest, context: r.context_sha256 },
            ]);
        }
    }
    const turnDigest = new Map(
        pairing.filter((r) => r.kind === "turn").map((r) => [`${r.arm}/${r.event}`, r]),
    );
    for (const r of pairing) {
        if (r.kind !== "divergedAt") continue;
        // A divergence against the reference arm cites the reference arm's differing digest at
        // the same event. A divergence against a recorded run is a context no source holds, and
        // cites a source's digest and context; the control's digest may equal the source's.
        const mine = turnDigest.get(`${r.arm}/${r.event}`);
        const theirs = turnDigest.get(`${reference(r.arm)}/${r.event}`);
        const sources = recorded.get(`${r.arm}/${r.event}`) ?? [];
        const cited =
            r.against === "recorded"
                ? sources.some(
                      (x) =>
                          x.digest === r.reference_digest &&
                          x.context === r.recorded_context_sha256,
                  ) && sources.every((x) => x.context !== r.context_sha256)
                : theirs?.digest === r.reference_digest && r.reference_digest !== r.digest;
        // The runner writes the divergence before the turn it describes, and derives a reference
        // divergence from the reference arm's turn, which is on disk before it.
        if (mine && pairing.indexOf(r) > pairing.indexOf(mine)) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} divergence at ${r.event} is recorded after its turn`,
            );
        }
        if (r.against === "reference" && theirs && pairing.indexOf(theirs) > pairing.indexOf(r)) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} divergence at ${r.event} is recorded before the reference turn it cites`,
            );
        }
        const sound =
            mine?.digest === r.digest && mine.context_sha256 === r.context_sha256 && cited;
        if (!sound) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} divergence at ${r.event} does not match the turns it cites`,
            );
        }
    }
    // A probe or paste turn, and any turn delivered from the script alone, carries the compiled
    // text verbatim, on every arm.
    for (const r of pairing) {
        if (r.kind !== "turn") continue;
        const e = turnOf.get(r.event) as { role?: string; text?: unknown } | undefined;
        const verbatim = e?.role === "probe" || e?.role === "paste" || r.source === "script";
        if (!e || !verbatim || !r.delivered) continue;
        if (r.text_sha256 !== sha256Hex(String(e.text))) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} ${r.event} differs from the compiled text`,
            );
        }
    }
    // A control turn whose digest differs from its reference arm's is a divergence the runner
    // recorded at or before that index; a session with no row for it has lost evidence.
    const divergedBy = new Map<string, number>();
    for (const r of pairing) {
        if (r.kind !== "divergedAt") continue;
        const key = `${r.arm}/${r.session}`;
        divergedBy.set(key, Math.min(divergedBy.get(key) ?? Number.POSITIVE_INFINITY, r.index));
    }
    for (const r of pairing) {
        if (r.kind !== "turn" || r.arm === reference(r.arm)) continue;
        const theirs = turnDigest.get(`${reference(r.arm)}/${r.event}`);
        if (theirs && theirs.digest !== r.digest) {
            const at = divergedBy.get(`${r.arm}/${r.session}`) ?? Number.POSITIVE_INFINITY;
            if (at > r.index) {
                throw new Error(
                    `${dir}/pairing.jsonl: ${r.arm} ${r.event} differs from ${reference(r.arm)} with no divergence recorded at or before index ${r.index}`,
                );
            }
        }
    }
    const mismatched = pairingMismatches(pairing, reference);
    const controls = order.filter((a) => a !== armBase(a));
    if (controls.length === 0) throw new Error(`${dir}: manifest order names no A/A control`);
    const report = controls.map((control) => {
        const arm = armBase(control);
        for (const a of [arm, control]) {
            // Each paired turn is one journaled UserTurn of the same delivery, as pairing-check requires.
            const users = entries.filter((e) => e.kind === "UserTurn" && e.arm === a);
            for (const r of pairing) {
                if (r.kind !== "turn" || r.arm !== a) continue;
                const mine = users.filter((e) => String(e.event) === r.event);
                if (
                    mine.length !== 1 ||
                    mine[0]?.delivered !== r.delivered ||
                    mine[0]?.recovered === true
                ) {
                    throw new Error(
                        `${dir}: ${a} ${r.event} has ${mine.length} journaled UserTurn entries matching its pairing record`,
                    );
                }
                // The journal names the turn's label; a reactive label's text came from the tape
                // or a live call, a scripted label's from the script.
                // A scheduled interrupt the host finished first is journaled `task` with
                // `scheduled: "interrupt"` and no interruption.
                const relabel =
                    r.label === "interrupt" &&
                    mine[0]?.label === "task" &&
                    mine[0]?.scheduled === "interrupt" &&
                    mine[0]?.interrupted !== true;
                if (mine[0]?.label !== r.label && !relabel) {
                    throw new Error(
                        `${dir}: ${a} ${r.event} pairing label ${r.label} differs from the journaled label`,
                    );
                }
                if (r.delivered && REACTIVE.has(r.label) === (r.source === "script")) {
                    throw new Error(
                        `${dir}: ${a} ${r.event} label ${r.label} disagrees with source ${r.source}`,
                    );
                }
            }
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
        // Both grades of a paired item carry the same metric keys, so every metric sees every item.
        const byItem = (a: string) =>
            new Map(
                diagnosed
                    .filter((g) => g.arm === a && g.verdict !== "excluded")
                    .map((g) => [g.item, g]),
            );
        const [left, right] = [byItem(arm), byItem(control)];
        for (const [item, x] of left) {
            const y = right.get(item);
            if (!y) continue;
            const [kx, ky] = [Object.keys(x.metrics), Object.keys(y.metrics)];
            const odd = [
                ...kx.filter((k) => !ky.includes(k)),
                ...ky.filter((k) => !kx.includes(k)),
                ...kx.filter((k) => ky.includes(k) && typeof x.metrics[k] !== typeof y.metrics[k]),
            ];
            if (odd.length > 0) {
                throw new Error(
                    `${dir}/grades.jsonl: ${item} carries ${odd.join(", ")} on one arm only`,
                );
            }
        }
        const metrics = [...pairedDiffs(grades, arm, control)].map(([m, d]) =>
            bootstrapMean(m, d, clusterOf(m), prereg.bootstrap.replicates, prereg.bootstrap.seed),
        );
        for (const m of metrics) {
            if (![m.mean, m.lo, m.hi].every(Number.isFinite)) {
                throw new Error(
                    `${dir}: ${m.metric} differences overflow; its statistics are not finite`,
                );
            }
        }
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
    // The labels are the seeded plan's, under the run's effective fault schedule, and each arm's
    // journaled rate summary is the one its delivered turns give.
    const plan = behaviourPlan(
        scenario.events
            .filter((e) => e.kind === "user_turn")
            .map((e) => ({
                id: String(e.id),
                session: String(e.session),
                index: Number(e.index),
                role: String(e.role),
            })),
        prereg,
        manifest.seed as number,
        pinnedTurns(
            scenario.events.map((e) => ({
                id: String(e.id),
                kind: String(e.kind),
                session: String(e.session),
                ...(typeof e.index === "number" ? { index: e.index } : {}),
            })),
            (manifest.fault_override as typeof scenario.faults | null | undefined) ??
                scenario.faults ??
                [],
        ),
    );
    const twinOf = (a: string) =>
        a === armBase(a) ? order.find((c) => c !== a && armBase(c) === a) : armBase(a);
    for (const r of pairing) {
        if (r.kind !== "turn") continue;
        const planned = plan.skipped.has(r.event)
            ? "abandon"
            : (plan.labels.get(r.event) ?? "task");
        const e = turnOf.get(r.event) as { role?: string } | undefined;
        const clarify = planned === "task" && r.label === "clarify" && e?.role === "filler";
        if (r.label !== planned && !clarify) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} ${r.event} carries label ${r.label}; the seeded plan assigned ${planned}`,
            );
        }
        // The pair compares two agents that received the same inputs: a turn is undelivered on
        // both sides or neither, and only where the plan abandoned the session's trailing turns.
        const twin = pairing.find(
            (x): x is TurnRecord =>
                x.kind === "turn" && x.event === r.event && x.arm === twinOf(r.arm),
        );
        if (twin && twin.delivered !== r.delivered) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} and ${twin.arm} disagree on whether ${r.event} was delivered`,
            );
        }
        if (!r.delivered && !plan.skipped.has(r.event)) {
            throw new Error(
                `${dir}/pairing.jsonl: ${r.arm} ${r.event} is undelivered outside the plan's skipped turns`,
            );
        }
    }
    const rateOutside: Record<string, string[]> = {};
    for (const arm of order) {
        const journaled = entries.filter((e) => e.kind === "UserSimRates" && e.arm === arm);
        if (journaled.length !== 1) {
            throw new Error(
                `${dir}/journal.jsonl: arm ${arm} has ${journaled.length} UserSimRates entries`,
            );
        }
        const expected = realisedRates(
            deliveredTurns(entries, arm).map((e) => ({
                session: String(e.session),
                label: e.label as Label,
            })),
            prereg,
        );
        const summary = journaled[0] as Record<string, unknown>;
        const held = {
            turns: summary.turns,
            sessions: summary.sessions,
            rates: summary.rates,
            outside: summary.outside,
        };
        if (JSON.stringify(held) !== JSON.stringify(expected)) {
            throw new Error(
                `${dir}/journal.jsonl: arm ${arm}'s UserSimRates differs from its delivered turns`,
            );
        }
        rateOutside[arm] = expected.outside;
        // Rates outside their pre-registered bands are an unregistered condition.
        if (expected.outside.length > 0) {
            throw new Error(
                `${dir}/journal.jsonl: arm ${arm}'s realised rates leave their bands: ${expected.outside.join(", ")}`,
            );
        }
    }
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
