import { Rng } from "../rng";
import {
    betaQuantile,
    binomialCdf,
    digammaDiff,
    logGammaDiff,
    normalCdf,
    normalQuantile,
} from "./dist";

function counts(fn: string, values: readonly number[]): void {
    if (!values.every((v) => Number.isInteger(v) && v >= 0))
        throw new RangeError(`${fn}: counts must be nonnegative integers`);
}

const TRIALS_MAX = 1e8;

function trials(fn: string, n: number): void {
    if (n > TRIALS_MAX) throw new RangeError(`${fn}: at most ${TRIALS_MAX} trials`);
}

function level(fn: string, alpha: number): void {
    if (!(alpha > 0 && alpha < 1)) throw new RangeError(`${fn}: alpha must lie in (0, 1)`);
}

/** Two-sided exact binomial test of `x` successes in `n` at one half: the sign test. */
export function signTest(x: number, n: number): number {
    counts("signTest", [x, n]);
    trials("signTest", n);
    if (x > n) throw new RangeError("signTest: more successes than trials");
    if (n === 0) return 1;
    return Math.min(1, 2 * binomialCdf(Math.min(x, n - x), n, 0.5));
}

export interface McNemar {
    b: number;
    c: number;
    p: number;
    odds_ratio: number;
    /** Central Clopper-Pearson limits for b / (b + c), mapped to the odds ratio. */
    ci: [number, number];
}

/** The exact McNemar test on the discordant counts, with R `exact2x2::mcnemar.exact` limits. */
export function mcnemarExact(b: number, c: number, alpha = 0.05): McNemar {
    counts("mcnemarExact", [b, c]);
    trials("mcnemarExact", b + c);
    level("mcnemarExact", alpha);
    const n = b + c;
    const lo = b === 0 ? 0 : betaQuantile(alpha / 2, b, c + 1);
    const hi = c === 0 ? 1 : betaQuantile(1 - alpha / 2, b + 1, c);
    const odds = (p: number) => (p >= 1 ? Number.POSITIVE_INFINITY : p / (1 - p));
    return {
        b,
        c,
        p: signTest(b, n),
        odds_ratio: n === 0 ? Number.NaN : c === 0 ? Number.POSITIVE_INFINITY : b / c,
        ci: [odds(lo), odds(hi)],
    };
}

function wilson(x: number, n: number, z: number): [number, number] {
    const half = 0.5 * z * Math.sqrt(z * z + (4 * x * (n - x)) / n);
    return [(x + 0.5 * z * z - half) / (n + z * z), (x + 0.5 * z * z + half) / (n + z * z)];
}

/**
 * Newcombe's (1998) method 10 interval for the paired difference `(a + b - a - c) / n` of a
 * table with `a` both, `b` first only, `c` second only, and `d` neither.
 */
export function newcombe(
    a: number,
    b: number,
    c: number,
    d: number,
    alpha = 0.05,
): [number, number] {
    const n = a + b + c + d;
    if (n === 0) throw new RangeError("newcombe: an empty table has no difference");
    counts("newcombe", [a, b, c, d]);
    level("newcombe", alpha);
    const z = -normalQuantile(alpha / 2);
    const [p1, p2] = [(a + b) / n, (a + c) / n];
    const [l1, u1] = wilson(a + b, n, z);
    const [l2, u2] = wilson(a + c, n, z);
    const denom = (a + b) * (c + d) * (a + c) * (b + d);
    let num = a * d - b * c;
    if (num > 0) num = Math.max(num - n / 2, 0);
    const phi = denom === 0 ? 0 : num / Math.sqrt(denom);
    const [dl1, du1, dl2, du2] = [p1 - l1, u1 - p1, p2 - l2, u2 - p2];
    return [
        p1 - p2 - Math.sqrt(dl1 ** 2 - 2 * phi * dl1 * du2 + du2 ** 2),
        p1 - p2 + Math.sqrt(du1 ** 2 - 2 * phi * du1 * dl2 + dl2 ** 2),
    ];
}

/**
 * Holm's step-down adjusted p-values, in the input order. A NaN input stays NaN and still
 * counts toward the family size, preserving the correction strength for observed hypotheses.
 */
