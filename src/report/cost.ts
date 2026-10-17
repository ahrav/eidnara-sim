import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { HARNESS } from "../oracle/oracles";
import type { CallRecord } from "../proxy/records";
import { readJournal } from "../run/journal";
import type { Price } from "../run/price";
import { notesOf } from "./intrusive";

export interface ComponentCost {
    component: string;
    calls: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    usd: number;
}

export interface CostPanel {
    arm: string;
    price_table: string;
    components: ComponentCost[];
    /** The arm's token totals summed over its calls directly, for SIM-P38's conservation check. */
    tokens: { input: number; output: number; cache_read: number; cache_write: number };
    usd: number;
    harness_usd: number;
    /**
     * Passing P1 to P12 items at their latest version; an item judged in several pairs (the host
     * arm's P7 against each memory arm) passes when its latest grade in every pair passes. `null`
     * until `grade-summary.json` shows a grading pass that finished with no judge error over the
     * journal as it stands, since a prefix of `grades.jsonl`, or a pass over a run later resumed,
     * would count as a verified total.
     */
    passes: number | null;
    usd_per_pass: number | null;
    memory_writes: number | null;
    writes_with_zero_reads: number | null;
}

const USEFUL = /^P(?:[1-9]|1[0-2])$/;

type Tokens = Pick<
    CallRecord,
    "component" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"
>;

function componentCosts(calls: readonly Tokens[], price: Price): ComponentCost[] {
    const byComponent = new Map<string, ComponentCost>();
    for (const c of calls) {
        const row = byComponent.get(c.component) ?? {
            component: c.component,
            calls: 0,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            usd: 0,
        };
        row.calls++;
        row.input += c.input_tokens;
        row.output += c.output_tokens;
        row.cache_read += c.cache_read_tokens;
        row.cache_write += c.cache_write_tokens;
        row.usd +=
            (c.input_tokens * price.input +
                c.output_tokens * price.output +
                c.cache_read_tokens * price.cache_read +
                c.cache_write_tokens * price.cache_write) /
            1e6;
        byComponent.set(c.component, row);
    }
    return [...byComponent.values()].sort((a, b) => b.usd - a.usd);
}

/**
 * The run's P7 judge spend from `judge-calls.jsonl`, which the grader writes under its own arm
 * `judge`; a judge call compares two arms, so it belongs to the run. `null` when none was written,
 * the run recorded no price table, or grading did not finish (a request in flight at a kill may
 * be billed with no record).
 */
export function judgeCost(run: RunLogs): ComponentCost | null {
    const path = join(run.dir, "judge-calls.jsonl");
    if (run.price === null || !existsSync(path) || !gradingComplete(run)) return null;
    const calls = readJournal(path) as unknown as Tokens[];
    return componentCosts(calls, run.price.rates).find((c) => c.component === "judge") ?? null;
}

/**
 * Whether `scripts/grade-run.ts` finished over this run's journal, as it stands, with every judge
 * call answered and every useful item graded: a run resumed after grading has a later
 * `journal_seq` than the summary names, and a skipped item (no journaled snapshot, a P7 pair
 * without two completed snapshots) leaves the pass count short.
 */
function gradingComplete(run: RunLogs): boolean {
    const path = join(run.dir, "grade-summary.json");
    if (!existsSync(path)) return false;
    const summary = JSON.parse(readFileSync(path, "utf8")) as {
        judge_errors?: number;
        journal_seq?: number;
        skipped?: Record<string, number>;
    };
    const covered = Object.entries(summary.skipped ?? {}).every(
        ([why, n]) => why === UNGRADED_BY_DESIGN || n === 0,
    );
    return summary.judge_errors === 0 && summary.journal_seq === run.journal_seq && covered;
}

/** The grader's one skip reason that leaves no useful item ungraded: P14 items have no probe turn. */
const UNGRADED_BY_DESIGN = "P14 has no probe turn";

/**
 * The arm's cost at the price table its run recorded; `null` for a run that recorded none, and
 * for an arm with an interrupted turn (`ItemState` `failed(interrupted)` naming its `event`),
 * whose provider request may have been billed with no `CallRecord` to price.
 */
export function costPanel(run: RunLogs, arm: ArmLogs, grades: GradeRecord[]): CostPanel | null {
    if (run.price === null) return null;
    const interrupted = arm.journal.some(
        (e) =>
            e.kind === "ItemState" &&
            e.state === "failed(interrupted)" &&
            typeof e.event === "string",
    );
    if (interrupted) return null;
    const components = componentCosts(arm.calls, run.price.rates);
    const sum = (rows: ComponentCost[]) => rows.reduce((s, c) => s + c.usd, 0);
    const usd = sum(components.filter((c) => !HARNESS.has(c.component)));
    const total = (field: keyof Tokens & `${string}_tokens`) =>
        arm.calls.reduce((n, c) => n + c[field], 0);
    const latest = new Map<string, GradeRecord>();
    for (const g of grades) {
        if (g.arm !== arm.arm) continue;
        const key = `${g.item}\u0000${g.pair ?? ""}`;
        const seen = latest.get(key);
        if (seen === undefined || g.version > seen.version) latest.set(key, g);
    }
    const byItem = new Map<string, GradeRecord[]>();
    for (const g of latest.values()) byItem.set(g.item, [...(byItem.get(g.item) ?? []), g]);
    const passes = gradingComplete(run)
        ? [...byItem.values()].filter(
              (gs) =>
                  gs.every((g) => g.verdict === "pass") &&
                  USEFUL.test((gs[0] as GradeRecord).probe_type),
          ).length
        : null;
    const notes = notesOf(run.dir, arm.arm);
    return {
        arm: arm.arm,
        price_table: run.price.version,
        components,
        tokens: {
            input: total("input_tokens"),
            output: total("output_tokens"),
            cache_read: total("cache_read_tokens"),
            cache_write: total("cache_write_tokens"),
        },
        usd,
        harness_usd: sum(components.filter((c) => HARNESS.has(c.component))),
        passes,
        usd_per_pass: passes === null || passes === 0 ? null : usd / passes,
        memory_writes: notes?.length ?? null,
        writes_with_zero_reads: notes ? notes.filter((n) => n.deliveries === 0).length : null,
    };
}
