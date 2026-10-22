import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../grade/artefacts";
import { armBase, requireOrder } from "../hosts/arms";
import { runsEidnara } from "../hosts/profiles";
import { parseStoreCheck, type StoreCheck } from "../hosts/storecheck";
import { ARMS, type Preregistration, type Tier } from "../prereg/schema";
import { type CallRecord, recordProblems } from "../proxy/records";
import { type Entry, requireAppendable, requireComplete } from "../run/journal";
import type { PriceTable } from "../run/price";
import type { Sample as ResourceSample } from "../run/sampler";
import { type Scenario, scenarioHash } from "../scenario/compile";
import { admittedArms } from "../scenario/inputs";

/** `pid` tells daemon lifetimes apart; a record without one is read as a single lifetime. */
export type Sample = Pick<ResourceSample, "scenario_ms" | "rss"> & Partial<ResourceSample>;

export interface ArmLogs {
    arm: string;
    calls: CallRecord[];
    journal: Entry[];
    pluginLog: string[];
    /** Set when `<arm>/r/eidnara.log` is absent, so an empty log reads as missing evidence. */
    pluginLogMissing?: true;
    daemonLog: string[];
    resources: Sample[];
    tools: (Command & { turn: string | null })[];
    /** The arm's store at the end of the run (`<arm>/store-check.json`), absent when unchecked. */
    finalStore?: StoreCheck;
    /** Host compaction as the manifest's arm profile recorded it; absent on runs from before the record. */
    hostCompaction?: boolean;
}

export interface RunLogs {
    dir: string;
    tier: string;
    /**
     * Wall time at scenario time 0, from the manifest; hosts and their plugins log in
     * `base_wall_ms + scenario_ms`, and a journal without clock offsets places plugin log stamps
     * that way.
     */
    base_wall_ms: number;
    prereg: Preregistration;
    kinds: Map<string, string>;
    /** Each scheduled laptop sleep's duration by fault id, from the override the run used or its scenario. */
    sleeps?: Map<string, number>;
    /** Each scheduled fault's type by id, from the same source, so a journaled fault must match its schedule. */
    faultTypes?: Map<string, string>;
    arms: ArmLogs[];
    /** The price table the manifest recorded; `null` for a run that recorded none. */
    price: PriceTable | null;
    /** The last `seq` in the run's journal, every arm included; a grading summary names the one it saw. */
    journal_seq: number;
}

/**
 * Evidence files are read strictly: every newline-terminated line must parse, and a completed
 * run's writers leave no cut tail. The file is read in 1 MiB chunks and each line parsed as it
 * completes, so a large `calls.jsonl` costs its parsed records, never a whole-file string.
 */
function jsonl<T>(path: string): T[] {
    requireAppendable(path);
    if (!existsSync(path)) return [];
    const out: T[] = [];
    const fd = openSync(path, "r");
    const chunk = new Uint8Array(1 << 20);
    const decoder = new TextDecoder();
    let rest = "";
    let lineNo = 0;
    const take = (text: string) => {
        lineNo += 1;
        try {
            out.push(JSON.parse(text) as T);
        } catch {
            throw new Error(`${path}: line ${lineNo} is corrupt`);
        }
    };
    try {
        for (;;) {
            const n = readSync(fd, chunk, 0, chunk.length, null);
            if (n === 0) break;
            rest += decoder.decode(chunk.subarray(0, n), { stream: true });
            let cut = rest.indexOf("\n");
            while (cut !== -1) {
                take(rest.slice(0, cut));
                rest = rest.slice(cut + 1);
                cut = rest.indexOf("\n");
            }
        }
        rest += decoder.decode();
        if (rest !== "") throw new Error(`${path}: line ${lineNo + 1} is cut`);
    } finally {
        closeSync(fd);
    }
    return out;
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
        const pidOk =
            row.pid === null || (Number.isSafeInteger(row.pid) && (row.pid as number) > 0);
        if ("pid" in row && !pidOk) throw new Error(`${path}: line ${i + 1}: pid missing`);
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
    tier: Tier;
    base_wall_ms: number;
    scenario_hash?: string;
    qualification?: { id: string; sha256: string } | null;
    fault_override?: { id: string; type: string; params?: { duration_ms?: number } }[] | null;
    price_table?: unknown;
}

