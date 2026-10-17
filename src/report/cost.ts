import type { GradeRecord } from "../grade/probes";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import { HARNESS } from "../oracle/oracles";
import { notesOf } from "./intrusive";

export interface Price {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
}

/** Default rates in USD per million tokens, applied to every model. */
export const V1_PRICE: Price = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };

export interface ComponentCost {
    component: string;
    calls: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    usd: number;
}

export const PRICE_TABLE = "v1";

export interface CostPanel {
    arm: string;
    price_table: string;
    components: ComponentCost[];
    usd: number;
    harness_usd: number;
    passes: number;
    usd_per_pass: number | null;
    memory_writes: number | null;
    writes_with_zero_reads: number | null;
}

const USEFUL = /^P(?:[1-9]|1[0-2])$/;

export function costPanel(run: RunLogs, arm: ArmLogs, grades: GradeRecord[]): CostPanel {
    const price = V1_PRICE;
    const byComponent = new Map<string, ComponentCost>();
    for (const c of arm.calls) {
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
    const components = [...byComponent.values()].sort((a, b) => b.usd - a.usd);
    const sum = (rows: ComponentCost[]) => rows.reduce((s, c) => s + c.usd, 0);
    const usd = sum(components.filter((c) => !HARNESS.has(c.component)));
    const passes = grades.filter(
        (g) => g.arm === arm.arm && g.verdict === "pass" && USEFUL.test(g.probe_type),
    ).length;
    const notes = notesOf(run.dir, arm.arm);
    return {
        arm: arm.arm,
        price_table: PRICE_TABLE,
        components,
        usd,
        harness_usd: sum(components.filter((c) => HARNESS.has(c.component))),
        passes,
        usd_per_pass: passes === 0 ? null : usd / passes,
        memory_writes: notes?.length ?? null,
        writes_with_zero_reads: notes ? notes.filter((n) => n.deliveries === 0).length : null,
    };
}
