import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertArtefactsOnly, type Snapshot } from "../grade/artefacts";
import { GradeLog, type GradeRecord } from "../grade/probes";
import { CONTROL_LABEL } from "../hosts/arms";
import { isArmName } from "../hosts/profiles";
import type { CallRecord } from "../proxy/records";
import { type Entry, eachLine, readJsonl } from "../run/journal";
import type { ScenarioEvent } from "../run/scheduler";
import { type ProbeItem, type Scenario, scenarioHash } from "../scenario/compile";

const UNREPLAYABLE = new Set(["P7", "P14"]);
const MANIFEST_SCHEMA = "sim-run-manifest/v3";

/** One arm's probe turn in a finished run, located through the run's journal. */
export interface ProbeSource {
    dir: string;
    /** The run's original directory, which differs from `dir` after the run moved. */
    recordedDir: string;
    manifest: Record<string, unknown> & {
        order: string[];
        models: string[];
        base_wall_ms: number;
        host: string;
        tier: string;
        seed: number;
        context_limit: number;
        side_model: string | null;
        events: number;
        price_table: { version: string; rates: Record<string, number> };
    };
    scenario: Scenario;
    journal: Entry[];
    arm: string;
    probe: ProbeItem & { event: string };
    event: ScenarioEvent;
    sessionStart: ScenarioEvent;
    project: string;
    begin: Entry;
    end: Entry;
    /** The clock offset in seconds in effect at `BeginTurn`. */
    offsetS: number;
    /** Wall time of the probe turn's first agent call, or of its `EndTurn` when it made none. */
    firstCallWall: number;
    snapshot: Snapshot;
    calls: CallRecord[];
    /** Sessions opened after the probe's session, in scenario order. */
    laterSessions: string[];
    grade: GradeRecord | null;
    gradeError: string | null;
}

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function matchingLines<T>(path: string, needle: string, keep: (row: T) => boolean): T[] {
    const out: T[] = [];
    const marker = Buffer.from(needle);
    eachLine(path, (line) => {
        if (line.indexOf(marker) < 0) return;
        const row = JSON.parse(line.toString("utf8")) as T;
        if (keep(row)) out.push(row);
    });
    return out;
}

