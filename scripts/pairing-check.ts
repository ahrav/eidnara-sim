import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { readJournal } from "../src/run/journal";
import type { Scenario } from "../src/scenario/compile";
import { type PairingRecord, pairingMismatches, type TurnRecord } from "../src/usersim/usersim";

const dir = resolve(process.argv[2] ?? "");
if (!existsSync(join(dir, "pairing.jsonl"))) {
    console.error("usage: bun scripts/pairing-check.ts <run dir>");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
const records = readJournal(join(dir, "pairing.jsonl")) as unknown as PairingRecord[];
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
const unsent = turns
    .filter((r) => !r.delivered && script.get(r.event)?.role !== "filler")
    .map((r) => `${r.arm} ${r.event}`);
const journal = readJournal(join(dir, "journal.jsonl"));
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
    rates: journal.filter((e) => e.kind === "UserSimRates"),
    flagged: journal
        .filter((e) => e.kind === "UserSimRates" && (e.outside as string[]).length > 0)
        .map((e) => `${e.arm}: ${(e.outside as string[]).join(", ")}`),
    missing_rates: (manifest.order as string[]).filter(
        (arm) => journal.filter((e) => e.kind === "UserSimRates" && e.arm === arm).length !== 1,
    ),
};
console.log(JSON.stringify(report, null, 2));
const failed =
    report.mismatches_before_divergence.length +
    altered.length +
    unsent.length +
    report.flagged.length +
    report.missing_rates.length;
process.exit(failed > 0 ? 1 : 0);
