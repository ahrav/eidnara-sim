import {
    appendFileSync,
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type SimConfig } from "../src/config/config";
import {
    AnswerRefused,
    assertArtefactsOnly,
    type CallView,
    type Command,
    type CommandLog,
    EvidenceRefused,
    GradeRefused,
    type Snapshot,
} from "../src/grade/artefacts";
import {
    BlindingRefused,
    gradeP7,
    type Judgment,
    judgePair,
    type P7Inputs,
    p7Pair,
    proxyJudge,
} from "../src/grade/judge";
import {
    deltaMem,
    GradeLog,
    type GradeRecord,
    gradeItem,
    graderDigest,
    needsSourceCommands,
    RECORDED_TYPES,
    requireEvidence,
    type SourceEvent,
    verdictCounts,
} from "../src/grade/probes";
import { armBase, requireSeedOrder } from "../src/hosts/arms";
import { canonicalJson } from "../src/prereg/canonical";
import { qualificationSeed } from "../src/prereg/qualification";
import { preregistrationHash } from "../src/prereg/validate";
import { bedrockUpstream, Gateway } from "../src/proxy/gateway";
import { FaultInjector } from "../src/proxy/inject";
import type { CallRecord } from "../src/proxy/records";
import { RecordWriter } from "../src/proxy/records";
import { Rng } from "../src/rng";
import { writeAtomic } from "../src/run/atomic";
import {
    type Entry,
    keepCompleteLines,
    readJsonl,
    releaseLease,
    requireAppendable,
    requireComplete,
    takeLease,
} from "../src/run/journal";
import { CallIndex, callsOf, simIdentity } from "../src/run/run";
import { type Scenario, scenarioHash } from "../src/scenario/compile";
import { admittedArms, loadPrereg, loadQualification } from "../src/scenario/inputs";

export interface Summary {
    /** Verdict counts over the run's current grades, the ones kept from earlier passes included. */
    verdicts: Record<string, Record<string, number>>;
    /** The number of grades this pass appended. */
    graded: number;
    /** Skipped item counts by arm, then by reason. */
    skipped: Record<string, Record<string, number>>;
    /** Each grade version maps to the number of aggregated grades carrying it. */
    versions: Record<string, number>;
    p11: Record<string, { n: number; weighted_score: number }>;
    p3: { arm: string; delta_mem: { delta: number; n: number } | null }[];
    judge_errors: number;
    /** The last `seq` of the journal this pass graded, so a later resume marks the summary stale. */
    journal_seq: number;
    /** The grader implementation (`graderDigest`) and the eidnara-sim revision this pass ran. */
    grader: { digest: string; sim_commit: string; sim_worktree: string };
}

/** Where a finished grading pass records its summary; `src/report/cost.ts` reads it. */
const summaryPath = (dir: string) => join(dir, "grade-summary.json");

/**
 * `gradeRun` holds the run directory's lease while it grades, which serializes grade-version
 * allocation across invocations, and requires the pre-registration and scenario to hash to
 * the digests recorded in the manifest. A grade already on the log for an item, arm, opponent,
 * and snapshot, made by this grader (`graderDigest`), stands and its item is skipped as `already
 * graded`; `regrade` grades every item anew as a further version.
 */
export async function gradeRun(
    dir: string,
    config: SimConfig | null,
    regrade = false,
): Promise<Summary> {
    const lease = takeLease(dir);
    try {
        // A refused run keeps the summary of the grades it has.
        requireCheckedSchema(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).schema);
        requireGradableTypes(JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")));
        // A pass that stops early leaves no summary, so a reader never takes a stale one as current.
        rmSync(summaryPath(dir), { force: true });
        const summary = await grade(dir, config, regrade);
        writeAtomic(summaryPath(dir), `${JSON.stringify(summary, null, 2)}\n`);
        return summary;
    } finally {
        releaseLease(dir, lease);
    }
}

/** One JSONL record and where its bytes lie, so a row can be read back on its own later. */
interface Placed {
    text: string;
    offset: number;
    length: number;
}

/**
 * Yields a JSONL file's non-empty records one at a time with their byte positions, so a log of
 * large records costs one record of memory. The file must be a regular file or absent.
 */
