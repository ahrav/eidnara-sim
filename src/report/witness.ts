import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GradeLog } from "../grade/probes";
import { readJournal } from "../run/journal";
import { checkJournal } from "../run/journal-check";
import { referenceArm } from "../run/run";
import { LABELS } from "../usersim/plan";
import { type PairingRecord, pairingMismatches } from "../usersim/usersim";
import type { GradedRun } from "./observe";

export type Witness = "witnessed" | "unreached" | "violated";

export interface PropertyWitness {
    id: string;
    name: string;
    status: Witness;
    detail: string;
}

type Check = (runs: GradedRun[]) => { status: Witness; detail: string };

const outcome = (instances: number, bad: string[], what: string) =>
    bad.length > 0
        ? { status: "violated" as const, detail: bad.slice(0, 5).join("; ") }
        : instances === 0
          ? { status: "unreached" as const, detail: `no ${what}` }
          : { status: "witnessed" as const, detail: `${instances} ${what}` };

const pairing = (g: GradedRun) => {
    const path = join(g.run.dir, "pairing.jsonl");
    return existsSync(path) ? (readJournal(path) as unknown as PairingRecord[]) : [];
};
const manifestOf = (g: GradedRun) =>
    JSON.parse(readFileSync(join(g.run.dir, "manifest.json"), "utf8")) as {
        order: string[];
        events: number;
    };
const journalOf = (g: GradedRun) => g.run.arms.flatMap((a) => a.journal);

const CHECKS: Record<string, Check> = {
    "SIM-P02": (runs) => {
        const bad = runs.flatMap((g) =>
            pairingMismatches(pairing(g), referenceArm(manifestOf(g).order)),
        );
        const n = runs.reduce((s, g) => s + pairing(g).filter((r) => r.kind === "turn").length, 0);
        return outcome(n, bad, "paired user turns");
    },
    "SIM-P03": (runs) => {
        const bad: string[] = [];
        let n = 0;
        for (const g of runs) {
            const records = pairing(g);
            records.forEach((r, i) => {
                if (r.kind !== "divergedAt") return;
                n++;
                const turn = records.findIndex(
                    (x) => x.kind === "turn" && x.arm === r.arm && x.event === r.event,
                );
                if (turn >= 0 && turn < i) bad.push(`${r.arm} ${r.event}`);
            });
        }
        return outcome(n, bad, "divergence records, each ahead of its turn");
    },
    "SIM-P04": (runs) => {
        const n = runs.reduce(
            (s, g) => s + pairing(g).filter((r) => r.kind === "divergedAt").length,
            0,
        );
        return outcome(n, [], "divergences");
    },
    "SIM-P10": (runs) => {
        const capped = runs.some((g) => manifestOf(g).events < g.scenario.events.length);
        if (capped)
            return {
                status: "unreached",
                detail: "a capped prefix cannot match whole-scenario rates",
            };
        const rates = runs.flatMap((g) => journalOf(g).filter((e) => e.kind === "UserSimRates"));
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
        const calls = runs.flatMap((g) => g.run.arms.flatMap((a) => a.calls));
        const bad = calls
            .filter((c) => !Number.isFinite(c.scenario_ms) || !Number.isFinite(c.wall_ms))
            .map((c) => `call ${c.seq}`);
        return outcome(calls.length, bad, "proxy records with both times");
    },
    "SIM-P25": (runs) => {
        const turns = runs.flatMap((g) => journalOf(g).filter((e) => e.kind === "UserTurn"));
        const bad = turns
            .filter((e) => !(LABELS as readonly string[]).includes(String(e.label)))
            .map((e) => String(e.event));
        return outcome(turns.length, bad, "labelled user turns");
    },
    "SIM-P30": (runs) => {
        const observed = runs.flatMap((g) =>
            journalOf(g)
                .filter((e) => e.kind === "FaultObserved")
                .map((e) => ({
                    id: String(e.fault),
                    known: g.scenario.faults.some((f) => f.id === e.fault),
                })),
        );
        return outcome(
            observed.length,
            observed.filter((o) => !o.known).map((o) => o.id),
            "observed faults, all scheduled",
        );
    },
    "SIM-P41": (runs) => {
        const seen = new Map<string, number>();
        for (const g of runs) {
            for (const e of journalOf(g).filter((x) => x.kind === "SnapshotArtefacts")) {
                const key = `${g.run.dir}/${e.arm}/${e.item}`;
                seen.set(key, (seen.get(key) ?? 0) + 1);
            }
        }
        const bad = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
        return outcome(seen.size, bad, "item snapshots set once");
    },
    "SIM-P42": (runs) => {
        let n = 0;
        const bad: string[] = [];
        for (const g of runs) {
            const path = join(g.run.dir, "grades.jsonl");
            if (!existsSync(path)) continue;
            const versions = new Map<string, number>();
            for (const r of new GradeLog(path).all()) {
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
    runs: GradedRun[],
    pick: (r: JournalReport) => unknown[],
    count: (r: JournalReport) => number,
    what: string,
) {
    let n = 0;
    const bad: string[] = [];
    for (const g of runs) {
        const entries = readJournal(join(g.run.dir, "journal.jsonl"));
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
    return [...catalog.matchAll(/^\| (SIM-P\d+) \| \[([^\]]+)\]/gm)].map(([, id, name]) => {
        const check = CHECKS[id as string];
        const result = check
            ? check(runs)
            : { status: "unreached" as const, detail: "no run-level check" };
        return { id: id as string, name: name as string, ...result };
    });
}
