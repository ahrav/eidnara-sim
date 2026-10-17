import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORPUS_DIR } from "../src/corpus/sources";
import { requireOrder } from "../src/hosts/arms";
import { sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { readJournalStrict, requireComplete } from "../src/run/journal";
import { CallIndex, referenceArm } from "../src/run/run";
import type { Scenario } from "../src/scenario/compile";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import {
    behaviourPlan,
    deliveredTurns,
    LABELS,
    type Label,
    pinnedTurns,
    realisedRates,
} from "../src/usersim/plan";
import {
    asksQuestion,
    pairingMismatches,
    readPairing,
    type TurnRecord,
    tapeMismatches,
} from "../src/usersim/usersim";

const dir = resolve(process.argv[2] ?? "");
if (!existsSync(join(dir, "pairing.jsonl"))) {
    console.error("usage: bun scripts/pairing-check.ts <run dir>");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
// The manifest names the run the checker certifies; an order with no arm certifies nothing.
const order: unknown = manifest.order;
if (
    typeof manifest.tier !== "string" ||
    !Number.isInteger(manifest.events) ||
    !Array.isArray(order) ||
    order.length === 0 ||
    order.some((a) => typeof a !== "string" || a === "") ||
    new Set(order).size !== order.length
) {
    console.error("manifest.json needs a tier, an event count, and a non-empty distinct arm order");
    process.exit(2);
}
if (manifest.schema !== "sim-run-manifest/v2") {
    console.error(
        `manifest.json is ${String(manifest.schema)}; the checker reads sim-run-manifest/v2`,
    );
    process.exit(2);
}
const scenarioJson: unknown = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const scenario = scenarioJson as Scenario;
// The manifest names one run: its event count lies within the compiled scenario, and its seed
// and tier are the ones the scenario was compiled for.
if (manifest.events <= 0 || manifest.events > scenario.events.length) {
    console.error(
        `manifest.json claims ${manifest.events} events; the scenario has ${scenario.events.length}`,
    );
    process.exit(2);
}
const compiledFor = (
    scenarioJson as {
        manifest?: { seed?: unknown; tier?: unknown; corpus_manifest_sha256?: unknown };
    }
).manifest;
if (compiledFor?.seed !== manifest.seed || compiledFor?.tier !== manifest.tier) {
    console.error(
        `manifest.json names seed ${manifest.seed} tier ${manifest.tier}; the scenario was compiled for seed ${compiledFor?.seed} tier ${compiledFor?.tier}`,
    );
    process.exit(2);
}
// The checker certifies against the scenario and pre-registration the manifest attests.
if (scenarioHash(scenarioJson as Record<string, unknown>) !== manifest.scenario_hash) {
    console.error(`scenario.json does not match the manifest's scenario hash`);
    process.exit(2);
}
const records = readPairing(join(dir, "pairing.jsonl"));
// The order's control structure, as the run command admits it; the arms it names are the
// manifest's own, which the oracle loader and the A/A report bind to the tier.
requireOrder(
    manifest.order as string[],
    loadPrereg(manifest.tier).arms.run,
    loadPrereg(manifest.tier).aa_controls?.pairs ?? [],
);
const reference = referenceArm(manifest.order);
const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
const script = new Map(
    scenario.events
        .filter((e) => e.kind === "user_turn")
        .map((e) => [e.id, e as Record<string, unknown>]),
);
const verbatim = turns.filter((r) => {
    const role = script.get(r.event)?.role;
    return role === "paste" || role === "probe";
});
const altered = verbatim
    .filter((r) => r.text_sha256 !== sha256Hex(String(script.get(r.event)?.text)))
    .map((r) => `${r.arm} ${r.event}`);
// A delivered row sent from the script alone carries the compiled text's hash.
const scriptAltered = turns
    .filter((r) => r.delivered && r.source === "script" && script.has(r.event))
    .filter((r) => r.text_sha256 !== sha256Hex(String(script.get(r.event)?.text)))
    .map((r) => `${r.arm} ${r.event}`);
// The paste bytes come from the corpus the scenario was compiled from: its manifest hash is
// the scenario's, and the samples file is the one that manifest names.
const corpusManifestText = readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8");
if (sha256Hex(corpusManifestText) !== compiledFor?.corpus_manifest_sha256) {
    console.error("corpus/manifest.json differs from the corpus the scenario was compiled from");
    process.exit(2);
}
const samplesText = readFileSync(join(CORPUS_DIR, "tool-outputs/samples.jsonl"), "utf8");
const attestedSamples = (JSON.parse(corpusManifestText) as { files?: Record<string, string> })
    .files?.["tool-outputs/samples.jsonl"];
if (sha256Hex(samplesText) !== attestedSamples) {
    console.error("corpus/tool-outputs/samples.jsonl differs from the corpus manifest's digest");
    process.exit(2);
}
const corpus = new Map(
    samplesText
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { id: string; content: string })
        .map((s) => [s.id, s.content]),
);
// A paste turn's record names the corpus item the compiled text carries, by id and byte length.
const provenance = turns
    .filter((r) => script.get(r.event)?.role === "paste")
    .filter((r) => {
        const event = script.get(r.event) as {
            text?: unknown;
            paste?: { sample_id: string; bytes: number };
        };
        const content = event.paste ? corpus.get(event.paste.sample_id) : undefined;
        const compiled =
            content !== undefined &&
            event.paste !== undefined &&
            Buffer.byteLength(content) === event.paste.bytes &&
            String(event.text).includes(content);
        return !(
            compiled &&
            r.paste?.sample_id === event.paste?.sample_id &&
            r.paste?.bytes === event.paste?.bytes
        );
    })
    .map((r) => `${r.arm} ${r.event}`);
const journal = readJournalStrict(join(dir, "journal.jsonl"));
const allScheduledIds = scenario.events.slice(0, manifest.events as number).map((e) => e.id);
let incompleteRun: string[] = [];
try {
    requireComplete(journal, manifest.order as string[], allScheduledIds);
} catch (caught) {
    incompleteRun = [String((caught as Error).message)];
}
// Delivery is read from the journal, which knows whether the host received the text.
const journalDelivered = new Set(
    journal
        .filter((e) => e.kind === "UserTurn" && e.delivered === true && e.recovered !== true)
        .map((e) => `${e.arm} ${e.event}`),
);
const unsent = turns
    .filter((r) => script.get(r.event)?.role !== "filler")
    .filter((r) => !r.delivered || !journalDelivered.has(`${r.arm} ${r.event}`))
    .map((r) => `${r.arm} ${r.event}`);
// A filler the user-sim queued but the host never received is a pairing break too; only a
// filler the plan skipped is undelivered by design.
const undeliveredTurns = turns
    .filter((r) => script.get(r.event)?.role === "filler" && r.delivered)
    .filter((r) => !journalDelivered.has(`${r.arm} ${r.event}`))
    .map((r) => `${r.arm} ${r.event}`);
// A reactive label's text comes from the tape or a live call; a scripted label's from the script.
const REACTIVE = new Set(["pushback", "redirect", "abandon", "clarify"]);
const sourceLabelMismatch = turns
    .filter((r) => r.delivered)
    .filter((r) => (REACTIVE.has(r.label) ? r.source === "script" : r.source !== "script"))
    .map((r) => `${r.arm} ${r.event}`);
const prereg = loadPrereg(manifest.tier);
if (preregistrationHash(prereg) !== manifest.prereg_sha256) {
    console.error(`the ${manifest.tier} pre-registration differs from the manifest's`);
    process.exit(2);
}
// A divergence row is a cutoff only at its compiled event, for a known arm, with digests that
// differ.
const arms = new Set(manifest.order as string[]);
// The replay sources the manifest names, read for the rows a recorded divergence cites.
const sourceTurns = new Map<string, TurnRecord[]>();
for (const tape of (manifest.tapes as string[] | undefined) ?? []) {
    for (const r of readPairing(join(dirname(tape), "pairing.jsonl"))) {
        if (r.kind !== "turn") continue;
        const key = `${r.arm}/${r.event}`;
        sourceTurns.set(key, [...(sourceTurns.get(key) ?? []), r]);
    }
}
const invalidDivergences = records
    .filter((r) => r.kind === "divergedAt")
    .filter((r) => {
        const event = script.get(r.event);
        const own = turns.find((t) => t.arm === r.arm && t.event === r.event);
        const ref = turns.find((t) => t.arm === reference(r.arm) && t.event === r.event);
        // The record is on disk before the turn it describes, so it precedes that turn's row.
        const at = records.indexOf(r);
        const ahead =
            own !== undefined &&
            at < records.indexOf(own) &&
            (r.against === "recorded" || (ref !== undefined && records.indexOf(ref) < at));
        const bound =
            ahead &&
            own?.digest === r.digest &&
            own?.context_sha256 === r.context_sha256 &&
            (r.against === "recorded" || ref?.digest === r.reference_digest);
        // A recorded divergence cites a replay source's row for the event: the manifest names
        // the source, and that source's pairing log holds the cited digest and context.
        const sourceRows =
            r.against === "recorded" ? (sourceTurns.get(`${r.arm}/${r.event}`) ?? []) : [];
        const cited =
            r.against !== "recorded" ||
            sourceRows.some(
                (x) =>
                    x.digest === r.reference_digest &&
                    x.context_sha256 === r.recorded_context_sha256,
            );
        const differs =
            bound &&
            cited &&
            (r.against === "recorded"
                ? r.recorded_context_sha256 !== undefined &&
                  r.recorded_context_sha256 !== r.context_sha256
                : r.digest !== r.reference_digest);
        return (
            !event ||
            !arms.has(r.arm) ||
            event.session !== r.session ||
            event.index !== r.index ||
            !differs
        );
    })
    .map((r) => `${r.arm} ${r.event}`);
// Every scheduled event of every arm has its Event row, and the journal's user turns and the
// pairing turns name the same set, one row each.
const allScheduled = scenario.events.slice(0, manifest.events as number);
const missingEvents = (manifest.order as string[]).flatMap((arm) => {
    const seen = new Set(
        journal.filter((e) => e.kind === "Event" && e.arm === arm).map((e) => String(e.event)),
    );
    return allScheduled.filter((e) => !seen.has(e.id)).map((e) => `${arm} ${e.id}`);
});
const journalPairingMismatch = (manifest.order as string[]).flatMap((arm) => {
    const users = journal.filter((e) => e.kind === "UserTurn" && e.arm === arm);
    const counts = new Map<string, number>();
    for (const u of users) counts.set(String(u.event), (counts.get(String(u.event)) ?? 0) + 1);
    const paired = new Map(turns.filter((r) => r.arm === arm).map((r) => [r.event, r]));
    const off = new Set<string>();
    for (const event of paired.keys()) if (counts.get(event) !== 1) off.add(event);
    for (const event of counts.keys()) if (!paired.has(event)) off.add(event);
    // The journal row names the pairing row's session and label; a scheduled interrupt the
    // host finished first is journaled `task` with `scheduled: "interrupt"`.
    for (const u of users) {
        const row = paired.get(String(u.event));
        if (!row) continue;
        const relabel =
            row.label === "interrupt" &&
            u.label === "task" &&
            u.scheduled === "interrupt" &&
            u.interrupted !== true;
        if (u.session !== row.session || (u.label !== row.label && !relabel))
            off.add(String(u.event));
        if (u.delivered === true && !row.delivered) off.add(String(u.event));
        if (u.label === "interrupt" && u.interrupted !== true) off.add(String(u.event));
    }
    return [...off].sort().map((event) => `${arm} ${event}`);
});
// A sibling arm still paired with the reference reads the reference's taped reply; a live
// reply before its divergence is a replay miss. With replay sources, the reference arm's own
// live replies before its recorded divergence are misses too.
const divergenceAt = new Map(
    records
        .filter((r) => r.kind === "divergedAt")
        .map((r) => [`${r.arm}/${r.session}`, r.index] as const),
);
const replaying = Array.isArray(manifest.tapes) && manifest.tapes.length > 0;
const liveBeforeDivergence = turns
    .filter((r) => r.source === "live" && (r.arm !== reference(r.arm) || replaying))
    .filter(
        (r) => r.index < (divergenceAt.get(`${r.arm}/${r.session}`) ?? Number.POSITIVE_INFINITY),
    )
    .map((r) => `${r.arm} ${r.event}`);
// A tape-backed row replays only through the run's own tape; its reply must still be there.
const scriptedText = new Map(
    scenario.events
        .filter((e) => e.kind === "user_turn")
        .map((e) => [e.id, String((e as { text?: unknown }).text ?? "")]),
);
const tapeMissing = existsSync(join(dir, "tape.jsonl"))
    ? tapeMismatches(join(dir, "tape.jsonl"), records, manifest.seed as number, scriptedText)
    : turns.filter((r) => r.source === "tape").map((r) => `${r.arm} ${r.event}`);
// Every arm-scoped row names an arm the manifest ran.
const unknownArms = [
    ...new Set(
        [
            ...records.map((r) => r.arm),
            ...journal.filter((e) => e.kind === "UserTurn").map((e) => String(e.arm)),
        ].filter((a) => !arms.has(a)),
    ),
].sort();
// A sibling arm's first turn whose digest leaves the reference's has its divergence row ahead
// of it, or the divergence is hidden.
const missingDivergences = (manifest.order as string[])
    .filter((arm) => arm !== reference(arm))
    .flatMap((arm) => {
        const sessions = new Map<string, TurnRecord[]>();
        for (const t of turns.filter((r) => r.arm === arm)) {
            sessions.set(t.session, [...(sessions.get(t.session) ?? []), t]);
        }
        return [...sessions.values()].flatMap((rows) => {
            const first = rows
                .sort((x, y) => x.index - y.index)
                .find((t) => {
                    const ref = turns.find((r) => r.arm === reference(arm) && r.event === t.event);
                    return ref !== undefined && ref.digest !== t.digest;
                });
            if (!first) return [];
            const cut = divergenceAt.get(`${arm}/${first.session}`);
            const row = records.find(
                (r) => r.kind === "divergedAt" && r.arm === arm && r.session === first.session,
            );
            const valid =
                cut !== undefined &&
                cut <= first.index &&
                row !== undefined &&
                !invalidDivergences.includes(`${arm} ${row.event}`);
            return valid ? [] : [`${arm} ${first.event}`];
        });
    });
// Every label is the one the seeded plan assigned; the plan's `task` may read `clarify` at a
// filler the agent ended with a question.
const scriptedTurns = scenario.events
    .filter((e) => e.kind === "user_turn")
    .map((e) => ({
        id: String(e.id),
        session: String(e.session),
        index: Number(e.index),
        role: String(e.role),
    }));
const plan = behaviourPlan(
    scriptedTurns,
    prereg,
    manifest.seed as number,
    pinnedTurns(
        scenario.events.map((e) => ({
            id: String(e.id),
            kind: String(e.kind),
            session: String(e.session),
            ...(typeof e.index === "number" ? { index: e.index } : {}),
        })),
        // The run pinned turns from its effective schedule: the manifest's override when set.
        (manifest.fault_override as typeof scenario.faults | null | undefined) ??
            scenario.faults ??
            [],
    ),
);
const planLabelMismatch = turns
    .filter((r) => {
        const planned = plan.skipped.has(r.event)
            ? "abandon"
            : (plan.labels.get(r.event) ?? "task");
        const clarify =
            planned === "task" && r.label === "clarify" && script.get(r.event)?.role === "filler";
        return r.label !== planned && !clarify;
    })
    .map((r) => `${r.arm} ${r.event}`);
// A clarify row stands where the agent's preceding reply ended with a question; the proxy
// record of that reply (its tail when cut) is the witness.
const callIndex = existsSync(join(dir, "calls.jsonl"))
    ? new CallIndex(join(dir, "calls.jsonl"))
    : null;
const began = new Map(
    journal
        .filter((e) => e.kind === "BeginTurn")
        .map((e) => [`${e.arm}/${e.event}`, Number(e.scenario_ms)]),
);
const unwitnessedClarify = turns
    .filter((r) => r.label === "clarify" && r.delivered)
    .filter((r) => {
        const at = began.get(`${r.arm}/${r.event}`);
        const before = (callIndex?.records(r.arm, r.session) ?? [])
            .filter((c) => c.component === "agent" && typeof c.response_text === "string")
            .filter((c) => at === undefined || c.scenario_ms < at);
        const last = before.at(-1);
        if (!last) return true;
        return !asksQuestion(last.response_tail ?? last.response_text ?? "");
    })
    .map((r) => `${r.arm} ${r.event}`);
const prefix = new Set(allScheduled.map((e) => e.id));
const outOfPrefix = [
    ...new Set([
        ...turns.filter((r) => !prefix.has(r.event)).map((r) => `${r.arm} ${r.event}`),
        ...journal
            .filter((e) => e.kind === "UserTurn" && !prefix.has(String(e.event)))
            .map((e) => `${e.arm} ${e.event}`),
    ]),
].sort();
// Each arm's summary must equal the rates recomputed from its delivered turns.
const ratesMismatch = (manifest.order as string[]).filter((arm) => {
    const journaled = journal.find((e) => e.kind === "UserSimRates" && e.arm === arm);
    if (!journaled) return false;
    const turns = deliveredTurns(journal, arm).map((e) => ({
        session: String(e.session),
        label: e.label as Label,
    }));
    const expected = realisedRates(turns, prereg);
    const summary = {
        turns: journaled.turns,
        sessions: journaled.sessions,
        rates: journaled.rates,
        outside: journaled.outside,
    };
    return JSON.stringify(summary) !== JSON.stringify(expected);
});
// A delivered turn's label must be one the plan can assign.
const invalidLabels = (manifest.order as string[]).flatMap((arm) =>
    deliveredTurns(journal, arm)
        .filter((e) => !LABELS.includes(e.label as Label))
        .map((e) => `${arm} ${e.event}`),
);
const scheduled = scenario.events
    .slice(0, manifest.events as number)
    .filter((e) => e.kind === "user_turn");
const recorded = new Set(turns.map((r) => `${r.arm} ${r.event}`));
// A row certifies its turn only at the compiled event's session and index, and only once.
const seenRows = new Set<string>();
const misplaced = turns
    .filter((r) => {
        const key = `${r.arm} ${r.event}`;
        const event = script.get(r.event);
        const dup = seenRows.has(key);
        seenRows.add(key);
        return dup || !event || event.session !== r.session || event.index !== r.index;
    })
    .map((r) => `${r.arm} ${r.event}`);
const report = {
    reference: Object.fromEntries(manifest.order.map((a: string) => [a, reference(a)])),
    mismatches_before_divergence: pairingMismatches(records, reference),
    divergences: records.filter((r) => r.kind === "divergedAt"),
    sources: Object.fromEntries(
        manifest.order.map((arm: string) => {
            const mine = turns.filter((r) => r.arm === arm);
            const by = (s: string) => mine.filter((r) => r.source === s).length;
            return [arm, { script: by("script"), tape: by("tape"), live: by("live") }];
        }),
    ),
    fallbacks: turns.filter((r) => r.fallback).map((r) => `${r.arm} ${r.event} ${r.fallback}`),
    probe_or_paste_text_altered: altered,
    non_filler_unsent: unsent,
    undelivered_turns: undeliveredTurns,
    source_label_mismatch: sourceLabelMismatch,
    live_before_divergence: liveBeforeDivergence,
    tape_missing: tapeMissing,
    missing_divergences: missingDivergences,
    plan_label_mismatch: planLabelMismatch,
    unwitnessed_clarify: unwitnessedClarify,
    unknown_arms: unknownArms,
    paste_provenance: provenance,
    script_text_altered: scriptAltered,
    out_of_prefix: outOfPrefix,
    rates: journal.filter((e) => e.kind === "UserSimRates"),
    flagged: journal
        .filter((e) => e.kind === "UserSimRates" && (e.outside as string[]).length > 0)
        .map((e) => `${e.arm}: ${(e.outside as string[]).join(", ")}`),
    rates_mismatch: ratesMismatch,
    invalid_labels: invalidLabels,
    missing_rates: (manifest.order as string[]).filter(
        (arm) => journal.filter((e) => e.kind === "UserSimRates" && e.arm === arm).length !== 1,
    ),
    misplaced_rows: [...new Set(misplaced)],
    missing_events: missingEvents,
    journal_pairing_mismatch: journalPairingMismatch,
    invalid_divergences: invalidDivergences,
    missing_turns: (manifest.order as string[]).flatMap((arm) =>
        scheduled.map((e) => `${arm} ${e.id}`).filter((key) => !recorded.has(key)),
    ),
    incomplete: [
        ...(manifest.order as string[])
            .filter((arm) => !journal.some((e) => e.kind === "EndArm" && e.arm === arm))
            .map((arm) => `${arm} EndArm`),
        ...(journal.some((e) => e.kind === "EndRun") ? [] : ["EndRun"]),
        ...incompleteRun,
    ],
    interrupted_turns: journal
        .filter((e) => e.kind === "Event" && e.outcome === "failed(interrupted)")
        .map((e) => `${e.arm} ${e.event}`)
        .filter((key) => recorded.has(key)),
};
console.log(JSON.stringify(report, null, 2));
const failed =
    report.mismatches_before_divergence.length +
    altered.length +
    unsent.length +
    undeliveredTurns.length +
    sourceLabelMismatch.length +
    liveBeforeDivergence.length +
    tapeMissing.length +
    missingDivergences.length +
    planLabelMismatch.length +
    unwitnessedClarify.length +
    unknownArms.length +
    provenance.length +
    scriptAltered.length +
    outOfPrefix.length +
    report.flagged.length +
    report.missing_rates.length +
    report.rates_mismatch.length +
    report.invalid_labels.length +
    report.missing_turns.length +
    report.misplaced_rows.length +
    report.missing_events.length +
    report.journal_pairing_mismatch.length +
    report.invalid_divergences.length +
    report.incomplete.length +
    report.interrupted_turns.length;
process.exit(failed > 0 ? 1 : 0);
