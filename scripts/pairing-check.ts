import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORPUS_DIR } from "../src/corpus/sources";
import { sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { readJournal } from "../src/run/journal";
import type { Scenario } from "../src/scenario/compile";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { deliveredTurns, LABELS, type Label, realisedRates } from "../src/usersim/plan";
import { pairingMismatches, readPairing, type TurnRecord } from "../src/usersim/usersim";

const dir = resolve(process.argv[2] ?? "");
if (!existsSync(join(dir, "pairing.jsonl"))) {
    console.error("usage: bun scripts/pairing-check.ts <run dir>");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const scenarioJson: unknown = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const scenario = scenarioJson as Scenario;
// The checker certifies against the scenario and pre-registration the manifest attests.
if (scenarioHash(scenarioJson as Record<string, unknown>) !== manifest.scenario_hash) {
    console.error(`scenario.json does not match the manifest's scenario hash`);
    process.exit(2);
}
const records = readPairing(join(dir, "pairing.jsonl"));
const first = manifest.order[0] as string;
const reference = () => first;
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
const corpus = new Map(
    readFileSync(join(CORPUS_DIR, "tool-outputs/samples.jsonl"), "utf8")
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
const unsent = turns
    .filter((r) => !r.delivered && script.get(r.event)?.role !== "filler")
    .map((r) => `${r.arm} ${r.event}`);
const journal = readJournal(join(dir, "journal.jsonl"));
const prereg = loadPrereg(manifest.tier);
if (preregistrationHash(prereg) !== manifest.prereg_sha256) {
    console.error(`the ${manifest.tier} pre-registration differs from the manifest's`);
    process.exit(2);
}
// A divergence row is a cutoff only at its compiled event, for a known arm, with digests that
// differ.
const arms = new Set(manifest.order as string[]);
const invalidDivergences = records
    .filter((r) => r.kind === "divergedAt")
    .filter((r) => {
        const event = script.get(r.event);
        const differs =
            r.against === "recorded"
                ? r.recorded_context_sha256 !== undefined &&
                  r.recorded_context_sha256 !== r.context_sha256
                : r.digest !== r.reference_digest;
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
    const paired = new Set(turns.filter((r) => r.arm === arm).map((r) => r.event));
    const off = new Set<string>();
    for (const event of paired) if (counts.get(event) !== 1) off.add(event);
    for (const event of counts.keys()) if (!paired.has(event)) off.add(event);
    return [...off].sort().map((event) => `${arm} ${event}`);
});
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
    reference: first,
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
    paste_provenance: provenance,
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
    provenance.length +
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
