import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GradeLog, type GradeRecord } from "../grade/probes";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { TARGET } from "../proxy/inject";
import { type Entry, readJournal } from "../run/journal";
import { checkJournal } from "../run/journal-check";
import { referenceArm } from "../run/run";
import type { FaultEpisode } from "../scenario/faults";
import { LABELS, type Label, realisedRates } from "../usersim/plan";
import { type PairingRecord, pairingMismatches } from "../usersim/usersim";
import type { GradedRun } from "./observe";

export type Witness = "witnessed" | "unreached" | "violated" | "unchecked";

export interface PropertyWitness {
    id: string;
    status: Witness;
    detail: string;
}

/** One run's artefacts, read once for every check. */
interface Ctx {
    g: GradedRun;
    pairing: PairingRecord[];
    manifest: {
        order: string[];
        events: number;
        tapes?: string[];
        /** By tape path, the sha256 of the sibling pairing log as the run began. */
        tape_pairing_sha256?: Record<string, string>;
        fault_override?: FaultEpisode[] | null;
    };
    /** Digests by `arm/event` from the pairing logs of the tapes a replayed run took. */
    recorded: Map<string, string>;
    /** Tapes whose sibling pairing log differs from the digest the run recorded. */
    changedSources: string[];
    entries: Entry[];
    grades: GradeRecord[];
}

type Check = (runs: Ctx[]) => { status: Witness; detail: string };

const outcome = (instances: number, bad: string[], what: string) =>
    bad.length > 0
        ? { status: "violated" as const, detail: bad.slice(0, 5).join("; ") }
        : instances === 0
          ? { status: "unreached" as const, detail: `no ${what}` }
          : { status: "witnessed" as const, detail: `${instances} ${what}` };

const jsonl = <T>(path: string): T[] =>
    existsSync(path) ? (readJournal(path) as unknown as T[]) : [];

function context(g: GradedRun): Ctx {
    const grades = join(g.run.dir, "grades.jsonl");
    const manifest = join(g.run.dir, "manifest.json");
    const read: Ctx["manifest"] = existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, "utf8"))
        : { order: g.run.arms.map((a) => a.arm), events: g.scenario.events.length };
    const recorded = new Map<string, string>();
    const changedSources: string[] = [];
    for (const tape of read.tapes ?? []) {
        const log = join(dirname(tape), "pairing.jsonl");
        const pinned = read.tape_pairing_sha256?.[tape];
        if (
            pinned !== undefined &&
            existsSync(log) &&
            sha256Hex(readFileSync(log, "utf8")) !== pinned
        )
            changedSources.push(tape);
        for (const r of jsonl<PairingRecord>(log)) {
            if (r.kind === "turn") recorded.set(`${r.arm}/${r.event}`, r.digest);
        }
    }
    return {
        g,
        pairing: jsonl<PairingRecord>(join(g.run.dir, "pairing.jsonl")),
        manifest: read,
        recorded,
        changedSources,
        entries: jsonl<Entry>(join(g.run.dir, "journal.jsonl")),
        grades: existsSync(grades) ? new GradeLog(grades).all() : [],
    };
}

const journalOf = (c: Ctx) => c.g.run.arms.flatMap((a) => a.journal);

/**
 * Delivered turns whose context digest differs from the reference arm's with no divergence
 * record yet; a skipped turn issues no text, so the divergence check runs at the next delivery.
 */
function hiddenDivergences(c: Ctx): string[] {
    const reference = referenceArm(c.manifest.order);
    const turns = c.pairing.filter((r) => r.kind === "turn");
    const byArm = new Map(turns.map((r) => [`${r.arm}/${r.event}`, r]));
    const diverged = new Map<string, number>();
    const bad: string[] = [];
    for (const r of c.pairing) {
        const key = `${r.arm}/${r.session}`;
        if (r.kind === "divergedAt") {
            diverged.set(key, Math.min(diverged.get(key) ?? r.index, r.index));
            continue;
        }
        if (r.arm === reference(r.arm) || r.delivered === false) continue;
        const other = byArm.get(`${reference(r.arm)}/${r.event}`);
        const recorded = r.index >= (diverged.get(key) ?? Number.POSITIVE_INFINITY);
        if (other && other.digest !== r.digest && !recorded) bad.push(`${r.arm} ${r.event} hidden`);
    }
    return bad;
}

