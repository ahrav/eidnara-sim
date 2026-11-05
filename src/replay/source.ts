import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Snapshot } from "../grade/artefacts";
import { GradeLog, type GradeRecord } from "../grade/probes";
import type { CallRecord } from "../proxy/records";
import { type Entry, readJsonl } from "../run/journal";
import type { ScenarioEvent } from "../run/scheduler";
import type { ProbeItem, Scenario } from "../scenario/compile";

const UNREPLAYABLE = new Set(["P7", "P14"]);

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
    arm: string;
    probe: ProbeItem & { event: string };
    event: ScenarioEvent;
    sessionStart: ScenarioEvent;
    project: string;
    begin: Entry;
    end: Entry;
    /** The clock offset in seconds in effect at `BeginTurn`. */
    offsetS: number;
    /** Wall time of the probe turn's first proxy call, or of its `EndTurn` when it made none. */
    firstCallWall: number;
    snapshot: Snapshot;
    calls: CallRecord[];
    /** The session's user turns the journal ended before the probe. */
    priorTurns: string[];
    /** Sessions opened after the probe's session, in scenario order. */
    laterSessions: string[];
    grade: GradeRecord | null;
}

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function loadProbeSource(dir: string, arm: string, item: string): ProbeSource {
    const root = realpathSync(dir);
    const manifest = json<ProbeSource["manifest"]>(join(root, "manifest.json"));
    if (!manifest.order.includes(arm)) {
        throw new Error(`arm ${arm} is not in the run's order (${manifest.order.join(", ")})`);
    }
    const scenario = json<Scenario>(join(root, "scenario.json"));
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
    let offsetS = 0;
    for (const e of mine) {
        if (e.kind === "ClockOffset" && e.seq < begin.seq) offsetS = Number(e.offset_s);
    }
    const snapshot = readJsonl<Snapshot>(join(root, arm, "snapshots.jsonl")).find(
        (s) => s.id === end.snapshot,
    );
    if (!snapshot) throw new Error(`${arm}/snapshots.jsonl has no row ${String(end.snapshot)}`);
    const calls = readJsonl<CallRecord>(join(root, "calls.jsonl")).filter(
        (r) => r.arm === arm && r.turn === event.id,
    );
    const firstCallWall = calls[0]?.started_wall_ms ?? end.wall_ms;
    const ended = new Set(mine.filter((e) => e.kind === "EndTurn").map((e) => String(e.event)));
    const priorTurns = events
        .slice(0, at)
        .filter((e) => e.kind === "user_turn" && e.session === event.session && ended.has(e.id))
        .map((e) => e.id);
    const startAt = events.indexOf(sessionStart);
    const laterSessions = events
        .slice(startAt + 1)
        .filter((e) => e.kind === "session_start")
        .map((e) => e.session);
    const gradesPath = join(root, "grades.jsonl");
    const grade = existsSync(gradesPath)
        ? (new GradeLog(gradesPath).latest().find((g) => g.item === item && g.arm === arm) ?? null)
        : null;
    const launcher = (manifest.preflight as { launcher?: unknown } | undefined)?.launcher;
    if (typeof launcher !== "string") throw new Error("the manifest records no preflight launcher");
    return {
        dir: root,
        recordedDir: dirname(launcher),
        manifest,
        scenario,
        arm,
        probe: probe as ProbeSource["probe"],
        event,
        sessionStart,
        project,
        begin,
        end,
        offsetS,
        firstCallWall,
        snapshot,
        calls,
        priorTurns,
        laterSessions,
        grade,
    };
}

export const daemonCutoffMs = (s: ProbeSource) => s.begin.wall_ms + s.offsetS * 1000;
