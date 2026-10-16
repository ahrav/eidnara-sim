import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CdfTable } from "./cdf";
import type { TraceLabFit } from "./fit";
import { CORPUS_DIR, parseJson } from "./sources";

export interface Distributions extends TraceLabFit {
    schema: string;
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
    const raw = parseJson<Distributions>(
        readFileSync(join(CORPUS_DIR, "distributions.json"), "utf8"),
        "distributions.json",
    );
    if (raw.schema !== "sim-corpus-distributions/v1") {
        throw new Error("distributions.json: unknown schema");
    }
    return raw;
}

export function loadCited(): Cited {
    const raw = parseJson<Cited & { schema?: string }>(
        readFileSync(join(CORPUS_DIR, "cited-percentiles.json"), "utf8"),
        "cited-percentiles.json",
    );
    if (raw.schema !== "sim-corpus-cited/v1")
        throw new Error("cited-percentiles.json: unknown schema");
    return raw;
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

export function waived(check: CitedCheck): boolean {
    return typeof check.deviation === "string" && check.deviation.trim() !== "";
}

/** An in-band check that still carries a deviation also fails, so stale deviation notes surface. */
export function failedChecks(results: readonly CheckResult[]): CheckResult[] {
    return results.filter((r) => r.within === waived(r));
}