const CHECKS: Record<string, Check> = {
    "SIM-P02": (runs) => {
        const bad = runs.flatMap((c) =>
            pairingMismatches(c.pairing, referenceArm(c.manifest.order)),
        );
        let n = 0;
        for (const c of runs) {
            const reference = referenceArm(c.manifest.order);
            const turns = c.pairing.filter((r) => r.kind === "turn");
            const keys = new Set(turns.map((r) => `${r.arm}/${r.event}`));
            const delivered = new Map(turns.map((r) => [`${r.arm}/${r.event}`, r.delivered]));
            for (const r of turns) {
                const other = delivered.get(`${reference(r.arm)}/${r.event}`);
                if (r.arm !== reference(r.arm) && other !== undefined && other !== r.delivered)
                    bad.push(`${r.arm} ${r.event} delivered ${r.delivered}, reference ${other}`);
            }
            const diverged = new Map(
                c.pairing
                    .filter((r) => r.kind === "divergedAt")
                    .map((r) => [`${r.arm}/${r.session}`, r.index]),
            );
            // A pairing record precedes the prompt, so a pair counts once both arms journaled
            // the turn as sent.
            const sent = new Set(
                c.g.run.arms.flatMap((a) =>
                    a.journal
                        .filter((e) => e.kind === "UserTurn" && e.delivered === true)
                        .map((e) => `${a.arm}/${String(e.event)}`),
                ),
            );
            // The property covers indices below the arm's divergence, as the mismatch check does.
            n += turns.filter(
                (r) =>
                    r.arm !== reference(r.arm) &&
                    keys.has(`${reference(r.arm)}/${r.event}`) &&
                    (!r.delivered ||
                        (sent.has(`${r.arm}/${r.event}`) &&
                            sent.has(`${reference(r.arm)}/${r.event}`))) &&
                    r.index < (diverged.get(`${r.arm}/${r.session}`) ?? Number.POSITIVE_INFINITY),
            ).length;
        }
        return outcome(n, bad, "paired user turns");
    },
    "SIM-P03": (runs) => {
        const bad: string[] = [];
        let n = 0;
        for (const c of runs) {
            const reference = referenceArm(c.manifest.order);
            const turnOf = (arm: string, event: string) =>
                c.pairing.find((x) => x.kind === "turn" && x.arm === arm && x.event === event);
            for (const tape of c.changedSources)
                bad.push(`${tape}: source pairing log changed since the run`);
            c.pairing.forEach((r, i) => {
                if (r.kind !== "divergedAt") return;
                const own = turnOf(r.arm, r.event);
                const other =
                    r.against === "reference"
                        ? turnOf(reference(r.arm), r.event)?.digest
                        : c.recorded.get(`${r.arm}/${r.event}`);
                // A record whose turns a kill left unwritten describes nothing yet; it is no
                // instance. A replayed record's source digest must exist.
                if (!own || (r.against === "reference" && other === undefined)) return;
                n++;
                const turn = c.pairing.findIndex(
                    (x) => x.kind === "turn" && x.arm === r.arm && x.event === r.event,
                );
                if (turn >= 0 && turn < i) bad.push(`${r.arm} ${r.event}`);
                if (r.against === "recorded" && other === undefined)
                    bad.push(`${r.arm} ${r.event} has no source digest to compare with`);
                else if (own.digest !== r.digest || other !== r.reference_digest)
                    bad.push(`${r.arm} ${r.event} hashes differ from its turns'`);
            });
            bad.push(...hiddenDivergences(c));
        }
        return outcome(
            n,
            bad,
            "divergence records, each ahead of its turn with its hashes, none hidden",
        );
    },
    "SIM-P04": (runs) => {
        const n = runs.reduce(
            (s, c) => s + c.pairing.filter((r) => r.kind === "divergedAt").length,
            0,
        );
        return outcome(n, [], "divergences");
    },
    "SIM-P10": (runs) => {
        const full = runs.filter((c) => c.manifest.events >= c.g.scenario.events.length);
        if (full.length === 0)
            return {
                status: "unreached",
                detail: "a capped prefix cannot match whole-scenario rates",
            };
        let n = 0;
        const bad: string[] = [];
        for (const c of full) {
            for (const a of c.g.run.arms) {
                // UserSimRates is journaled before EndArm, so its presence marks a completed arm.
                const journaled = a.journal.find((e) => e.kind === "UserSimRates");
                if (!journaled) continue;
                const turns = a.journal
                    .filter((e) => e.kind === "UserTurn" && e.delivered === true)
                    .map((e) => ({ session: String(e.session), label: e.label as Label }));
                n++;
                const realised = realisedRates(turns, c.g.run.prereg);
                if (realised.outside.length > 0) bad.push(`${a.arm}: ${realised.outside}`);
                const {
                    kind: _k,
                    arm: _a,
                    scenario_ms: _s,
                    seq: _q,
                    wall_ms: _w,
                    ...summary
                } = journaled;
                if (canonicalJson(summary) !== canonicalJson(realised))
                    bad.push(`${a.arm}: journaled summary differs from the turns' rates`);
            }
        }
        return outcome(n, bad, "completed arms with realised rates");
    },
    "SIM-P11": (runs) =>
        journalCheck(
            runs,
            (r) => r.decreasing_scenario_ms,
            (r) => r.entries,
            "journal entries in order",
        ),
    "SIM-P12": (runs) =>
        journalCheck(runs, (r) => r.advance_while_busy, jumps, "clock jumps, each while idle"),
    "SIM-P14": (runs) =>
        journalCheck(runs, (r) => r.off_schedule_jumps, jumps, "clock jumps, each on schedule"),
    "SIM-P15": (runs) => {
        const bad: string[] = [];
        let n = 0;
        for (const c of runs) {
            for (const a of c.g.run.arms) {
                const clock = journalClock(a.journal);
                let wall = Number.NEGATIVE_INFINITY;
                const seqs = new Set<number>();
                for (const call of [...a.calls].sort((x, y) => x.seq - y.seq)) {
                    n++;
                    if (!Number.isInteger(call.seq) || seqs.has(call.seq)) {
                        bad.push(`call seq ${JSON.stringify(call.seq)} is not a fresh integer`);
                        continue;
                    }
                    seqs.add(call.seq);
                    if (!Number.isFinite(call.scenario_ms) || !Number.isFinite(call.wall_ms)) {
                        bad.push(`call ${call.seq} lacks a time`);
                        continue;
                    }
                    if (call.wall_ms < wall) bad.push(`call ${call.seq} wall time decreases`);
                    wall = Math.max(wall, call.wall_ms);
                    if (
                        !Number.isFinite(call.started_wall_ms) ||
                        call.started_wall_ms > call.wall_ms
                    ) {
                        bad.push(`call ${call.seq} has no usable receipt time`);
                        continue;
                    }
                    const expected = clock(call.started_wall_ms);
                    if (expected === undefined)
                        bad.push(`call ${call.seq} starts before the journal`);
                    else if (Math.abs(call.scenario_ms - expected) > CLOCK_SLACK_MS)
                        bad.push(
                            `call ${call.seq} at scenario ${call.scenario_ms} ms, the journal's clock says ${expected}`,
                        );
                }
            }
        }
        return outcome(
            n,
            bad,
            "proxy records with both times, wall time in order, scenario time on the journal's clock",
        );
    },
    "SIM-P25": (runs) => {
        const turns = runs.flatMap((c) => journalOf(c).filter((e) => e.kind === "UserTurn"));
        const bad = turns
            .filter((e) => !(LABELS as readonly string[]).includes(String(e.label)))
            .map((e) => String(e.event));
        return outcome(turns.length, bad, "labelled user turns");
    },
    "SIM-P30": (runs) => {
        let n = 0;
        const bad: string[] = [];
        for (const c of runs) {
            // The run executes its manifest's override when `--faults` named one.
            const faults = c.manifest.fault_override ?? c.g.scenario.faults;
            const known = (id: unknown) => faults.some((f) => f.id === id);
            for (const e of journalOf(c).filter((x) => x.kind === "FaultObserved")) {
                if (!known(e.fault)) bad.push(`observed ${e.fault} unscheduled`);
            }
            for (const a of c.g.run.arms) {
                const fired = a.journal.filter((e) => e.kind === "FaultFired");
                const calls = [...a.calls].sort((x, y) => x.seq - y.seq);
                // The injector spends a bounded fault's count on every eligible agent call after
                // it fired, whether or not that call was injected.
                const eligible = (firedAt: number) =>
                    calls.filter((x) => x.component === TARGET && x.started_wall_ms >= firedAt);
                for (const call of calls.filter((x) => typeof x.fault_ref === "string")) {
                    n++;
                    const id = call.fault_ref as string;
                    const fault = faults.find((f) => f.id === id);
                    const firedAt = fired.find(
                        (e) => e.fault === id && e.wall_ms <= call.started_wall_ms,
                    )?.wall_ms;
                    if (!fault || firedAt === undefined) {
                        bad.push(`call ${call.seq} names ${id}, not fired before it`);
                        continue;
                    }
                    // The window closes at the trigger session's end, and for a bounded fault
                    // after its count of eligible calls.
                    const closed = windowClose(c, a.journal, fault.trigger.session);
                    if (closed !== undefined && call.started_wall_ms > closed)
                        bad.push(`call ${call.seq} names ${id} after its session ended`);
                    const limit =
                        fault.strategy === "persistent"
                            ? Number.POSITIVE_INFINITY
                            : (fault.params.count ?? fault.params.calls ?? 1);
                    const position = eligible(firedAt).findIndex((x) => x.seq === call.seq) + 1;
                    if (position > limit) bad.push(`call ${call.seq} names ${id} beyond its count`);
                }
            }
        }
        return outcome(n, bad, "injected calls, each naming a scheduled fault inside its window");
    },
    "SIM-P41": (runs) => {
        const seen = new Map<string, { n: number; snapshot: unknown }>();
        const bad: string[] = [];
        for (const c of runs) {
            for (const e of journalOf(c).filter((x) => x.kind === "SnapshotArtefacts")) {
                const key = `${c.g.run.dir}/${e.arm}/${e.item}`;
                const prior = seen.get(key);
                seen.set(key, { n: (prior?.n ?? 0) + 1, snapshot: prior?.snapshot ?? e.snapshot });
            }
            for (const a of c.g.run.arms) {
                const ends = a.journal.filter((e) => e.kind === "EndTurn");
                const probes = new Set(ends.filter((e) => e.probe).map((e) => String(e.probe)));
                for (const e of a.journal.filter((x) => x.kind === "SnapshotArtefacts")) {
                    if (!probes.has(String(e.item)))
                        bad.push(`${a.arm}/${e.item} snapshot with no probe turn`);
                }
                for (const probe of probes) {
                    const first = ends.find((e) => e.probe === probe) as Entry;
                    const snap = a.journal.find(
                        (e) => e.kind === "SnapshotArtefacts" && e.item === probe,
                    );
                    if (!snap) bad.push(`${a.arm}/${probe} reached without a snapshot`);
                    else if (snap.seq < first.seq)
                        bad.push(`${a.arm}/${probe} snapshot before the probe's turn ended`);
                    else if (ends.some((e) => e.seq > first.seq && e.seq < snap.seq))
                        bad.push(`${a.arm}/${probe} snapshot after a later turn`);
                }
            }
            // Every persisted grade, earlier versions included, cites the item's one snapshot.
            for (const r of c.grades.length > 0 ? c.grades : c.g.grades) {
                const s = seen.get(`${c.g.run.dir}/${r.arm}/${r.item}`);
                if (!s) bad.push(`${r.arm}/${r.item} graded without a journaled snapshot`);
                else if (s.snapshot !== undefined && s.snapshot !== r.snapshot)
                    bad.push(`${r.arm}/${r.item} v${r.version} grades ${r.snapshot}`);
            }
        }
        bad.unshift(...[...seen].filter(([, s]) => s.n > 1).map(([k]) => `${k} set twice`));
        return outcome(
            seen.size,
            bad,
            "item snapshots, each set once at the probe's first turn and cited by its grades",
        );
    },
    "SIM-P42": (runs) => {
        let n = 0;
        const bad: string[] = [];
        const used = new Map<number, number>();
        for (const c of runs) {
            const versions = new Map<string, number>();
            for (const r of c.grades) {
                n++;
                const key = `${r.arm}/${r.item}`;
                if (!Number.isInteger(r.version) || r.version < 1) {
                    bad.push(`${key} version ${JSON.stringify(r.version)}`);
                    continue;
                }
                if (r.version <= (versions.get(key) ?? 0)) bad.push(key);
                versions.set(key, r.version);
            }
            for (const r of c.g.grades) {
                used.set(r.version, (used.get(r.version) ?? 0) + 1);
                // A P7 host row follows the judgment the report pairs it with, so its latest is
                // the latest among the rows of that judgment, keyed by their inputs.
                const latest =
                    r.probe_type === "P7"
                        ? Math.max(
                              ...c.grades
                                  .filter(
                                      (g) =>
                                          g.arm === r.arm &&
                                          g.item === r.item &&
                                          g.inputs.join("\n") === r.inputs.join("\n"),
                                  )
                                  .map((g) => g.version),
                          )
                        : versions.get(`${r.arm}/${r.item}`);
                if (r.version !== latest)
                    bad.push(`${r.arm}/${r.item} reported at v${r.version}, not the latest`);
            }
        }
        const named = [...used]
            .sort(([a], [b]) => a - b)
            .map(([v, k]) => `v${v} for ${k}`)
            .join(", ");
        return outcome(n, bad, `grade records with increasing versions; the report uses ${named}`);
    },
    "SIM-L03": (runs) => {
        let n = 0;
        const bad: string[] = [];
        for (const c of runs) {
            const start = c.entries.find((e) => e.kind === "StartRun");
            const end = c.entries.find((e) => e.kind === "EndRun");
            if (!start || !end) continue;
            n++;
            if (!Number.isFinite(start.wall_ms) || !Number.isFinite(end.wall_ms)) {
                bad.push(`${c.g.run.dir} has a wall time that is not a number`);
                continue;
            }
            const span = end.wall_ms - start.wall_ms;
            if (span < 0) bad.push(`${c.g.run.dir} ended ${-span} ms before it started`);
            else if (span > c.g.run.prereg.liveness_bounds.tier_wall_budget_ms)
                bad.push(`${c.g.run.dir} took ${span} ms`);
        }
        return outcome(n, bad, "completed runs inside the tier's wall budget");
    },
};

