import { existsSync } from "node:fs";
import { readJsonl } from "../run/journal";
import type { ProbeItem } from "../scenario/compile";
import type { Command, CommandLog, Snapshot } from "./artefacts";
import { needsSourceCommands, type SourceEvent } from "./probes";

/** One run of an arm's tool ledger (`tools.jsonl`) with the turn it belongs to. */
export interface LedgerRun {
    turn: string | null;
    run: Command;
}

export function readToolLedger(path: string, label: string): LedgerRun[] {
    if (!existsSync(path)) throw new Error(`arm ${label} has no tools.jsonl`);
    const rows = readJsonl<Record<string, unknown>>(path);
    return rows.map((row, i) => {
        const { turn, command, exit, scenario_ms } = row;
        const exitOk = exit === null || Number.isInteger(exit);
        if (
            (turn !== null && typeof turn !== "string") ||
            typeof command !== "string" ||
            !exitOk ||
            typeof scenario_ms !== "number" ||
            !Number.isFinite(scenario_ms) ||
            scenario_ms < 0
        ) {
            throw new Error(`${label}/tools.jsonl line ${i + 1} is not a tool run`);
        }
        return {
            turn: turn as string | null,
            run: { command, exit: exit as number | null, scenario_ms },
        };
    });
}

/**
 * `withSourceCommands` adds the `source` command log the P12 grader reads when the probe's
 * sources commit a check script: the ledger's runs in user turns of a source turn's session,
 * from the first source turn up to the probe.
 */
export function withSourceCommands(
    snap: Snapshot,
    probe: ProbeItem,
    sources: SourceEvent[],
    events: readonly Record<string, unknown>[],
    ledger: () => LedgerRun[],
): Snapshot {
    if (!needsSourceCommands(probe, sources)) return snap;
    const eventOrder = new Map(events.map((e, i) => [String(e.id), i]));
    const turns = sources.filter((e) => e.kind === "user_turn");
    const from = Math.min(...turns.map((e) => eventOrder.get(e.id) ?? Infinity));
    const to = eventOrder.get(probe.event ?? "") ?? events.length;
    const sessions = new Set(turns.map((e) => e.session));
    const open = new Set(
        events
            .slice(from, to)
            .filter((e) => e.kind === "user_turn" && sessions.has(String(e.session)))
            .map((e) => String(e.id)),
    );
    const commands = ledger()
        .filter((x) => x.turn !== null && open.has(x.turn))
        .map((x) => x.run);
    const source: CommandLog = {
        id: `${snap.id}:source-commands`,
        class: "command-log",
        role: "source",
        commands,
    };
    return { ...snap, artefacts: [...snap.artefacts, source] };
}

export function sourceEvents(
    probe: ProbeItem,
    events: readonly Record<string, unknown>[],
): SourceEvent[] {
    const at = new Map(events.map((e, i) => [String(e.id), i]));
    return (probe.ground_truth?.sources ?? []).flatMap((id) => {
        const i = at.get(id);
        return i === undefined ? [] : [events[i] as unknown as SourceEvent];
    });
}