/** The manifest's price table: `null` when the run recorded none, refused when malformed. */
function priceOf(table: unknown, path: string): PriceTable | null {
    if (table === undefined) return null;
    const t = table as Partial<PriceTable> | null;
    const rates = t?.rates as Record<string, unknown> | undefined;
    const ok =
        typeof t?.version === "string" &&
        t.version !== "" &&
        typeof rates === "object" &&
        rates !== null &&
        ["input", "output", "cache_read", "cache_write"].every(
            (k) => typeof rates[k] === "number" && Number.isFinite(rates[k]) && rates[k] >= 0,
        );
    if (!ok) throw new Error(`${path}: price_table is not a versioned table of non-negative rates`);
    return t as PriceTable;
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
    const rank: Record<string, number> = { BeginTurn: 0, EndTurn: 1, Event: 2 };
    for (const arm of arms) {
        const markers = new Map<
            string,
            { kinds: string[]; begins: number; ends: number; ended?: Entry; closed?: Entry }
        >();
        for (const e of journal) {
            if (e.arm !== arm || !(String(e.kind) in rank)) continue;
            const id = String(e.event);
            if ((e.kind === "EndTurn" || e.kind === "BeginTurn") && !turns.has(id)) {
                throw new Error(`arm ${arm}: ${e.kind} for unscheduled event ${id}`);
            }
            const m = markers.get(id) ?? { kinds: [], begins: 0, ends: 0 };
            m.kinds.push(String(e.kind));
            if (e.kind === "BeginTurn") m.begins += 1;
            if (e.kind === "EndTurn") {
                m.ends += 1;
                m.ended = e;
            }
            if (e.kind === "Event") m.closed = e;
            markers.set(id, m);
        }
        for (const id of turns) {
            const m = markers.get(id) ?? { kinds: [], begins: 0, ends: 0 };
            const sorted = m.kinds.every(
                (k, i) => i === 0 || (rank[k] ?? 9) >= (rank[m.kinds[i - 1] ?? ""] ?? 9),
            );
            if (!sorted) throw new Error(`arm ${arm}: turn ${id} markers out of order`);
            if (m.begins !== 1) {
                const what = m.begins === 0 ? "no BeginTurn" : `${m.begins} BeginTurn entries`;
                throw new Error(`arm ${arm}: turn ${id} has ${what}`);
            }
            if (m.ends === 0 && String(m.closed?.outcome) === "failed(interrupted)") continue;
            if (m.ends === 0) throw new Error(`arm ${arm}: turn ${id} has no EndTurn`);
            if (m.ends > 1) throw new Error(`arm ${arm}: turn ${id} has ${m.ends} EndTurn entries`);
            // A turn's Event records its delivery (`ok`) or repeats the turn's own outcome; an Event
            // recording a failure the EndTurn lacks, an interruption included, contradicts it.
            const delivered = String(m.closed?.outcome ?? "ok");
            if (m.ended && delivered !== "ok" && delivered !== String(m.ended.outcome)) {
                throw new Error(
                    `arm ${arm}: turn ${id} ended ${String(m.ended.outcome)} but its Event records ${delivered}`,
                );
            }
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
        if (typeof s.rss === "number" && !Number.isSafeInteger(s.rss)) {
            throw new Error(`${path}: line ${i + 1}: rss is not a byte count`);
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
    const closed = new Set<string>();
    samples.forEach((s, i) => {
        const prev = samples[i - 1];
        const opens = !prev || prev.pid !== s.pid || prev.start !== s.start;
        if (opens && s.pid !== null && typeof s.rss !== "number") {
            throw new Error(`${path}: line ${i + 1}: lifetime opens without a reading`);
        }
        if (opens && prev && prev.pid !== null) closed.add(`${prev.pid}/${prev.start}`);
        if (opens && s.pid !== null && closed.has(`${s.pid}/${s.start}`)) {
            throw new Error(
                `${path}: line ${i + 1}: process ${s.pid}/${s.start} returns after a later lifetime`,
            );
        }
    });
    samples.forEach((s, i) => {
        if (!Number.isSafeInteger(s.scenario_ms) || s.scenario_ms < 0) {
            throw new Error(`${path}: line ${i + 1}: scenario_ms is not a count`);
        }
        if (typeof s.start === "string" && !/^(0|[1-9]\d*)$/.test(s.start)) {
            throw new Error(`${path}: line ${i + 1}: start is not a clock tick`);
        }
        if ("start" in s && !("pid" in s)) {
            throw new Error(`${path}: line ${i + 1}: start without a pid`);
        }
        const prev = samples[i - 1];
        if (prev && s.scenario_ms < prev.scenario_ms) {
            throw new Error(
                `${path}: line ${i + 1}: scenario_ms ${s.scenario_ms} precedes ${prev.scenario_ms}`,
            );
        }
    });
    return samples;
}

type Bounds = Map<string, { from: number; to: number }>;

/** Each turn's journaled interval per arm: `BeginTurn` to `EndTurn`, open-ended where one is absent. */
function turnBounds(journal: Entry[]): Bounds {
    const bounds: Bounds = new Map();
    for (const e of journal) {
        if (e.kind !== "BeginTurn" && e.kind !== "EndTurn") continue;
        const key = `${e.arm}/${String(e.event)}`;
        const b = bounds.get(key) ?? {
            from: Number.NEGATIVE_INFINITY,
            to: Number.POSITIVE_INFINITY,
        };
        if (e.kind === "BeginTurn") b.from = e.scenario_ms;
        else b.to = e.scenario_ms;
        bounds.set(key, b);
    }
    return bounds;
}

/**
 * Every call started before its arm's `EndArm` (the driver stops the host first, so no call
 * begins after it), and a call attributed to a turn started while that turn was open: between
 * its `BeginTurn` and its `EndTurn`.
 */
function requireCallsInTurns(
    calls: CallRecord[],
    bounds: Bounds,
    armEnds: Map<string, number>,
): void {
    for (const c of calls) {
        const b = c.turn === null ? undefined : bounds.get(`${c.arm}/${c.turn}`);
        if (b && (c.scenario_ms < b.from || c.scenario_ms > b.to)) {
            throw new Error(
                `call ${c.seq}: starts at ${c.scenario_ms}, outside turn ${c.turn} (${b.from} to ${b.to})`,
            );
        }
        const end = armEnds.get(c.arm);
        if (end !== undefined && c.scenario_ms > end) {
            throw new Error(
                `call ${c.seq}: starts at ${c.scenario_ms}, after arm ${c.arm} ended at ${end}`,
            );
        }
    }
}

/** A tool start lands on the host's clock up to this much after the turn's journaled end. */
const TOOL_SLACK_MS = 1_000;

function toolsOf(
    path: string,
    turns: Set<string>,
    bounds: Bounds,
    arm: string,
): (Command & { turn: string | null })[] {
    const tools = shaped<Command & { turn: string | null }>(path, TOOL_FIELDS);
    tools.forEach((t, i) => {
        if (t.turn === null) return;
        if (!turns.has(t.turn)) {
            throw new Error(`${path}: line ${i + 1}: turn ${t.turn} is not a scheduled user turn`);
        }
        const b = bounds.get(`${arm}/${t.turn}`);
        const early = b !== undefined && t.scenario_ms < b.from;
        const late = b !== undefined && t.scenario_ms > b.to + TOOL_SLACK_MS;
        if (b && (early || late)) {
            throw new Error(
                `${path}: line ${i + 1}: starts at ${t.scenario_ms}, outside turn ${t.turn} (${b.from} to ${b.to})`,
            );
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
    const admitted = admittedArms(manifest, scenario as { manifest?: Record<string, unknown> });
    requireOrder(order, [...ARMS, ...admitted.run], admitted.pairs);
    for (const arm of order) {
        if (!admitted.run.includes(armBase(arm))) {
            const run = manifest.qualification
                ? `qualification ${manifest.qualification.id}'s`
                : `tier ${prereg.tier}'s`;
            throw new Error(`manifest arm ${arm} is not in ${run} run`);
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
    if (!existsSync(join(dir, "calls.jsonl"))) throw new Error("run has no calls.jsonl");
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
        for (const field of ["started_wall_ms", "wall_ms"] as const) {
            if (!Number.isSafeInteger(c[field]) || c[field] < 0) {
                throw new Error(`call ${c.seq}: ${field} is not a timestamp`);
            }
        }
        if (!Number.isSafeInteger(c.scenario_ms) || c.scenario_ms < 0) {
            throw new Error(`call ${c.seq}: scenario_ms is not a clock reading`);
        }
        if (c.wall_ms < c.started_wall_ms) {
            throw new Error(`call ${c.seq}: wall_ms precedes started_wall_ms`);
        }
        if (c.turn !== null && !turns.has(c.turn)) {
            throw new Error(`call ${c.seq}: turn ${c.turn} is not a scheduled user turn`);
        }
        for (const field of TOKEN_FIELDS) {
            if (c[field] < 0) throw new Error(`call ${c.seq}: ${field} negative`);
            if (!Number.isSafeInteger(c[field])) {
                throw new Error(`call ${c.seq}: ${field} is not a count`);
            }
        }
        if ("response_text" in c && typeof c.response_text !== "string") {
            throw new Error(`call ${c.seq}: response_text is not a string`);
        }
        if ("response_text_truncated" in c && c.response_text_truncated !== true) {
            throw new Error(`call ${c.seq}: response_text_truncated is not true`);
        }
        if ("response_text_truncated" in c && typeof c.response_text !== "string") {
            throw new Error(`call ${c.seq}: response_text_truncated without response_text`);
        }
        const http = Number.isInteger(c.status) && c.status >= 100 && c.status <= 599;
        if (c.status !== 0 && !http) {
            throw new Error(`call ${c.seq}: status ${c.status} is not an HTTP status`);
        }
    });
    const journalPath = join(dir, "journal.jsonl");
    const journal = jsonl<Entry>(journalPath);
    const lastMs = new Map<string | null, number>();
    journal.forEach((e, i) => {
        const fields: Record<string, FieldCheck> = {
            kind: str,
            arm: strOrNull,
            scenario_ms: num,
            wall_ms: num,
        };
        if (["BeginTurn", "EndTurn", "Event"].includes(String(e.kind))) fields.event = str;
        if (e.kind === "EndTurn") fields.outcome = str;
        for (const [field, ok] of Object.entries(fields)) {
            if (!ok(e[field])) throw new Error(`${journalPath}: line ${i + 1}: ${field} missing`);
        }
        // A journal the harness wrote numbers each entry by its line; the oracles order by it.
        if (e.seq !== undefined && e.seq !== i) {
            throw new Error(`${journalPath}: line ${i + 1}: seq ${String(e.seq)} is not ${i}`);
        }
        if (!Number.isSafeInteger(e.scenario_ms) || e.scenario_ms < 0) {
            throw new Error(`${journalPath}: line ${i + 1}: scenario_ms is not a count`);
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
    const bounds = turnBounds(journal);
    const armEnds = new Map<string, number>();
    for (const e of journal) {
        if (e.kind === "EndArm" && typeof e.arm === "string" && !armEnds.has(e.arm)) {
            armEnds.set(e.arm, e.scenario_ms);
        }
    }
    requireCallsInTurns(calls, bounds, armEnds);
    const recorded = (
        manifest as { arms?: Record<string, { profile?: { host_compaction?: unknown } }> }
    ).arms;
    const arms = order.map((arm) => ({
        arm,
        ...(typeof recorded?.[arm]?.profile?.host_compaction === "boolean"
            ? { hostCompaction: recorded[arm]?.profile?.host_compaction as boolean }
            : {}),
        calls: calls.filter((c) => c.arm === arm),
        journal: journal.filter((e) => e.arm === arm),
        pluginLog: lines(join(dir, arm, "r", "eidnara.log")),
        ...(existsSync(join(dir, arm, "r", "eidnara.log"))
            ? {}
            : { pluginLogMissing: true as const }),
        daemonLog: lines(join(dir, arm, "daemon.log")),
        resources: samplesOf(join(dir, arm, "resources.jsonl")),
        tools: toolsOf(join(dir, arm, "tools.jsonl"), turns, bounds, arm),
        finalStore: existsSync(join(dir, arm, "store-check.json"))
            ? parseStoreCheck(
                  readJson<unknown>(join(dir, arm, "store-check.json")),
                  `${arm}/store-check.json`,
              )
            : undefined,
    }));
    for (const arm of arms) {
        if (!existsSync(join(dir, arm.arm, "tools.jsonl"))) {
            throw new Error(`arm ${arm.arm} has no tools.jsonl`);
        }
        if (!runsEidnara(arm.arm)) continue;
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
        if (!existsSync(join(dir, arm.arm, "r", "eidnara.log"))) {
            throw new Error(`arm ${arm.arm} has no r/eidnara.log`);
        }
    }
    const faults = manifest.fault_override ?? scenario.faults ?? [];
    const sleeps = new Map(
        faults
            .filter((f) => f.type === "laptop_sleep")
            .map((f) => [String(f.id), Number(f.params?.duration_ms)]),
    );
    const faultTypes = new Map(faults.map((f) => [String(f.id), String(f.type)]));
    return {
        dir,
        tier: manifest.tier,
        base_wall_ms: manifest.base_wall_ms,
        prereg,
        kinds,
        sleeps,
        faultTypes,
        arms,
        price: priceOf(manifest.price_table, join(dir, "manifest.json")),
        journal_seq: journal.at(-1)?.seq ?? 0,
    };
}