/** Jitter allowed between a call's stamped scenario time and the clock the journal implies. */
const CLOCK_SLACK_MS = 5_000;

/**
 * The arm's scenario clock as a function of wall time, from its journal: at wall pace while a
 * turn or job is open, held while idle, and jumping where an entry says so. Undefined before
 * the first entry.
 */
function journalClock(journal: Entry[]): (wallMs: number) => number | undefined {
    const entries = [...journal]
        .filter((e) => Number.isFinite(e.wall_ms) && Number.isFinite(e.scenario_ms))
        .sort((a, b) => a.seq - b.seq);
    const busyAfter: boolean[] = [];
    const open = new Set<string>();
    for (const e of entries) {
        if (e.kind === "BeginTurn") open.add(`turn:${String(e.event)}`);
        if (e.kind === "EndTurn" || e.state === "failed(interrupted)")
            open.delete(`turn:${String(e.event)}`);
        if (e.kind === "RegisterJob") open.add(`job:${String(e.job)}`);
        if (e.kind === "EndJob") open.delete(`job:${String(e.job)}`);
        busyAfter.push(open.size > 0);
    }
    return (wallMs) => {
        let i = -1;
        for (let k = 0; k < entries.length; k++) {
            if ((entries[k] as Entry).wall_ms <= wallMs) i = k;
        }
        if (i < 0) return undefined;
        const e = entries[i] as Entry;
        return busyAfter[i] ? e.scenario_ms + (wallMs - e.wall_ms) : e.scenario_ms;
    };
}

