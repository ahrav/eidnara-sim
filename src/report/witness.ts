import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import { type Entry, readJsonl } from "../run/journal";
import { checkJournal } from "../run/journal-check";
import { referenceArm } from "../run/run";
import { LABELS } from "../usersim/plan";
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
    manifest: { order: string[]; events: number };
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

const jsonl = <T>(path: string): T[] => readJsonl<T>(path);

function context(g: GradedRun): Ctx {
    const grades = join(g.run.dir, "grades.jsonl");
    const manifest = join(g.run.dir, "manifest.json");
    return {
        g,
        pairing: jsonl<PairingRecord>(join(g.run.dir, "pairing.jsonl")),
        manifest: existsSync(manifest)
            ? JSON.parse(readFileSync(manifest, "utf8"))
            : { order: g.run.arms.map((a) => a.arm), events: g.scenario.events.length },
        entries: jsonl<Entry>(join(g.run.dir, "journal.jsonl")),
        grades: jsonl<GradeRecord>(grades),
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
        const n = runs.reduce((s, c) => s + c.pairing.filter((r) => r.kind === "turn").length, 0);
        return outcome(n, bad, "paired user turns");
    },
    "SIM-P03": (runs) => {
        const bad: string[] = [];
        let n = 0;
        for (const c of runs) {
            c.pairing.forEach((r, i) => {
                if (r.kind !== "divergedAt") return;
                n++;
                const turn = c.pairing.findIndex(
                    (x) => x.kind === "turn" && x.arm === r.arm && x.event === r.event,
                );
                if (turn >= 0 && turn < i) bad.push(`${r.arm} ${r.event}`);
            });
            bad.push(...hiddenDivergences(c));
        }
        return outcome(n, bad, "divergence records, each ahead of its turn, none hidden");
    },
    "SIM-P04": (runs) => {
        const n = runs.reduce(
            (s, c) => s + c.pairing.filter((r) => r.kind === "divergedAt").length,
            0,
        );
        return outcome(n, [], "divergences");
    },
    "SIM-P10": (runs) => {
        if (runs.some((c) => c.manifest.events < c.g.scenario.events.length))
            return {
                status: "unreached",
                detail: "a capped prefix cannot match whole-scenario rates",
            };
        const rates = runs.flatMap((c) => journalOf(c).filter((e) => e.kind === "UserSimRates"));
        const bad = rates
            .filter((e) => (e.outside as string[]).length > 0)
            .map((e) => `${e.arm}: ${e.outside}`);
        return outcome(rates.length, bad, "arms with realised rates");
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
        const observed = runs.flatMap((c) =>
            journalOf(c)
                .filter((e) => e.kind === "FaultObserved")
                .map((e) => ({
                    id: String(e.fault),
                    known: c.g.scenario.faults.some((f) => f.id === e.fault),
                })),
        );
        return outcome(
            observed.length,
            observed.filter((o) => !o.known).map((o) => o.id),
            "observed faults, all scheduled",
        );
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
            for (const r of c.g.grades) {
                const s = seen.get(`${c.g.run.dir}/${r.arm}/${r.item}`);
                if (s && s.snapshot !== undefined && s.snapshot !== r.snapshot)
                    bad.push(`${r.arm}/${r.item} grades ${r.snapshot}`);
            }
        }
        bad.unshift(...[...seen].filter(([, s]) => s.n > 1).map(([k]) => `${k} set twice`));
        return outcome(seen.size, bad, "item snapshots set once and cited by their grades");
    },
    "SIM-P42": (runs) => {
        let n = 0;
        const bad: string[] = [];
        for (const c of runs) {
            const versions = new Map<string, number>();
            for (const r of c.grades) {
                n++;
                const key = `${r.arm}/${r.item}`;
                if (r.version <= (versions.get(key) ?? 0)) bad.push(key);
                versions.set(key, r.version);
            }
        }
        return outcome(n, bad, "grade records with increasing versions");
    },
};

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
        const report = checkJournal(entries, { events });
        n += count(report);
        bad.push(...pick(report).map((x) => `${g.run.dir} seq ${JSON.stringify(x)}`));
    }
    return outcome(n, bad, what);
}

export function propertyWitness(catalog: string, runs: GradedRun[]): PropertyWitness[] {
    const ctx = runs.map(context);
    return [...catalog.matchAll(/^\| (SIM-P\d+) \|/gm)].map(([, id]) => {
        const check = CHECKS[id as string];
        const result = check
            ? check(ctx)
            : { status: "unchecked" as const, detail: "no run-level check" };
        return { id: id as string, ...result };
    });
}