export function loadProbeSource(dir: string, arm: string, item: string): ProbeSource {
    const root = realpathSync(dir);
    const manifest = json<ProbeSource["manifest"]>(join(root, "manifest.json"));
    if (manifest.schema !== MANIFEST_SCHEMA) {
        throw new Error(`manifest.json is ${String(manifest.schema)}, not ${MANIFEST_SCHEMA}`);
    }
    const base = arm.split("~")[0] as string;
    if (!isArmName(base) || (arm !== base && !CONTROL_LABEL.test(arm))) {
        throw new Error(`arm ${JSON.stringify(arm)} is not an arm or control label`);
    }
    if (!manifest.order.includes(arm)) {
        throw new Error(`arm ${arm} is not in the run's order (${manifest.order.join(", ")})`);
    }
    const scenario = json<Scenario>(join(root, "scenario.json"));
    const identity = scenario.manifest as { tier?: unknown; seed?: unknown };
    if (scenarioHash(scenario) !== manifest.scenario_hash) {
        throw new Error("scenario.json does not hash to the manifest's scenario_hash");
    }
    if (identity.tier !== manifest.tier || identity.seed !== manifest.seed) {
        throw new Error(
            `scenario.json is ${String(identity.tier)} seed ${String(identity.seed)}, not the manifest's ${manifest.tier} seed ${manifest.seed}`,
        );
    }
    const probe = scenario.probes.find((p) => p.id === item);
    if (!probe) throw new Error(`item ${item} is not a probe of the run's scenario`);
    if (UNREPLAYABLE.has(probe.type) || typeof probe.event !== "string") {
        throw new Error(`item ${item} is a ${probe.type} probe, which has no single graded turn`);
    }
    const events = scenario.events as unknown as ScenarioEvent[];
    const at = events.findIndex((e) => e.id === probe.event);
    const event = events[at];
    if (event?.kind !== "user_turn") {
        throw new Error(`probe ${item} names event ${probe.event}, which is not a user turn`);
    }
    const sessionStart = events.find(
        (e) => e.kind === "session_start" && e.session === event.session,
    );
    if (!sessionStart) throw new Error(`session ${event.session} has no session_start event`);
    const project = String(
        sessionStart.project ?? scenario.sessions.find((s) => s.id === event.session)?.project,
    );
    const journal = readJsonl<Entry>(join(root, "journal.jsonl"));
    if (!journal.some((e) => e.kind === "EndRun")) {
        throw new Error(`${root} has no EndRun: replay reads finished runs only`);
    }
    const mine = journal.filter((e) => e.arm === arm);
    const begin = mine.find((e) => e.kind === "BeginTurn" && e.event === event.id);
    const end = mine.find((e) => e.kind === "EndTurn" && e.event === event.id);
    if (!begin || !end) {
        throw new Error(`the journal holds no ended probe turn ${event.id} for ${arm}`);
    }
    if (end.outcome !== "ok" || typeof end.snapshot !== "string") {
        throw new Error(`probe turn ${event.id} of ${arm} ended ${String(end.outcome)}`);
    }
    const offsets = mine.filter((e) => e.kind === "ClockOffset" && e.seq < begin.seq);
    const offset = offsets.at(-1);
    if (!offset) throw new Error(`the journal holds no ClockOffset for ${arm} before the probe`);
    const snapshotId = end.snapshot;
    const rows = matchingLines<Snapshot>(
        join(root, arm, "snapshots.jsonl"),
        `"id":${JSON.stringify(snapshotId)}`,
        (s) => s.id === snapshotId,
    );
    if (rows.length !== 1) {
        throw new Error(`${arm}/snapshots.jsonl holds ${rows.length} rows ${snapshotId}, not one`);
    }
    const snapshot = rows[0] as Snapshot;
    assertArtefactsOnly(snapshot);
    const own = { arm, item, turn: event.id, session: event.session, turn_outcome: "ok" };
    for (const [key, value] of Object.entries(own)) {
        if (snapshot[key as keyof Snapshot] !== value) {
            throw new Error(
                `snapshot ${snapshotId} names ${key} ${String(snapshot[key as keyof Snapshot])}, not ${value}`,
            );
        }
    }
    const calls = matchingLines<CallRecord>(
        join(root, "calls.jsonl"),
        `"turn":${JSON.stringify(event.id)}`,
        (r) => r.arm === arm && r.turn === event.id,
    );
    const firstAgent = calls.find((c) => c.component === "agent");
    const startAt = events.indexOf(sessionStart);
    const laterSessions = events
        .slice(startAt + 1)
        .filter((e) => e.kind === "session_start")
        .map((e) => e.session);
    const gradesPath = join(root, "grades.jsonl");
    let grade: GradeRecord | null = null;
    let gradeError: string | null = null;
    try {
        grade = existsSync(gradesPath)
            ? (new GradeLog(gradesPath).latest().find((g) => g.item === item && g.arm === arm) ??
              null)
            : null;
    } catch (caught) {
        gradeError = (caught as Error).message;
    }
    const launcher = (manifest.preflight as { launcher?: unknown } | undefined)?.launcher;
    if (typeof launcher !== "string") throw new Error("the manifest records no preflight launcher");
    return {
        dir: root,
        recordedDir: dirname(launcher),
        manifest,
        scenario,
        journal,
        arm,
        probe: probe as ProbeSource["probe"],
        event,
        sessionStart,
        project,
        begin,
        end,
        offsetS: Number(offset.offset_s),
        firstCallWall: firstAgent?.started_wall_ms ?? end.wall_ms,
        snapshot,
        calls,
        laterSessions,
        grade,
        gradeError,
    };
}

export const daemonCutoffMs = (s: ProbeSource) => s.begin.wall_ms + s.offsetS * 1000;