async function* jsonlRecords(path: string): AsyncGenerator<Placed> {
    requireAppendable(path);
    const pending: Buffer[] = [];
    let offset = 0;
    let lineStart = 0;
    for await (const chunk of Bun.file(path).stream()) {
        let buf = Buffer.from(chunk);
        let at = buf.indexOf(0x0a);
        while (at !== -1) {
            const line = Buffer.concat([...pending, buf.subarray(0, at)]);
            pending.length = 0;
            const end = offset + at + 1;
            if (line.length > 0) {
                yield { text: line.toString("utf8"), offset: lineStart, length: end - lineStart };
            }
            lineStart = end;
            offset = end;
            buf = buf.subarray(at + 1);
            at = buf.indexOf(0x0a);
        }
        if (buf.length > 0) {
            pending.push(Buffer.from(buf));
            offset += buf.length;
        }
    }
    const rest = Buffer.concat(pending);
    if (rest.length > 0) {
        yield { text: rest.toString("utf8"), offset: lineStart, length: offset - lineStart };
    }
}

async function* jsonlLines(path: string): AsyncGenerator<string> {
    for await (const record of jsonlRecords(path)) yield record.text;
}

/** Reads one placed record back from its file. */
function readPlaced(path: string, offset: number, length: number): string {
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, offset);
        return buf.toString("utf8").trimEnd();
    } finally {
        closeSync(fd);
    }
}

/** What grading keeps of a snapshot row between passes: its identity and where to read it back. */
interface RowMeta {
    id: string;
    item: string;
    arm: string;
    session: string | null;
    turn: string;
    turn_outcome: Snapshot["turn_outcome"];
    journaled: boolean;
    path: string;
    offset: number;
    length: number;
}

/** A run from before the arm capability check keeps the grades it has. */
function requireCheckedSchema(schema: unknown): void {
    if (schema !== "sim-run-manifest/v3") {
        throw new Error(
            `manifest schema ${String(schema)} predates the arm capability check; its grades stand as they were`,
        );
    }
}

/**
 * Grades come only from runs whose arms ran what they declare: a `sim-run-manifest/v3` run, whose
 * every ended arm holds the `capabilities.json` its `EndArm` check wrote with no mismatch. Runs
 * from before the check stay as they were graded.
 */
export function requireCapabilities(
    dir: string,
    manifest: { schema?: unknown; arms?: Record<string, { profile?: unknown }> },
    arms: readonly string[],
    entries: readonly Entry[],
): void {
    requireCheckedSchema(manifest.schema);
    for (const arm of arms) {
        if (!entries.some((e) => e.kind === "EndArm" && e.arm === arm)) continue;
        const path = join(dir, arm, "capabilities.json");
        let record: { mismatches?: unknown; profile?: unknown; observed?: { arm?: unknown } };
        try {
            record = JSON.parse(readFileSync(path, "utf8"));
        } catch (caught) {
            throw new Error(
                `arm ${arm} ended with no readable ${path}: ${(caught as Error).message}`,
            );
        }
        // The record must be this arm's own, under the profile the manifest pinned for it.
        const profile = manifest.arms?.[arm]?.profile;
        if (
            record.observed?.arm !== arm ||
            profile === undefined ||
            canonicalJson(record.profile) !== canonicalJson(profile)
        ) {
            throw new Error(
                `${path} is not the capability record of arm ${arm} as the manifest pins it`,
            );
        }
        const mismatches = record.mismatches;
        if (!Array.isArray(mismatches) || mismatches.length > 0) {
            throw new Error(
                `arm ${arm} ran other capabilities than it declares: ${JSON.stringify(mismatches)}`,
            );
        }
    }
}

/** A scenario that compiles a recorded type is graded by the sim commit that recorded it. */
function requireGradableTypes(scenario: Scenario): void {
    const recorded = scenario.probes.find((p) => RECORDED_TYPES.includes(p.type));
    if (recorded) {
        throw new Error(
            `scenario.json compiles ${recorded.type} items, a type this grader reads from logs only; grade the run with the sim commit that recorded it`,
        );
    }
}

