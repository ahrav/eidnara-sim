import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../grade/artefacts";
import { ARMS, type Preregistration } from "../prereg/schema";
import { type CallRecord, recordProblems } from "../proxy/records";
import { type Entry, readJournal, requireComplete } from "../run/journal";
import type { Sample as ResourceSample } from "../run/sampler";
import { type Scenario, scenarioHash } from "../scenario/compile";

/** `pid` tells daemon lifetimes apart; a record without one is read as a single lifetime. */
export type Sample = Pick<ResourceSample, "scenario_ms" | "rss"> & {
    pid?: number | null;
    start?: string | null;
};

export interface ArmLogs {
    arm: string;
    calls: CallRecord[];
    journal: Entry[];
    pluginLog: string[];
    daemonLog: string[];
    resources: Sample[];
    tools: (Command & { turn: string | null })[];
}

export interface RunLogs {
    dir: string;
    tier: string;
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
        if ("start" in row && !strOrNull(row.start)) {
            throw new Error(`${path}: line ${i + 1}: start missing`);
        }
    });
    // SAFETY: every row carries each field in `fields` with its checked shape, which is the record type `T` names.
    return rows as unknown as T[];
}

interface Manifest {
    order: string[];
    events: number;
    tier: string;
    scenario_hash?: string;
}

/** Reads one JSON file as the record type its reader names, naming the file when the text does not parse. */
function readJson<T>(path: string): T {
    const text = readFileSync(path, "utf8");
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`${path}: not valid JSON`);
    }
}

const lines = (path: string) =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter((l) => l !== "")
        : [];

/**
 * Every scheduled user turn has one `EndTurn` per arm, the record F1 and F4 read; the one
 * exception is a turn the resume path closed as `failed(interrupted)`, which has none.
 */
function requireTurnEnds(journal: Entry[], arms: string[], events: Scenario["events"]): void {
    const turns = new Set(events.filter((e) => e.kind === "user_turn").map((e) => String(e.id)));
    for (const arm of arms) {
        const mine = journal.filter((e) => e.arm === arm);
        for (const e of mine) {
            if ((e.kind === "EndTurn" || e.kind === "BeginTurn") && !turns.has(String(e.event))) {
                throw new Error(`arm ${arm}: ${e.kind} for unscheduled event ${String(e.event)}`);
            }
        }
        for (const id of turns) {
            const begins = mine.filter((e) => e.kind === "BeginTurn" && e.event === id).length;
            if (begins !== 1) {
                const what = begins === 0 ? "no BeginTurn" : `${begins} BeginTurn entries`;
                throw new Error(`arm ${arm}: turn ${id} has ${what}`);
            }
            const ends = mine.filter((e) => e.kind === "EndTurn" && e.event === id).length;
            const closed = mine.find((e) => e.kind === "Event" && e.event === id);
            if (ends === 0 && String(closed?.outcome) === "failed(interrupted)") continue;
            if (ends === 0) throw new Error(`arm ${arm}: turn ${id} has no EndTurn`);
            if (ends > 1) throw new Error(`arm ${arm}: turn ${id} has ${ends} EndTurn entries`);
        }
    }
}

/** Numeric RSS samples in one file name a pid on every row or on none; a null pid never carries a reading. */
function requirePidShape(path: string, samples: Sample[]): void {
    const numeric = samples.filter((s) => typeof s.rss === "number");
    const withPid = numeric.filter((s) => "pid" in s).length;
    if (withPid !== 0 && withPid !== numeric.length) {
        throw new Error(`${path}: pid present on some samples and absent on others`);
    }
    const withStart = numeric.filter((s) => "start" in s).length;
    if (withStart !== 0 && withStart !== numeric.length) {
        throw new Error(`${path}: start present on some samples and absent on others`);
    }
    samples.forEach((s, i) => {
        if (typeof s.rss === "number" && s.rss < 0) {
            throw new Error(`${path}: line ${i + 1}: rss negative`);
        }
        if (typeof s.rss === "number" && "pid" in s && s.pid === null) {
            throw new Error(`${path}: line ${i + 1}: numeric rss with a null pid`);
        }
        if (typeof s.pid === "number" && "start" in s && s.start === null) {
            throw new Error(`${path}: line ${i + 1}: pid with a null start`);
        }
    });
}

const TOKEN_FIELDS = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
] as const;

function samplesOf(path: string): Sample[] {
    const samples = shaped<Sample>(path, SAMPLE_FIELDS);
    requirePidShape(path, samples);
    return samples;
}

function toolsOf(path: string, turns: Set<string>): (Command & { turn: string | null })[] {
    const tools = shaped<Command & { turn: string | null }>(path, TOOL_FIELDS);
    tools.forEach((t, i) => {
        if (t.turn !== null && !turns.has(t.turn)) {
            throw new Error(`${path}: line ${i + 1}: turn ${t.turn} is not a scheduled user turn`);
        }
    });
    return tools;
}

