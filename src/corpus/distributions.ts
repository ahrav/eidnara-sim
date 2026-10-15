import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CdfTable } from "./cdf";
import type { Quantity, ToolCategory } from "./fit";
import { CORPUS_DIR } from "./sources";

export interface Distributions {
    schema: string;
    quantities: Record<string, Quantity>;
    tool_mix: { source: string; n: number; categories: ToolCategory[] };
    rates: Record<string, unknown>;
}

export interface CitedCheck {
    quantity: string;
    q: number;
    cited: number;
    deviation?: string;
}

export interface Cited {
    rel: number;
    checks: CitedCheck[];
    tail_checks: { quantity: string; threshold: number; min_share: number }[];
}

export interface CheckResult extends CitedCheck {
    measured: number;
    low: number;
    high: number;
    within: boolean;
}

export function loadDistributions(): Distributions {
    return JSON.parse(readFileSync(join(CORPUS_DIR, "distributions.json"), "utf8"));
}

export function loadCited(): Cited {
    return JSON.parse(readFileSync(join(CORPUS_DIR, "cited-percentiles.json"), "utf8"));
}

export function table(dist: Distributions, name: string): CdfTable {
    const quantity = dist.quantities[name];
    if (quantity === undefined) throw new Error(`distributions.json: quantity ${name} missing`);
    return quantity.cdf;
}

/** `measure` lets fitted-table percentiles and sampler percentiles use the same tolerance bands. */
export function compareCited(
    cited: Cited,
    measure: (quantity: string, q: number) => number,
): CheckResult[] {
    return cited.checks.map((check) => {
        const measured = measure(check.quantity, check.q);
        const low = check.cited * (1 - cited.rel);
        const high = check.cited * (1 + cited.rel);
        return { ...check, measured, low, high, within: measured >= low && measured <= high };
    });
}

/** An in-band check that still carries a deviation also fails, so stale deviation notes surface. */
export function failedChecks(results: readonly CheckResult[]): CheckResult[] {
    return results.filter((r) => r.within === (r.deviation !== undefined));
}
