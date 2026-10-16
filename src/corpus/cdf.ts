import type { Rng } from "../rng";

/**
 * An empirical distribution as (probability, value) points. A `discrete`
 * table holds every distinct count with its cumulative probability rounded to
 * nine decimal places and inverts as a step function. A `continuous` table
 * holds quantiles at fixed probabilities and interpolates linearly between them.
 */
export interface CdfTable {
    kind: "discrete" | "continuous";
    p: number[];
    x: number[];
}

const TAIL = [0.991, 0.992, 0.993, 0.994, 0.996, 0.997, 0.998, 0.999, 0.9995, 0.9999];
export const GRID: readonly number[] = [
    ...Array.from({ length: 201 }, (_, i) => i / 200),
    ...TAIL,
].sort((a, b) => a - b);

/**
 * Continuous tables use linear interpolation between order statistics, the
 * definition DuckDB's `quantile_cont` uses.
 */
export function fitCdf(values: readonly number[], kind: CdfTable["kind"]): CdfTable {
    if (values.length === 0) throw new Error("fitCdf: no observations");
    const sorted = Float64Array.from(values).sort();
    const n = sorted.length;
    if (kind === "discrete") {
        const p: number[] = [];
        const x: number[] = [];
        sorted.forEach((v, i) => {
            if (sorted[i + 1] === v) return;
            p.push(Math.round(((i + 1) / n) * 1e9) / 1e9);
            x.push(v);
        });
        return { kind, p, x };
    }
    const at = (i: number) => sorted[Math.min(n - 1, i)] ?? 0;
    const x = GRID.map((p) => {
        const h = (n - 1) * p;
        const lo = Math.floor(h);
        return round3(at(lo) + (h - lo) * (at(lo + 1) - at(lo)));
    });
    return { kind, p: [...GRID], x };
}

/** Inverse CDF at probability `q` in [0, 1]. */
export function quantile(table: CdfTable, q: number): number {
    const { p, x } = table;
    let hi = p.findIndex((pi) => pi >= q);
    if (hi < 0) hi = p.length - 1;
    const xHi = x[hi] ?? 0;
    if (table.kind === "discrete" || hi === 0) return xHi;
    const pLo = p[hi - 1] ?? 0;
    const pHi = p[hi] ?? 1;
    const xLo = x[hi - 1] ?? 0;
    return round3(xLo + ((q - pLo) / (pHi - pLo)) * (xHi - xLo));
}

/** Draws from the table, or from its tail above probability `floor`. */
export function sample(table: CdfTable, rng: Rng, floor = 0): number {
    return quantile(table, floor + (1 - floor) * rng.next());
}

/** Probability mass at or above `v`; a continuous table interpolates its CDF at `v`. */
export function tailShare(table: CdfTable, v: number): number {
    const { p, x } = table;
    const hi = x.findIndex((xi) => xi >= v);
    if (hi < 0) return 0;
    if (hi === 0) return 1;
    const [pLo, pHi, xLo, xHi] = [p[hi - 1] ?? 0, p[hi] ?? 1, x[hi - 1] ?? 0, x[hi] ?? 0];
    if (table.kind === "discrete") return 1 - pLo;
    return 1 - (pLo + ((v - xLo) / (xHi - xLo)) * (pHi - pLo));
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}