export function loadRun(dir: string, prereg: Preregistration): RunLogs {
    const manifest = readJson<Manifest>(join(dir, "manifest.json"));
    const scenario = readJson<Scenario>(join(dir, "scenario.json"));
    const digest = scenarioHash(scenario);
    if (digest !== manifest.scenario_hash) {
        throw new Error(
            `scenario_hash ${digest} differs from the manifest's ${manifest.scenario_hash}`,
        );
    }
    const scenarioTier = (scenario as { manifest?: { tier?: string } }).manifest?.tier;
    if (scenarioTier !== undefined && scenarioTier !== manifest.tier) {
        throw new Error(
            `manifest tier ${manifest.tier} differs from the scenario's ${scenarioTier}`,
        );
    }
    const kinds = new Map(scenario.events.map((e) => [String(e.id), String(e.kind)]));
    const order = manifest.order as string[];
    if (order.length === 0) throw new Error("manifest names no arms");
    for (const arm of order) {
        if (!(ARMS as readonly string[]).includes(arm)) {
            throw new Error(`manifest arm ${arm} is not a pre-registered arm`);
        }
    }
    const count = manifest.events;
    if (!Number.isInteger(count) || count < 1 || count > scenario.events.length) {
        throw new Error(
            `manifest events ${count} exceeds the scenario's ${scenario.events.length}`,
        );
    }
    const planned = scenario.events.slice(0, count);
    const turns = new Set(planned.filter((e) => e.kind === "user_turn").map((e) => String(e.id)));
    const calls = jsonl<CallRecord>(join(dir, "calls.jsonl"));
    const seen = new Set<number>();
    calls.forEach((c, i) => {
        const problems = recordProblems({ ...c });
        if (problems.length > 0) throw new Error(`call ${c.seq}: ${problems.join(", ")}`);
        if (!order.includes(c.arm))
            throw new Error(`call ${c.seq}: arm ${c.arm} is not in the manifest`);
        if (seen.has(c.seq)) throw new Error(`call ${c.seq}: sequence number repeated`);
        if (c.seq !== i) throw new Error(`call ${c.seq}: expected sequence number ${i}`);
        seen.add(c.seq);
        if (c.wall_ms < c.started_wall_ms) {
            throw new Error(`call ${c.seq}: wall_ms precedes started_wall_ms`);
        }
        if (c.turn !== null && !turns.has(c.turn)) {
            throw new Error(`call ${c.seq}: turn ${c.turn} is not a scheduled user turn`);
        }
        for (const field of TOKEN_FIELDS) {
            if (c[field] < 0) throw new Error(`call ${c.seq}: ${field} negative`);
        }
        const http = Number.isInteger(c.status) && c.status >= 100 && c.status <= 599;
        if (c.status !== 0 && !http) {
            throw new Error(`call ${c.seq}: status ${c.status} is not an HTTP status`);
        }
    });
    const journalPath = join(dir, "journal.jsonl");
    const journal = readJournal(journalPath);
    const lastMs = new Map<string | null, number>();
    journal.forEach((e, i) => {
        const fields: Record<string, FieldCheck> = { kind: str, arm: strOrNull, scenario_ms: num };
        if (["BeginTurn", "EndTurn", "Event"].includes(String(e.kind))) fields.event = str;
        if (e.kind === "EndTurn") fields.outcome = str;
        for (const [field, ok] of Object.entries(fields)) {
            if (!ok(e[field])) throw new Error(`${journalPath}: line ${i + 1}: ${field} missing`);
        }
        const last = lastMs.get(e.arm);
        if (last !== undefined && e.scenario_ms < last) {
            throw new Error(
                `${journalPath}: line ${i + 1}: scenario_ms ${e.scenario_ms} precedes ${last}`,
            );
        }
        lastMs.set(e.arm, e.scenario_ms);
    });
    const scheduled = planned.map((e) => String(e.id));
    requireComplete(journal, order, scheduled);
    requireTurnEnds(journal, order, planned);
    const arms = order.map((arm) => ({
        arm,
        calls: calls.filter((c) => c.arm === arm),
        journal: journal.filter((e) => e.arm === arm),
        pluginLog: lines(join(dir, arm, "r", "eidnara.log")),
        daemonLog: lines(join(dir, arm, "daemon.log")),
        resources: samplesOf(join(dir, arm, "resources.jsonl")),
        tools: toolsOf(join(dir, arm, "tools.jsonl"), turns),
    }));
    for (const arm of arms) {
        if (arm.arm === "host") continue;
        if (!arm.resources.some((s) => typeof s.rss === "number")) {
            throw new Error(
                `arm ${arm.arm} has no daemon RSS samples in ${arm.arm}/resources.jsonl`,
            );
        }
        if (typeof arm.resources.at(-1)?.rss !== "number") {
            throw new Error(`arm ${arm.arm}: final RSS sample has no reading`);
        }
        if (!existsSync(join(dir, arm.arm, "daemon.log"))) {
            throw new Error(`arm ${arm.arm} has no daemon.log`);
        }
    }
    return { dir, tier: manifest.tier, prereg, kinds, arms };
}