/** Wall time of the journaled `Event` that ended `session` in this arm, if it happened. */
function windowClose(c: Ctx, journal: Entry[], session: string): number | undefined {
    const end = c.g.scenario.events.find((e) => e.kind === "session_end" && e.session === session);
    if (!end) return undefined;
    return journal.find((e) => e.kind === "Event" && e.event === end.id)?.wall_ms;
}

type JournalReport = ReturnType<typeof checkJournal>;
const jumps = (r: JournalReport) => r.next_event_jumps + r.sleep_jumps;

function journalCheck(
    runs: Ctx[],
    pick: (r: JournalReport) => unknown[],
    count: (r: JournalReport) => number,
    what: string,
) {
    let n = 0;
    const bad: string[] = [];
    for (const { g, entries: written } of runs) {
        // The checks read the journal in seq order; a repeated or non-integer seq is a break.
        const entries = [...written].sort((a, b) => a.seq - b.seq);
        entries.forEach((e, i) => {
            if (!Number.isInteger(e.seq)) bad.push(`${g.run.dir} seq ${JSON.stringify(e.seq)}`);
            else if (i > 0 && entries[i - 1]?.seq === e.seq)
                bad.push(`${g.run.dir} seq ${e.seq} twice`);
        });
        const events = new Map(g.scenario.events.map((e) => [e.id, e.scenario_ms as number]));
        const sleeps = new Map(
            g.scenario.faults
                .filter((f) => f.type === "laptop_sleep")
                .map((f) => [f.id, f.params.duration_ms ?? 0]),
        );
        const report = checkJournal(entries, { events, sleeps });
        n += count(report);
        bad.push(...pick(report).map((x) => `${g.run.dir} seq ${JSON.stringify(x)}`));
    }
    return outcome(n, bad, what);
}

export function propertyWitness(catalog: string, runs: GradedRun[]): PropertyWitness[] {
    const ctx = runs.map(context);
    return [...catalog.matchAll(/^\| (SIM-[A-Z]\d+) \|/gm)].map(([, id]) => {
        const check = CHECKS[id as string];
        const result = check
            ? check(ctx)
            : { status: "unchecked" as const, detail: "no run-level check" };
        return { id: id as string, ...result };
    });
}