export function holm(ps: readonly number[]): number[] {
    if (!ps.every((p) => Number.isNaN(p) || (p >= 0 && p <= 1)))
        throw new RangeError("holm: p-values must lie in [0, 1] or be NaN");
    const order = ps
        .map((p, i) => [p, i] as const)
        .filter(([p]) => !Number.isNaN(p))
        .sort((x, y) => x[0] - y[0]);
    const out = new Array<number>(ps.length).fill(Number.NaN);
    let running = 0;
    order.forEach(([p, i], k) => {
        running = Math.max(running, Math.min(1, (ps.length - k) * p));
        out[i] = running;
    });
    return out;
}

export interface Cusum {
    upper: number[];
    lower: number[];
    /** The 0-based index where the upper sum first exceeded `h`, or null. */
    signal_upper: number | null;
    /** The 0-based index where the lower sum first fell below `-h`, or null. */
    signal_lower: number | null;
}

/** The tabular two-sided CUSUM with reference value `k` and decision interval `h`. */
export function cusum(
    xs: readonly number[],
    target: number,
    k: number,
    h: number,
    head = 0,
): Cusum {
    if (![...xs, target, k, h, head].every(Number.isFinite))
        throw new RangeError("cusum: every observation and parameter must be finite");
    let [up, down] = [head, -head];
    const upper: number[] = [];
    const lower: number[] = [];
    let signal_upper: number | null = null;
    let signal_lower: number | null = null;
    xs.forEach((x, i) => {
        up = Math.max(0, up + x - target - k);
        down = Math.min(0, down + x - target + k);
        upper.push(up);
        lower.push(down);
        if (signal_upper === null && up > h) signal_upper = i;
        if (signal_lower === null && -down > h) signal_lower = i;
    });
    return { upper, lower, signal_upper, signal_lower };
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export interface Interval {
    estimate: number;
    lo: number;
    hi: number;
}

function percentile(sorted: number[], q: number): number {
    const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length + 1)) - 1));
    return sorted[at] ?? Number.NaN;
}

function resample<T>(xs: readonly T[], rng: Rng): T[] {
    return xs.map(() => xs[Math.floor(rng.next() * xs.length)] as T);
}

/** The jackknife acceleration of BCa (Efron and Tibshirani, 1993, eq. 14.15). */
export function acceleration<T>(xs: readonly T[], stat: (s: T[]) => number): number {
    if (xs.length < 2) return 0;
    const jack = xs.map((_, i) => stat(xs.filter((__, j) => j !== i)));
    const m = mean(jack);
    const num = jack.reduce((s, t) => s + (m - t) ** 3, 0);
    const den = jack.reduce((s, t) => s + (m - t) ** 2, 0);
    return den === 0 ? 0 : num / (6 * den ** 1.5);
}

/** A seeded nonparametric bootstrap interval: percentile, or BCa. */
export function bootstrap<T>(
    xs: readonly T[],
    stat: (s: T[]) => number,
    o: { replicates: number; seed: number; alpha?: number; bca?: boolean },
): Interval & { z0?: number; a?: number } {
    if (xs.length === 0) throw new RangeError("bootstrap: an empty sample has no interval");
    if (!(Number.isInteger(o.replicates) && o.replicates > 0))
        throw new RangeError("bootstrap: replicates must be a positive integer");
    const alpha = o.alpha ?? 0.05;
    level("bootstrap", alpha);
    const estimate = stat([...xs]);
    const rng = new Rng(o.seed);
    const reps = Array.from({ length: o.replicates }, () => stat(resample(xs, rng))).sort(
        (x, y) => x - y,
    );
    if (![estimate, ...reps].every(Number.isFinite))
        return { estimate, lo: Number.NaN, hi: Number.NaN };
    if (!o.bca)
        return { estimate, lo: percentile(reps, alpha / 2), hi: percentile(reps, 1 - alpha / 2) };
    const below = Math.min(
        reps.length - 0.5,
        Math.max(
            0.5,
            reps.filter((r) => r < estimate).length + reps.filter((r) => r === estimate).length / 2,
        ),
    );
    const z0 = normalQuantile(below / reps.length);
    const a = acceleration(xs, stat);
    const adjust = (q: number) => {
        const z = normalQuantile(q);
        const scale = 1 - a * (z0 + z);
        return scale > 0 ? normalCdf(z0 + (z0 + z) / scale) : Number.NaN;
    };
    const [qlo, qhi] = [adjust(alpha / 2), adjust(1 - alpha / 2)];
    const ordered = qlo <= qhi;
    return {
        estimate,
        lo: ordered ? percentile(reps, qlo) : Number.NaN,
        hi: ordered ? percentile(reps, qhi) : Number.NaN,
        z0,
        a,
    };
}

