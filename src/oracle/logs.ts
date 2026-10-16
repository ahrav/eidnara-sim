import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../grade/artefacts";
import type { StoreCheck } from "../hosts/storecheck";
import { ARMS, type Preregistration } from "../prereg/schema";
import { type CallRecord, recordProblems } from "../proxy/records";
import { type Entry, readJournal, requireComplete } from "../run/journal";
import type { Sample as ResourceSample } from "../run/sampler";
import { type Scenario, scenarioHash } from "../scenario/compile";

/** `pid` tells daemon lifetimes apart; a record without one is read as a single lifetime. */
export type Sample = Pick<ResourceSample, "scenario_ms" | "rss"> & { pid?: number | null };

export interface ArmLogs {
    arm: string;
    calls: CallRecord[];
    journal: Entry[];
    pluginLog: string[];
    daemonLog: string[];
    resources: Sample[];
    tools: (Command & { turn: string | null })[];
    /** The arm's store at the end of the run (`<arm>/store-check.json`), absent when unchecked. */
    finalStore?: StoreCheck;
}

export interface RunLogs {
    dir: string;
    tier: string;
    /** Wall time at scenario time 0; hosts and their plugins log in `base_wall_ms + scenario_ms`. */
    base_wall_ms: number;
    prereg: Preregistration;
    kinds: Map<string, string>;
    arms: ArmLogs[];
}

/** Evidence files are read strictly: every newline-terminated line must parse. A completed run's writers leave no cut tail. */
function jsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.flatMap((text, i) => {
        if (i === lines.length - 1) {
            if (text !== "") throw new Error(`${path}: line ${i + 1} is cut`);
            return [];
        }
        try {
            return [JSON.parse(text) as T];
        } catch {
            throw new Error(`${path}: line ${i + 1} is corrupt`);
        }
    });
}

type FieldCheck = (v: unknown) => boolean;
const num: FieldCheck = (v) => Number.isFinite(v);
const numOrNull: FieldCheck = (v) => v === null || Number.isFinite(v);
const str: FieldCheck = (v) => typeof v === "string";
const strOrNull: FieldCheck = (v) => v === null || typeof v === "string";
const SAMPLE_FIELDS: Record<string, FieldCheck> = { scenario_ms: num, rss: numOrNull };
const TOOL_FIELDS: Record<string, FieldCheck> = {
    turn: strOrNull,
    command: str,
    exit: numOrNull,
    scenario_ms: num,
};

/** Reads a JSONL evidence file whose records must carry the named fields with the named shapes. */
function shaped<T>(path: string, fields: Record<string, FieldCheck>): T[] {
    const rows = jsonl<Record<string, unknown>>(path);
    rows.forEach((row, i) => {
        for (const [field, ok] of Object.entries(fields)) {
            if (!ok(row[field])) throw new Error(`${path}: line ${i + 1}: ${field} missing`);
        }
        if ("pid" in row && !numOrNull(row.pid))
            throw new Error(`${path}: line ${i + 1}: pid missing`);
    });
    // SAFETY: every row carries each field in `fields` with its checked shape, which is the record type `T` names.
    return rows as unknown as T[];
}

const lines = (path: string) =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter((l) => l !== "")
        : [];

export function loadRun(dir: string, prereg: Preregistration): RunLogs {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const digest = scenarioHash(scenario);
    if (digest !== manifest.scenario_hash) {
        throw new Error(
            `scenario_hash ${digest} differs from the manifest's ${manifest.scenario_hash}`,
        );
    }
    const kinds = new Map(scenario.events.map((e) => [String(e.id), String(e.kind)]));
    const order = manifest.order as string[];
    for (const arm of order) {
        if (!(ARMS as readonly string[]).includes(arm)) {
            throw new Error(`manifest arm ${arm} is not a pre-registered arm`);
        }
    }
    const calls = jsonl<CallRecord>(join(dir, "calls.jsonl"));
    const seen = new Set<number>();
    for (const c of calls) {
        const problems = recordProblems({ ...c });
        if (problems.length > 0) throw new Error(`call ${c.seq}: ${problems.join(", ")}`);
        if (!order.includes(c.arm))
            throw new Error(`call ${c.seq}: arm ${c.arm} is not in the manifest`);
        if (seen.has(c.seq)) throw new Error(`call ${c.seq}: sequence number repeated`);
        seen.add(c.seq);
    }
    const journal = readJournal(join(dir, "journal.jsonl"));
    const scheduled = scenario.events.slice(0, manifest.events).map((e) => String(e.id));
    requireComplete(journal, order, scheduled);
    const arms = order.map((arm) => ({
        arm,
        calls: calls.filter((c) => c.arm === arm),
        journal: journal.filter((e) => e.arm === arm),
        pluginLog: lines(join(dir, arm, "r", "eidnara.log")),
        daemonLog: lines(join(dir, arm, "daemon.log")),
        resources: shaped<Sample>(join(dir, arm, "resources.jsonl"), SAMPLE_FIELDS),
        tools: shaped<Command & { turn: string | null }>(
            join(dir, arm, "tools.jsonl"),
            TOOL_FIELDS,
        ),
        finalStore: existsSync(join(dir, arm, "store-check.json"))
            ? (JSON.parse(readFileSync(join(dir, arm, "store-check.json"), "utf8")) as StoreCheck)
            : undefined,
    }));
    for (const arm of arms) {
        if (arm.arm === "host") continue;
        if (!arm.resources.some((s) => typeof s.rss === "number")) {
            throw new Error(
                `arm ${arm.arm} has no daemon RSS samples in ${arm.arm}/resources.jsonl`,
            );
        }
    }
    return { dir, tier: manifest.tier, base_wall_ms: manifest.base_wall_ms, prereg, kinds, arms };
}
