import { Rng } from "../rng";
import { betaQuantile, binomialCdf, digamma, normalCdf, normalQuantile } from "./dist";

/** Two-sided exact binomial test of `x` successes in `n` at one half: the sign test. */
export function signTest(x: number, n: number): number {
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
    const z = normalQuantile(1 - alpha / 2);
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

/** Holm's step-down adjusted p-values, in the input order. */
export function holm(ps: readonly number[]): number[] {
    const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
    const out = new Array<number>(ps.length);
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
    const alpha = o.alpha ?? 0.05;
    const estimate = stat([...xs]);
    const rng = new Rng(o.seed);
    const reps = Array.from({ length: o.replicates }, () => stat(resample(xs, rng))).sort(
        (x, y) => x - y,
    );
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
        return normalCdf(z0 + (z0 + z) / (1 - a * (z0 + z)));
    };
    return {
        estimate,
        lo: percentile(reps, adjust(alpha / 2)),
        hi: percentile(reps, adjust(1 - alpha / 2)),
        z0,
        a,
    };
}

/** Cholesky solve of a symmetric positive-definite system. */
function solve(m: number[][], v: number[]): number[] {
    const n = v.length;
    const l = m.map(() => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = (m[i] as number[])[j] as number;
            for (let k = 0; k < j; k++)
                s -= ((l[i] as number[])[k] as number) * ((l[j] as number[])[k] as number);
            (l[i] as number[])[j] = i === j ? Math.sqrt(s) : s / ((l[j] as number[])[j] as number);
        }
    }
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

export interface NegBinFit {
    coefficients: number[];
    /** Standard errors from the inverse of the final weighted cross-product. */
    se: number[];
    theta: number;
    /**
     * False when an iteration limit ran out, a number is not finite, or the arms separate (a
     * coefficient past 30 in magnitude); its numbers are then not estimates.
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

/** The derivative of the log-likelihood in theta at fixed means `m`. */
function thetaScore(y: number[], m: number[], t: number): number {
    return y.reduce((s, yi, j) => {
        const u = m[j] as number;
        return (
            s +
            digamma(yi + t) -
            digamma(t) +
            Math.log(t) +
            1 -
            Math.log(t + u) -
            (yi + t) / (t + u)
        );
    }, 0);
}

/**
 * `thetaAt` estimates the score's root at fixed means `m` by bisection in log theta. The sign
 * at `THETA_MAX` comes from the score's large-theta limit, `-sum((y - m)^2 - y) / (2 theta^2)`,
 * because the direct sum is rounding noise there.
 */
function thetaAt(y: number[], m: number[]): number {
    const excess = y.reduce((s, yi, j) => s + (yi - (m[j] as number)) ** 2 - yi, 0);
    if (excess <= 0) return THETA_MAX;
    if (thetaScore(y, m, THETA_MIN) <= 0) return THETA_MIN;
    let [lo, hi] = [Math.log(THETA_MIN), Math.log(THETA_MAX)];
    for (let i = 0; i < 100 && hi - lo > 1e-12; i++) {
        const mid = (lo + hi) / 2;
        if (thetaScore(y, m, Math.exp(mid)) > 0) lo = mid;
        else hi = mid;
    }
    return Math.exp((lo + hi) / 2);
}

/**
 * A negative-binomial GLM with log link, fitted as R `MASS::glm.nb` does: iteratively
 * reweighted least squares for the coefficients alternating with the theta that maximises
 * the likelihood at the current means.
 */
export function negativeBinomial(x: number[][], y: number[], iterations = 50): NegBinFit {
    const p = (x[0] ?? []).length;
    let beta = new Array<number>(p).fill(0);
    beta[0] = Math.log(Math.max(mean(y), 1e-8));
    let theta = 1;
    let settled = false;
    const mu = () =>
        x.map((row) => Math.exp(row.reduce((s, v, j) => s + v * (beta[j] as number), 0)));
    const weights = (m: number[]) => m.map((u) => u / (1 + u / theta));
    for (let outer = 0; outer < iterations; outer++) {
        let stable = false;
        for (let inner = 0; inner < 25 && !stable; inner++) {
            const m = mu();
            const w = weights(m);
            const z = m.map((u, i) => Math.log(u) + ((y[i] as number) - u) / u);
            const next = solve(weightedCross(x, w), weightedCross(x, w, z)[0] as number[]);
            const moved = next.reduce(
                (s, b, j) => Math.max(s, Math.abs(b - (beta[j] as number))),
                0,
            );
            beta = next;
            stable = moved < 1e-10;
        }
        const t = thetaAt(y, mu());
        const done = stable && (Math.abs(t - theta) < 1e-10 * theta || t >= THETA_MAX);
        theta = t;
        if (done) {
            settled = true;
            break;
        }
    }
    const xtwx = weightedCross(x, weights(mu()));
    const se = beta.map((_, j) =>
        Math.sqrt(
            solve(
                xtwx,
                beta.map((__, k) => Number(k === j)),
            )[j] as number,
        ),
    );
    const finite = [...beta, ...se, theta].every(Number.isFinite);
    const converged = settled && finite && beta.every((b) => Math.abs(b) <= 30);
    return { coefficients: beta, se, theta, converged };
}