/** `m` must be symmetric positive-definite. */
function cholesky(m: number[][]): number[][] {
    const n = m.length;
    const l = m.map(() => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = (m[i] as number[])[j] as number;
            for (let k = 0; k < j; k++)
                s -= ((l[i] as number[])[k] as number) * ((l[j] as number[])[k] as number);
            (l[i] as number[])[j] = i === j ? Math.sqrt(s) : s / ((l[j] as number[])[j] as number);
        }
    }
    return l;
}

/** `l` must be a lower Cholesky factor; `substitute` solves `(l * lᵀ) * x = v`. */
function substitute(l: number[][], v: number[]): number[] {
    const n = v.length;
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
        let s = v[i] as number;
        for (let k = 0; k < i; k++) s -= ((l[i] as number[])[k] as number) * (y[k] as number);
        y[i] = s / ((l[i] as number[])[i] as number);
    }
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i] as number;
        for (let k = i + 1; k < n; k++) s -= ((l[k] as number[])[i] as number) * (x[k] as number);
        x[i] = s / ((l[i] as number[])[i] as number);
    }
    return x;
}

function solve(m: number[][], v: number[]): number[] {
    return substitute(cholesky(m), v);
}

export interface NegBinFit {
    coefficients: number[];
    /** Standard errors from the inverse of the final weighted cross-product. */
    se: number[];
    theta: number;
    /**
     * False when an iteration limit ran out, a number is not finite, or the arms separate (a
     * fitted log-mean past 30 in magnitude); its numbers are then not estimates.
     */
    converged: boolean;
}

/** Above this theta the counts carry no overdispersion, and the fit is Poisson. */
const THETA_MAX = 1e8;

const THETA_MIN = 1e-8;

function weightedCross(x: number[][], w: number[], v?: number[]): number[][] {
    const p = (x[0] ?? []).length;
    const column = (a: number, b: (row: number[], i: number) => number) =>
        x.reduce((s, row, i) => s + (row[a] as number) * (w[i] as number) * b(row, i), 0);
    if (v) return [Array.from({ length: p }, (_, a) => column(a, (_, i) => v[i] as number))];
    return Array.from({ length: p }, (_, a) =>
        Array.from({ length: p }, (_, b) => column(a, (row) => row[b] as number)),
    );
}

/**
 * The derivative of the log-likelihood in theta at fixed means `m`. The rearranged terms
 * reduce cancellation at large `t`.
 */
function thetaScore(y: number[], m: number[], t: number): number {
    return y.reduce((s, yi, j) => {
        const u = m[j] as number;
        return s + digammaDiff(t, yi) - Math.log1p(u / t) + (u - yi) / (t + u);
    }, 0);
}

/** The log-likelihood at fixed means `m`, up to terms free of theta. */
function thetaLogLik(y: number[], m: number[], t: number): number {
    return y.reduce((s, yi, j) => {
        const u = m[j] as number;
        const tail = yi > 0 ? yi * Math.log(u / (t + u)) : 0;
        return s + logGammaDiff(t, yi) - t * Math.log1p(u / t) + tail;
    }, 0);
}

const THETA_GRID = 65;

/**
 * `thetaAt` selects the highest-likelihood candidate at fixed means `m`. The score can cross
 * zero more than once, so every downward crossing on a log-theta grid is bisected; `THETA_MAX`
 * joins the candidates when the large-theta limit `-sum((y - m)^2 - y) / (2 theta^2)` is
 * nonnegative, and `THETA_MIN` when the score starts nonpositive.
 */