async function grade(dir: string, config: SimConfig | null, regrade: boolean): Promise<Summary> {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const digests = {
        prereg_sha256: preregistrationHash(loadPrereg(manifest.tier)),
        scenario_hash: scenarioHash(scenario),
    };
    const changed = Object.entries(digests).filter(([k, v]) => manifest[k] !== v);
    if (changed.length > 0) {
        const names = changed.map(([k]) => k).join(", ");
        throw new Error(`inputs differ from the run's manifest: ${names}`);
    }
    const identity = scenario.manifest as { seed?: unknown; tier?: unknown };
    if (identity.seed !== manifest.seed || identity.tier !== manifest.tier) {
        throw new Error(
            `scenario.json is ${String(identity.tier)} seed ${String(identity.seed)}, not the manifest's ${String(manifest.tier)} seed ${String(manifest.seed)}`,
        );
    }
    const prereg = loadPrereg(manifest.tier);
    const rules = prereg.grading;
    const arms = manifest.order as string[];
    // A qualification run's arms come from the registration it recorded, which must still hash
    // to the recorded digest.
    const admitted = admittedArms(manifest, scenario as { manifest?: Record<string, unknown> });
    const name = manifest.qualification
        ? `qualification ${String(manifest.qualification.id)}`
        : String(manifest.tier);
    const seedIndex = prereg.seeds.indexOf(manifest.seed);
    const permitted = manifest.qualification
        ? qualificationSeed(loadQualification(manifest.qualification.id), manifest.seed)?.order
        : seedIndex < 0
          ? undefined
          : (prereg.arms.order_by_seed[seedIndex] ?? prereg.arms.run);
    if (!permitted) {
        throw new Error(`seed ${String(manifest.seed)} is not pre-registered for ${name}`);
    }
    requireSeedOrder(arms, permitted, admitted.pairs);
    const models = manifest.models as unknown;
    if (
        !Array.isArray(models) ||
        models.length === 0 ||
        !models.every((m) => typeof m === "string")
    ) {
        throw new Error("manifest records no model list");
    }
    const entries = readJsonl<Entry>(join(dir, "journal.jsonl"));
    const events = manifest.events as unknown;
    if (
        !Number.isSafeInteger(events) ||
        (events as number) < 1 ||
        (events as number) > scenario.events.length
    ) {
        throw new Error(
            `manifest schedules ${String(events)} events; the scenario compiles ${scenario.events.length}`,
        );
    }
    const scheduled = scenario.events.slice(0, manifest.events).map((e) => String(e.id));
    requireComplete(entries, arms, scheduled);
    requireCapabilities(dir, manifest, arms, entries);
    const log = new GradeLog(join(dir, "grades.jsonl"));

    const named = new Map<string, { arm: string; item: string }>();
    const firstOf = new Set<string>();
    for (const e of entries.filter((e) => e.kind === "SnapshotArtefacts")) {
        const id = String(e.snapshot);
        const key = `${String(e.arm)}/${String(e.item)}`;
        if (named.has(id) || firstOf.has(key)) {
            throw new Error(`journal names more than one first snapshot for ${key} (${id})`);
        }
        named.set(id, { arm: String(e.arm), item: String(e.item) });
        firstOf.add(key);
    }
    const journaled = new Set(named.keys());
    const turnEnds = new Map<
        string,
        { outcome: string; arm: string; probe: string; event: string }
    >();
    const probeTurns = new Map<string, Array<{ outcome: string; snapshot: string | null }>>();
    for (const e of entries.filter((e) => e.kind === "EndTurn")) {
        if (typeof e.snapshot === "string") {
            turnEnds.set(e.snapshot, {
                outcome: String(e.outcome),
                arm: String(e.arm),
                probe: String(e.probe),
                event: String(e.event),
            });
        }
        if (typeof e.probe !== "string") continue;
        const key = `${String(e.arm)}/${e.probe}`;
        const snapshot = typeof e.snapshot === "string" ? e.snapshot : null;
        probeTurns.set(key, [
            ...(probeTurns.get(key) ?? []),
            { outcome: String(e.outcome), snapshot },
        ]);
    }
    /**
     * Why an arm has no journaled snapshot for an item: a turn that ended `failed` with no
     * snapshot is a failed capture; a turn that ended `ok`, or named a snapshot the journal
     * never entered, makes the journal invalid; no ended turn at all is an interrupted or
     * absent turn.
     */
    const eventOutcomes = new Map<string, string>();
    for (const e of entries.filter((e) => e.kind === "Event")) {
        eventOutcomes.set(`${String(e.arm)}/${String(e.event)}`, String(e.outcome));
    }
    const unjournaled = (arm: string, item: string, event: string | undefined): string => {
        const turns = probeTurns.get(`${arm}/${item}`) ?? [];
        const named = turns.find((t) => t.snapshot !== null);
        if (named) {
            throw new Error(
                `the journal ends a turn for ${item} (${arm}) naming snapshot ${named.snapshot} but has no SnapshotArtefacts entry for it`,
            );
        }
        if (turns.some((t) => t.outcome === "ok")) {
            throw new Error(`the journal ends a turn for ${item} (${arm}) ok without a snapshot`);
        }
        if (turns.length > 0) return "probe turn failed";
        const outcome = event === undefined ? undefined : eventOutcomes.get(`${arm}/${event}`);
        if (outcome !== undefined && outcome !== "failed(interrupted)") {
            throw new Error(
                `the journal ends event ${event} for ${item} (${arm}) as ${outcome} without an EndTurn`,
            );
        }
        return outcome === undefined ? "no journaled snapshot" : "probe turn interrupted";
    };
    const probes = new Map(scenario.probes.map((p) => [p.id, p]));
    const snapshots = new Map<string, RowMeta[]>();
    const metas = new Map<string, RowMeta>();
    const readRow = (meta: RowMeta): Snapshot => {
        const row = JSON.parse(readPlaced(meta.path, meta.offset, meta.length)) as Snapshot;
        if (row.id !== meta.id) {
            throw new Error(`snapshot log ${meta.path} changed under grading at ${meta.id}`);
        }
        return meta.journaled ? row : { ...row, artefacts: [] };
    };
    for (const arm of arms) {
        const path = join(dir, arm, "snapshots.jsonl");
        if (!existsSync(path)) continue;
        for await (const placed of jsonlRecords(path)) {
            const s = JSON.parse(placed.text) as Snapshot;
            if (s.arm !== arm || !Array.isArray(s.artefacts) || s.artefacts.length === 0) {
                throw new Error(
                    `snapshot ${s.id} in ${arm}/snapshots.jsonl names arm ${s.arm} or has no artefacts`,
                );
            }
            assertArtefactsOnly(s);
            const entry = named.get(s.id);
            if (entry && (entry.arm !== arm || entry.item !== s.item)) {
                throw new Error(
                    `snapshot ${s.id} in ${arm}/snapshots.jsonl does not match its journal entry (${entry.arm}, ${entry.item})`,
                );
            }
            const probe = entry ? probes.get(s.item) : undefined;
            if (entry && !probe) {
                throw new Error(
                    `snapshot ${s.id} is journaled for item ${s.item}, which the scenario does not compile`,
                );
            }
            if (entry && probe) {
                const turnOk = probe.event === undefined || s.turn === probe.event;
                const sessionOk = s.session === probe.session;
                if (!turnOk || !sessionOk) {
                    throw new Error(
                        `snapshot ${s.id} is of turn ${s.turn} in session ${String(s.session)}, not the probe's event ${String(probe.event)} in session ${probe.session}`,
                    );
                }
                const ended = turnEnds.get(s.id);
                if (!ended) {
                    throw new Error(`snapshot ${s.id} has no EndTurn naming it in the journal`);
                }
                if (ended.arm !== arm || ended.probe !== s.item || ended.event !== s.turn) {
                    throw new Error(
                        `snapshot ${s.id} is named by an EndTurn of ${ended.arm}/${ended.probe} at ${ended.event}, not ${arm}/${s.item} at ${s.turn}`,
                    );
                }
                const expected = ended.outcome === "ok" ? "ok" : "failed";
                if (s.turn_outcome !== expected) {
                    throw new Error(
                        `snapshot ${s.id} records turn_outcome ${String(s.turn_outcome)}, but its EndTurn ended ${ended.outcome}`,
                    );
                }
            }
            const key = `${arm}/${s.item}`;
            const meta: RowMeta = {
                id: s.id,
                item: s.item,
                arm,
                session: s.session ?? null,
                turn: s.turn,
                turn_outcome: s.turn_outcome,
                journaled: entry !== undefined,
                path,
                offset: placed.offset,
                length: placed.length,
            };
            snapshots.set(key, [...(snapshots.get(key) ?? []), meta]);
            if (entry) metas.set(s.id, meta);
        }
    }
    const occurrences = new Map<string, number>();
    for (const s of [...snapshots.values()].flat()) {
        occurrences.set(s.id, (occurrences.get(s.id) ?? 0) + 1);
    }
    const lost = [...named.keys()].filter((id) => !occurrences.has(id));
    if (lost.length > 0) {
        throw new Error(`journaled snapshots have no row in snapshots.jsonl: ${lost.join(", ")}`);
    }
    const doubled = [...named.keys()].filter((id) => (occurrences.get(id) ?? 0) > 1);
    if (doubled.length > 0) {
        throw new Error(
            `journaled snapshots have more than one row in snapshots.jsonl: ${doubled.join(", ")}`,
        );
    }
    /**
     * A snapshot's calls are the session's call records so far, in log order, each with the turn
     * index capture derived from the scenario. Each journaled snapshot is read back on its own
     * and checked as a prefix of its session's records (read through the call index, one
     * session at a time), so memory holds one snapshot and one session's records at most.
     */
    const turnIndex = new Map(
        scenario.events
            .filter((e) => e.index !== undefined)
            .map((e) => [e.id, e.index as number] as const),
    );
    const agentModels = new Set<string>();
    const callsPath = join(dir, "calls.jsonl");
    for await (const line of existsSync(callsPath) ? jsonlLines(callsPath) : []) {
        const r = JSON.parse(line) as CallRecord;
        if (typeof r.model !== "string" || typeof r.seq !== "number") {
            throw new Error(`calls.jsonl record ${String(r.seq)} names no model`);
        }
        if (r.component === "agent") agentModels.add(r.model);
    }
    const unrecorded = [...agentModels].filter((m) => !models.includes(m));
    if (unrecorded.length > 0) {
        throw new Error(
            `agent calls used models the manifest does not record: ${unrecorded.join(", ")}`,
        );
    }
    const callIndex = new CallIndex(callsPath);
    for (const meta of metas.values()) {
        const row = readRow(meta);
        const calls = row.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") continue;
        // A journal-backed user-sim entry restates a journaled turn; the log holds no record
        // for it. The mark is honoured only on a user-sim entry whose turn the journal holds
        // with that label.
        for (const c of calls.calls) {
            if (!c.journal) continue;
            const backed = entries.some(
                (e) =>
                    e.kind === "UserTurn" &&
                    e.arm === meta.arm &&
                    String(e.event) === c.turn &&
                    e.label === c.label,
            );
            if (c.component !== "user-sim" || !backed) {
                throw new Error(
                    `snapshot ${meta.id} marks call ${c.seq} as journal-backed, but the journal holds no such user turn`,
                );
            }
        }
        const recorded = callsOf(callIndex, meta.arm, String(meta.session), turnIndex).filter(
            (c) => c.component !== "user-sim",
        );
        const proxied = calls.calls.filter((c) => c.component !== "user-sim");
        const probeTurn = turnIndex.get(meta.turn);
        // The snapshot holds the session's calls recorded by the probe turn's end. A background
        // call (any component but the agent's) credited to the turn that was recorded after the
        // snapshot's last call, and that names another turn or none as its own, ran after the
        // snapshot was taken.
        const lastHeld = proxied.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
        const later = (c: CallView) =>
            c.seq > lastHeld && c.turn !== meta.turn && c.component !== "agent";
        let boundary = recorded.length - 1;
        while (
            boundary >= 0 &&
            (recorded[boundary]?.turn_index !== probeTurn || later(recorded[boundary] as CallView))
        )
            boundary--;
        if (boundary >= proxied.length) {
            throw new Error(
                `snapshot ${meta.id} holds ${proxied.length} calls, but calls.jsonl records call ${String(recorded[boundary]?.seq)} within its turn ${meta.turn}`,
            );
        }
        proxied.forEach((held, i) => {
            const record = recorded[i];
            if (record === undefined) {
                throw new Error(
                    `snapshot ${meta.id} holds call ${held.seq}, which calls.jsonl does not record for arm ${meta.arm}`,
                );
            }
            if (canonicalJson(held) !== canonicalJson(record)) {
                throw new Error(
                    `snapshot ${meta.id} holds call ${held.seq} where calls.jsonl records call ${record.seq} with content that differs from calls.jsonl`,
                );
            }
        });
    }
    /** The arm's attempts at an item from its journaled first snapshot on: the first read in full, the rest as counted rows. */
    const attempts = (arm: string, item: string): Snapshot[] | undefined => {
        const rows = snapshots.get(`${arm}/${item}`) ?? [];
        const first = rows.findIndex((s) => journaled.has(s.id));
        if (first === -1) return undefined;
        return rows
            .slice(first)
            .map((meta, i) => (i === 0 ? readRow(meta) : readRow({ ...meta, journaled: false })));
    };
    const ran = new Set(
        scenario.events
            .slice(0, manifest.events)
            .map((e) => (e as { probe?: string }).probe)
            .filter(Boolean),
    );

    const graded: GradeRecord[] = [];
    const skipped: Summary["skipped"] = {};
    const skip = (arm: string, why: string) => {
        skipped[arm] ??= {};
        const mine = skipped[arm] as Record<string, number>;
        mine[why] = (mine[why] ?? 0) + 1;
    };
    // A grade this grader already made from the same snapshot stands unless `regrade` asks anew;
    // a grade from another grader implementation is made again.
    // The grader's identity is read once, before any grade, so the summary names the code that ran.
    const grader = graderDigest();
    const graderSim = simIdentity();
    const priorKey = (item: string, arm: string, against: string | undefined, snapshot: string) =>
        `${item}/${arm}/${against ?? ""}/${snapshot}`;
    const latest = log.latest();
    const prior = new Set(
        regrade
            ? []
            : latest
                  .filter((g) => g.grader === grader)
                  .map((g) => priorKey(g.item, g.arm, g.against, g.snapshot)),
    );
    // A counterfactual arm's sampled item counts only once its journaled deletion verified
    // every targeted memory gone; until then it is graded excluded(cf-unverified), and a grade
    // made before that reading is graded again.
    const verifiedDeletion = new Set(
        entries
            .filter(
                (e) =>
                    e.kind === "CounterfactualDeletion" &&
                    e.skipped === undefined &&
                    Array.isArray(e.deleted) &&
                    e.deleted.length > 0 &&
                    e.deleted.every((id) => Number.isInteger(id)) &&
                    e.remaining === 0,
            )
            .map((e) => `${String(e.arm)}/${String(e.probe)}`),
    );
    const sampled = new Set((scenario.cf_deletions ?? []).map((d) => d.probe));
    const unverified = (arm: string, item: string) =>
        armBase(arm) === "eidnara-cf" &&
        sampled.has(item) &&
        !verifiedDeletion.has(`${arm}/${item}`);
    const standsExcluded = new Set(
        latest.filter((g) => g.reason === "cf-unverified").map((g) => `${g.item}/${g.arm}`),
    );
    const gradedBefore = (item: string, arm: string, against: string | undefined, id: string) =>
        prior.has(priorKey(item, arm, against, id)) &&
        !(unverified(arm, item) && !standsExcluded.has(`${item}/${arm}`));
    const staged: GradeRecord[] = [];
    // Every grade of the pass lands in one write after every item is graded.
    const commit = () => {
        const records = staged.map((g) => ({ ...g, version: log.nextVersion(g), grader }));
        log.appendAll(records);
        graded.push(...records);
    };
    const outside = `probe turn outside the run's ${manifest.events} events`;
    let judgeErrors = 0;
    const p7 = scenario.probes.filter((p) => p.type === "P7");
    const memoryArms = arms.filter((a) => armBase(a) !== "host");
    const pairs = p7.flatMap((probe) =>
        memoryArms.flatMap((arm) => {
            if (!ran.has(probe.id)) {
                for (const side of [arm, "host"]) skip(side, outside);
                return [];
            }
            const sides = { [arm]: attempts(arm, probe.id), host: attempts("host", probe.id) };
            const lost = new Set<string>();
            for (const [side, rows] of Object.entries(sides)) {
                if (!rows) skip(side, unjournaled(side, probe.id, probe.event));
                else if (rows[0]?.turn_outcome !== "ok") skip(side, "P7 probe turn failed");
                else continue;
                lost.add(side);
            }
            for (const side of Object.keys(sides)) {
                if (lost.size > 0 && !lost.has(side)) skip(side, "P7 pairing lost");
            }
            const [mine, host] = [sides[arm], sides.host];
            if (lost.size > 0 || !mine?.[0] || !host?.[0]) return [];
            // The pair's two grades land in one write, host side first, so the memory arm's grade
            // means its pair stands.
            if (gradedBefore(probe.id, arm, "host", mine[0].id)) {
                for (const side of [arm, "host"]) skip(side, "already graded");
                return [];
            }
            for (const side of [mine[0], host[0]]) requireEvidence(probe, side);
            return [{ probe, arm, a: mine[0], b: host[0], rows: { a: mine, b: host } }];
        }),
    );
    const firewall = (url: string) => {
        const judges = models.map((m) => proxyJudge(url, rules.judge.model, m));
        if (!judges[0]) throw new Error("the manifest records no run model");
        return judges[0];
    };
    if (pairs.length > 0) {
        firewall("http://judge.invalid");
        if (!config) throw new Error("P7 judging needs the sim config");
    }

    const eventOrder = new Map(scenario.events.map((e, i) => [String(e.id), i]));
    const sourcesOf = (probe: Scenario["probes"][number]): SourceEvent[] =>
        (probe.ground_truth?.sources ?? []).flatMap((id) => {
            const at = eventOrder.get(id);
            return at === undefined ? [] : [scenario.events[at] as unknown as SourceEvent];
        });
    const ledgers = new Map<string, { turn: string | null; run: Command }[]>();
    /** The arm's tool ledger (`tools.jsonl`), read once, each run with the turn it belongs to. */
    const ledger = (arm: string) => {
        const cached = ledgers.get(arm);
        if (cached) return cached;
        const path = join(dir, arm, "tools.jsonl");
        if (!existsSync(path)) throw new Error(`arm ${arm} has no tools.jsonl`);
        const rows = readJsonl<Record<string, unknown>>(path);
        const runs: { turn: string | null; run: Command }[] = [];
        rows.forEach((row, i) => {
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
                throw new Error(`${arm}/tools.jsonl line ${i + 1} is not a tool run`);
            }
            runs.push({
                turn: turn as string | null,
                run: { command, exit: exit as number | null, scenario_ms },
            });
        });
        ledgers.set(arm, runs);
        return runs;
    };
    /**
     * A P12 tool-result snapshot gains a `source` command log: the runs the arm's tool ledger
     * attributes to a user turn of a source turn's session, from the first source turn up to the
     * probe, so the grader can confirm the agent ran the committed check.
     */
    const withSourceCommands = (
        snap: Snapshot,
        probe: Scenario["probes"][number],
        sources: SourceEvent[],
    ): Snapshot => {
        if (!needsSourceCommands(probe, sources)) return snap;
        const turns = sources.filter((e) => e.kind === "user_turn");
        const from = Math.min(...turns.map((e) => eventOrder.get(e.id) ?? Infinity));
        const to = eventOrder.get(probe.event ?? "") ?? scenario.events.length;
        const sessions = new Set(turns.map((e) => e.session));
        const open = new Set(
            scenario.events
                .slice(from, to)
                .filter((e) => e.kind === "user_turn" && sessions.has(String(e.session)))
                .map((e) => String(e.id)),
        );
        const commands = ledger(snap.arm)
            .filter((x) => x.turn !== null && open.has(x.turn))
            .map((x) => x.run);
        const source: CommandLog = {
            id: `${snap.id}:source-commands`,
            class: "command-log",
            role: "source",
            commands,
        };
        return { ...snap, artefacts: [...snap.artefacts, source] };
    };

    for (const probe of scenario.probes.filter((p) => p.type !== "P7")) {
        const sources = sourcesOf(probe);
        for (const arm of arms) {
            if (probe.type === "P14") {
                skip(arm, "P14 has no probe turn");
                continue;
            }
            if (!ran.has(probe.id)) {
                skip(arm, outside);
                continue;
            }
            const mine = attempts(arm, probe.id);
            if (!mine) {
                skip(arm, unjournaled(arm, probe.id, probe.event));
                continue;
            }
            if (gradedBefore(probe.id, arm, undefined, (mine[0] as Snapshot).id)) {
                skip(arm, "already graded");
                continue;
            }
            let grade: GradeRecord | null;
            try {
                const [first, ...later] = mine;
                const graded = [withSourceCommands(first as Snapshot, probe, sources), ...later];
                grade = gradeItem(probe, graded, rules, 1, sources);
            } catch (caught) {
                if (!(caught instanceof EvidenceRefused)) throw caught;
                skip(arm, caught instanceof AnswerRefused ? "answer refused" : "evidence refused");
                console.error(`${probe.id} (${arm}): ${String(caught)}`);
                continue;
            }
            if (!grade) skip(arm, "probe turn failed");
            else if (unverified(arm, probe.id)) {
                staged.push({
                    ...grade,
                    verdict: "excluded",
                    reason: "cf-unverified",
                    metrics: {},
                });
            } else staged.push(grade);
        }
    }

    if (pairs.length > 0 && config) {
        for (const name of ["judge-calls.jsonl", "judgments.jsonl"])
            requireAppendable(join(dir, name));
        const records = new RecordWriter(join(dir, "judge-calls.jsonl"), { resume: true });
        const gateway = new Gateway({
            upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
            records,
            injector: new FaultInjector([], new Rng(1), 1_000),
            rng: new Rng(manifest.seed),
            clock: { scenarioMs: () => 0 },
            scope: () => ({ arm: "judge", session: null, turn: null }),
        });
        await gateway.start();
        const judged: { arm: string; grades: GradeRecord[] }[] = [];
        const judgments: Record<string, unknown>[] = [];
        try {
            const judge = firewall(gateway.urls[0] as string);
            for (const { probe, arm, a, b, rows } of pairs) {
                const reference = String((probe.check as { judge?: string }).judge ?? "");
                const both = (why: string) => {
                    for (const side of [arm, "host"]) skip(side, why);
                };
                const refuse = (caught: unknown) => {
                    both("P7 refused");
                    console.error(`${probe.id} (${arm}): ${String(caught)}`);
                };
                const fail = (caught: unknown) => {
                    judgeErrors++;
                    both("P7 judge call failed");
                    console.error(`${probe.id} (${arm}): ${String(caught)}`);
                };
                let built: P7Inputs | null;
                try {
                    built = p7Pair(probe.id, a, b);
                } catch (caught) {
                    if (!(caught instanceof AnswerRefused)) throw caught;
                    refuse(caught);
                    continue;
                }
                if (!built) {
                    both("P7 probe turn failed");
                    continue;
                }
                let judgment: Judgment;
                const firstCall = records.records.length;
                try {
                    judgment = await judgePair(judge, built.pair, reference, []);
                } catch (caught) {
                    if (caught instanceof BlindingRefused) refuse(caught);
                    else fail(caught);
                    continue;
                }
                const calls = records.records.slice(firstCall).map((r) => r.seq);
                const context = {
                    probe,
                    snapshots: rows,
                    calibration: null,
                    permutation: null,
                    cross_judge: null,
                };
                let grades: GradeRecord[];
                try {
                    grades = gradeP7(judgment, context, rules);
                } catch (caught) {
                    if (caught instanceof GradeRefused) throw caught;
                    fail(caught);
                    continue;
                }
                judged.push({ arm, grades });
                judgments.push({ item: probe.id, arm, against: "host", calls, judgment });
            }
        } finally {
            await gateway.stop();
        }
        if (gateway.failures.length > 0) {
            judgeErrors += gateway.failures.length;
            for (const f of gateway.failures) console.error(`judge-calls.jsonl: ${String(f)}`);
            for (const { arm } of judged)
                for (const side of [arm, "host"]) skip(side, "P7 judge call failed");
        } else {
            const rows = judgments.map((j) => `${JSON.stringify(j)}\n`).join("");
            const log = join(dir, "judgments.jsonl");
            keepCompleteLines(log);
            appendFileSync(log, rows);
            // Host side first: a write cut after the host grade leaves the memory arm ungraded,
            // which grades the pair again on the next pass.
            for (const { grades } of judged) {
                staged.push(...grades.filter((g) => g.arm === "host"));
                staged.push(...grades.filter((g) => g.arm !== "host"));
            }
        }
    }
    commit();

    const current = log.latest();
    const p11 = Object.fromEntries(
        arms.map((arm) => {
            const mine = current.filter((g) => g.arm === arm && g.probe_type === "P11");
            const score = mine.reduce(
                (n, g) => n + Number(g.metrics["P11.weighted_score"] ?? 0),
                0,
            );
            return [arm, { n: mine.length, weighted_score: score }];
        }),
    );
    const p3 = memoryArms.map((arm) => ({ arm, delta_mem: deltaMem(current, arm) }));
    const versions: Summary["versions"] = {};
    for (const g of current) versions[g.version] = (versions[g.version] ?? 0) + 1;
    return {
        verdicts: verdictCounts(current),
        graded: graded.length,
        skipped,
        versions,
        p11,
        p3,
        judge_errors: judgeErrors,
        journal_seq: entries.at(-1)?.seq ?? 0,
        grader: { digest: grader, ...graderSim },
    };
}

if (import.meta.main) {
    const dir = resolve(process.argv[2] ?? "");
    if (!process.argv[2] || !existsSync(join(dir, "manifest.json"))) {
        console.error("usage: bun scripts/grade-run.ts <run dir> [--regrade]");
        process.exit(2);
    }
    const summary = await gradeRun(dir, loadConfig(), process.argv.includes("--regrade"));
    console.log(JSON.stringify(summary, null, 2));
    if (summary.judge_errors > 0) process.exit(1);
}
