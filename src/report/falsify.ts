import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJournal } from "../run/journal";
import type { FALSIFICATION } from "../stats/gate";
import type { PairingRecord } from "../usersim/usersim";
import type { GradedRun } from "./observe";

type Pairs = { control: number; treatment: number }[];

function byKey<T>(rows: T[], key: (r: T) => string, value: (r: T) => number): Map<string, number> {
    return new Map(rows.map((r) => [key(r), value(r)]));
}

function join2(c: Map<string, number>, t: Map<string, number>): Pairs {
    return [...c.keys()]
        .filter((k) => t.has(k))
        .map((k) => ({ control: c.get(k) as number, treatment: t.get(k) as number }));
}

export function falsificationPairs(
    g: GradedRun,
    control: string,
    treatment: string,
): Record<(typeof FALSIFICATION)[number], Pairs> {
    const arm = (a: string) => g.run.arms.find((x) => x.arm === a);
    const facts = (a: string) =>
        byKey(
            g.grades.filter(
                (r) => r.arm === a && r.probe_type === "P1-control" && r.verdict !== "excluded",
            ),
            (r) => r.item,
            (r) => Number(r.verdict === "pass"),
        );
    const faulted = new Set(g.scenario.faults.map((f) => f.trigger.session));
    const fourxx = (a: string) => {
        const calls = (arm(a)?.calls ?? []).filter(
            (c) => c.session && !faulted.has(c.session.replace(/^sim-/, "")),
        );
        const sessions = [...new Set(calls.map((c) => c.session as string))];
        return byKey(
            sessions,
            (s) => s,
            (s) => {
                const mine = calls.filter((c) => c.session === s);
                return mine.filter((c) => c.status >= 400 && c.status < 500).length / mine.length;
            },
        );
    };
    const path = join(g.run.dir, "pairing.jsonl");
    // SAFETY: This assertion requires every pairing.jsonl record to match PairingRecord.
    const pairing = existsSync(path) ? (readJournal(path) as unknown as PairingRecord[]) : [];
    const pushback = (a: string) => {
        const cut = new Map(
            pairing
                .filter((r) => r.kind === "divergedAt" && r.arm === treatment)
                .map((r) => [r.session, r.index]),
        );
        const turns = pairing.filter(
            (r) =>
                r.kind === "turn" &&
                r.arm === a &&
                r.delivered &&
                r.index < (cut.get(r.session) ?? Infinity),
        );
        const sessions = [...new Set(turns.map((r) => r.session))];
        return byKey(
            sessions,
            (s) => s,
            (s) => {
                const mine = turns.filter((r) => r.session === s);
                return (
                    mine.filter((r) => r.kind === "turn" && r.label === "pushback").length /
                    mine.length
                );
            },
        );
    };
    const gaps = (a: string) => {
        const journal = arm(a)?.journal ?? [];
        let completed: number | null = null;
        const jumps: { next: string; gap: number }[] = [];
        for (const e of journal) {
            if (e.kind === "AdvanceClock" && e.next_event && completed !== null) {
                jumps.push({ next: String(e.next_event), gap: e.wall_ms - completed });
            }
            if (e.kind === "Event") completed = e.wall_ms;
        }
        return byKey(
            jumps,
            (j) => j.next,
            (j) => j.gap,
        );
    };
    return {
        in_session_repo_readable_fact_pass: join2(facts(control), facts(treatment)),
        gateway_4xx_rate_without_faults: join2(fourxx(control), fourxx(treatment)),
        pre_divergence_pushback_rate: join2(pushback(control), pushback(treatment)),
        wall_ms_per_scripted_idle_gap: join2(gaps(control), gaps(treatment)),
    };
}
