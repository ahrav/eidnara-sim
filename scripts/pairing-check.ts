import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJournal } from "../src/run/journal";
import { referenceArm } from "../src/run/run";
import type { Scenario } from "../src/scenario/compile";
import { type PairingRecord, pairingFailures, type TurnRecord } from "../src/usersim/usersim";

const dir = resolve(process.argv[2] ?? "");
if (!existsSync(join(dir, "pairing.jsonl"))) {
    console.error("usage: bun scripts/pairing-check.ts <run dir>");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
const records = readJournal(join(dir, "pairing.jsonl")) as unknown as PairingRecord[];
const reference = referenceArm(manifest.order);
const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
const failures = pairingFailures(records, scenario, reference);
const journal = readJournal(join(dir, "journal.jsonl"));
const report = {
    reference: Object.fromEntries(manifest.order.map((a: string) => [a, reference(a)])),
    mismatches_before_divergence: failures.mismatches_before_divergence,
    divergences: records.filter((r) => r.kind === "divergedAt"),
    sources: Object.fromEntries(
        manifest.order.map((arm: string) => {
            const mine = turns.filter((r) => r.arm === arm);
            const by = (s: string) => mine.filter((r) => r.source === s).length;
            return [arm, { script: by("script"), tape: by("tape"), live: by("live") }];
        }),
    ),
    fallbacks: turns.filter((r) => r.fallback).map((r) => `${r.arm} ${r.event} ${r.fallback}`),
    probe_or_paste_text_altered: failures.probe_or_paste_text_altered,
    non_filler_unsent: failures.non_filler_unsent,
    rates: journal.filter((e) => e.kind === "UserSimRates"),
    flagged: journal
        .filter((e) => e.kind === "UserSimRates" && (e.outside as string[]).length > 0)
        .map((e) => `${e.arm}: ${(e.outside as string[]).join(", ")}`),
};
console.log(JSON.stringify(report, null, 2));
const failed =
    report.mismatches_before_divergence.length +
    failures.probe_or_paste_text_altered.length +
    failures.non_filler_unsent.length +
    report.flagged.length;
process.exit(failed > 0 ? 1 : 0);