function thetaAt(y: number[], m: number[]): number {
    const [lo, hi] = [Math.log(THETA_MIN), Math.log(THETA_MAX)];
    const grid = Array.from(
        { length: THETA_GRID },
        (_, i) => lo + ((hi - lo) * i) / (THETA_GRID - 1),
    );
    const scores = grid.map((g) => thetaScore(y, m, Math.exp(g)));
    const root = (a: number, b: number) => {
        let [l, h] = [a, b];
        for (let i = 0; i < 100 && h - l > 1e-12; i++) {
            const mid = (l + h) / 2;
            if (thetaScore(y, m, Math.exp(mid)) > 0) l = mid;
            else h = mid;
        }
        return Math.exp((l + h) / 2);
    };
    const candidates: number[] = [];
    if ((scores[0] as number) <= 0) candidates.push(THETA_MIN);
    for (let i = 0; i + 1 < THETA_GRID; i++)
        if ((scores[i] as number) > 0 && (scores[i + 1] as number) <= 0)
            candidates.push(root(grid[i] as number, grid[i + 1] as number));
    const excess = y.reduce((s, yi, j) => s + (yi - (m[j] as number)) ** 2 - yi, 0);
    if (excess <= 0 || candidates.length === 0) candidates.push(THETA_MAX);
    return candidates.reduce((best, t) =>
        thetaLogLik(y, m, t) > thetaLogLik(y, m, best) ? t : best,
    );
}

/**
 * A negative-binomial GLM with log link, fitted as R `MASS::glm.nb` does: iteratively
 * reweighted least squares for the coefficients alternating with the theta that maximises
 * the likelihood at the current means.
 */
export function negativeBinomial(x: number[][], y: number[], iterations = 200): NegBinFit {
    const p = (x[0] ?? []).length;
    if (y.length === 0 || p === 0)
        throw new RangeError("negativeBinomial: an empty design has no fit");
    if (x.length !== y.length)
        throw new RangeError("negativeBinomial: the design and the response differ in length");
    if (x.some((row) => row.length !== p || !row.every(Number.isFinite)))
        throw new RangeError("negativeBinomial: every design row needs the same finite columns");
    if (!(Number.isInteger(iterations) && iterations > 0))
        throw new RangeError("negativeBinomial: iterations must be a positive integer");
    counts("negativeBinomial", y);
    let beta = new Array<number>(p).fill(0);
    let m = y.map((v) => v + 0.1);
    let theta = 1;
    let settled = false;
    const weights = () => m.map((u) => u / (1 + u / theta));
    for (let outer = 0; outer < iterations; outer++) {
        let stable = false;
        for (let inner = 0; inner < 25 && !stable; inner++) {
            const w = weights();
            const z = m.map((u, i) => Math.log(u) + ((y[i] as number) - u) / u);
            beta = solve(weightedCross(x, w), weightedCross(x, w, z)[0] as number[]);
            const eta = x.map((row) => row.reduce((s, v, j) => s + v * (beta[j] as number), 0));
            const moved = eta.reduce(
                (s, e, i) => Math.max(s, Math.abs(e - Math.log(m[i] as number))),
                0,
            );
            m = eta.map(Math.exp);
            stable = moved < 1e-10;
        }
        const t = thetaAt(y, m);
        const done =
            stable && (Math.abs(t - theta) < 1e-8 * theta || Math.abs(1 / t - 1 / theta) < 1e-12);
        theta = t;
        if (done) {
            settled = true;
            break;
        }
    }
    const factor = cholesky(weightedCross(x, weights()));
    const se = beta.map((_, j) =>
        Math.sqrt(
            substitute(
                factor,
                beta.map((__, k) => Number(k === j)),
            )[j] as number,
        ),
    );
    const finite = [...beta, ...se, theta].every(Number.isFinite);
    const converged = settled && finite && m.every((u) => Math.abs(Math.log(u)) <= 30);
    return { coefficients: beta, se, theta, converged };
}
