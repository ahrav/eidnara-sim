import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GradeLog, type GradeRecord } from "../grade/probes";
import { canonicalJson } from "../prereg/canonical";
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
        fault_override?: FaultEpisode[] | null;
    };
    /** Digests by `arm/event` from the pairing logs of the tapes a replayed run took. */
    recorded: Map<string, string>;
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
    for (const tape of read.tapes ?? []) {
        for (const r of jsonl<PairingRecord>(join(dirname(tape), "pairing.jsonl"))) {
            if (r.kind === "turn") recorded.set(`${r.arm}/${r.event}`, r.digest);
        }
    }
    return {
        g,
        pairing: jsonl<PairingRecord>(join(g.run.dir, "pairing.jsonl")),
        manifest: read,
        recorded,
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
            // The property covers indices below the arm's divergence, as the mismatch check does.
            n += turns.filter(
                (r) =>
                    r.arm !== reference(r.arm) &&
                    keys.has(`${reference(r.arm)}/${r.event}`) &&
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
            c.pairing.forEach((r, i) => {
                if (r.kind !== "divergedAt") return;
                n++;
                const turn = c.pairing.findIndex(
                    (x) => x.kind === "turn" && x.arm === r.arm && x.event === r.event,
                );
                if (turn >= 0 && turn < i) bad.push(`${r.arm} ${r.event}`);
                const own = turnOf(r.arm, r.event);
                const other =
                    r.against === "reference"
                        ? turnOf(reference(r.arm), r.event)?.digest
                        : c.recorded.get(`${r.arm}/${r.event}`);
                if (
                    (own && own.digest !== r.digest) ||
                    (other !== undefined && other !== r.reference_digest)
                )
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
                let wall = Number.NEGATIVE_INFINITY;
                for (const call of [...a.calls].sort((x, y) => x.seq - y.seq)) {
                    n++;
                    if (!Number.isFinite(call.scenario_ms) || !Number.isFinite(call.wall_ms))
                        bad.push(`call ${call.seq} lacks a time`);
                    else if (call.wall_ms < wall) bad.push(`call ${call.seq} wall time decreases`);
                    wall = Math.max(wall, call.wall_ms);
                }
            }
        }
        return outcome(n, bad, "proxy records with both times, wall time in order");
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
                const injected = a.calls
                    .filter((x) => typeof x.fault_ref === "string")
                    .sort((x, y) => x.seq - y.seq);
                const counted = new Map<string, number>();
                for (const call of injected) {
                    n++;
                    const id = call.fault_ref as string;
                    const fault = faults.find((f) => f.id === id);
                    const before = fired.some(
                        (e) => e.fault === id && e.wall_ms <= call.started_wall_ms,
                    );
                    if (!fault || !before) {
                        bad.push(`call ${call.seq} names ${id}, not fired before it`);
                        continue;
                    }
                    // The window closes at the trigger session's end, and for a bounded fault
                    // after its count of calls.
                    const closed = windowClose(c, a.journal, fault.trigger.session);
                    if (closed !== undefined && call.started_wall_ms > closed)
                        bad.push(`call ${call.seq} names ${id} after its session ended`);
                    const seen = (counted.get(id) ?? 0) + 1;
                    counted.set(id, seen);
                    const limit =
                        fault.strategy === "persistent"
                            ? Number.POSITIVE_INFINITY
                            : (fault.params.count ?? fault.params.calls ?? 1);
                    if (seen > limit) bad.push(`call ${call.seq} names ${id} beyond its count`);
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
            for (const r of c.g.grades) {
                const s = seen.get(`${c.g.run.dir}/${r.arm}/${r.item}`);
                if (!s) bad.push(`${r.arm}/${r.item} graded without a journaled snapshot`);
                else if (s.snapshot !== undefined && s.snapshot !== r.snapshot)
                    bad.push(`${r.arm}/${r.item} grades ${r.snapshot}`);
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
                if (r.version <= (versions.get(key) ?? 0)) bad.push(key);
                versions.set(key, r.version);
            }
            for (const r of c.g.grades) {
                used.set(r.version, (used.get(r.version) ?? 0) + 1);
                if (r.version !== versions.get(`${r.arm}/${r.item}`))
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
            const span = end.wall_ms - start.wall_ms;
            if (span > c.g.run.prereg.liveness_bounds.tier_wall_budget_ms)
                bad.push(`${c.g.run.dir} took ${span} ms`);
        }
        return outcome(n, bad, "completed runs inside the tier's wall budget");
    },
};

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
    for (const { g, entries } of runs) {
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
