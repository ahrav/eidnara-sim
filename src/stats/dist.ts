const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
    const z = x - 1;
    let a = 0.99999999999980993;
    LANCZOS.forEach((c, i) => {
        a += c / (z + i + 1);
    });
    const t = z + LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const MIN_NORMAL = 2 ** -1022;

export function binomialPmf(k: number, n: number, p: number): number {
    if (k < 0 || k > n) return 0;
    if (p === 0) return k === 0 ? 1 : 0;
    if (p === 1) return k === n ? 1 : 0;
    const [pk, qk] = [p ** k, (1 - p) ** (n - k)];
    if (n <= 1000 && pk >= MIN_NORMAL && qk >= MIN_NORMAL) {
        let choose = 1;
        for (let i = 1; i <= Math.min(k, n - k); i++)
            choose = (choose * (n - Math.min(k, n - k) + i)) / i;
        return choose * pk * qk;
    }
    const log = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
    return Math.exp(log + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

export function binomialCdf(k: number, n: number, p: number): number {
    if (k < 0) return 0;
    if (k >= n) return 1;
    if (n > 1000) return incompleteBeta(1 - p, n - k, k + 1);
    let sum = 0;
    for (let i = 0; i <= k; i++) sum += binomialPmf(i, n, p);
    return Math.min(1, sum);
}

/** erf by its Taylor series below t = 2 and erfc by its continued fraction above. */
export function normalCdf(x: number): number {
    const t = Math.abs(x) / Math.SQRT2;
    let term = t;
    let sum = t;
    if (t < 2) {
        for (let n = 1; n < 200 && Math.abs(term) > 1e-17 * Math.abs(sum); n++) {
            term *= (-t * t * (2 * n - 1)) / (n * (2 * n + 1));
            sum += term;
        }
        const erf = (2 / Math.sqrt(Math.PI)) * sum;
        return x < 0 ? 0.5 * (1 - erf) : 0.5 * (1 + erf);
    }
    let cf = 0;
    for (let n = 300; n > 0; n--) cf = n / 2 / (t + cf);
    const erfc = Math.exp(-t * t) / Math.sqrt(Math.PI) / (t + cf);
    return x < 0 ? 0.5 * erfc : 1 - 0.5 * erfc;
}

/** Acklam's rational approximation polished by one Halley step. */
export function normalQuantile(p: number): number {
    if (p <= 0) return Number.NEGATIVE_INFINITY;
    if (p >= 1) return Number.POSITIVE_INFINITY;
    const a = [
        -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
        -30.66479806614716, 2.506628277459239,
    ];
    const b = [
        -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
        -13.28068155288572,
    ];
    const c = [
        -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
        4.374664141464968, 2.938163982698783,
    ];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const poly = (k: number[], x: number) => k.reduce((s, v) => s * x + v, 0);
    let x: number;
    if (p < 0.02425) {
        const q = Math.sqrt(-2 * Math.log(p));
        x = poly(c, q) / (poly(d, q) * q + 1);
    } else if (p > 1 - 0.02425) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        x = -poly(c, q) / (poly(d, q) * q + 1);
    } else {
        const q = p - 0.5;
        const r = q * q;
        x = (poly(a, r) * q) / (poly(b, r) * r + 1);
    }
    const e = normalCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return Number.isFinite(u) ? x - u / (1 + (x * u) / 2) : x;
}

/** The regularized incomplete beta function by Lentz's continued fraction. */
export function incompleteBeta(x: number, a: number, b: number): number {
    if (!(a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)))
        throw new RangeError("incompleteBeta: the shapes must be finite and positive");
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
    const front = Math.exp(
        logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
    const tiny = 1e-300;
    let [f, c, d] = [1, 1, 0];
    let step = 0;
    for (let i = 0; i <= 10_000 && Math.abs(1 - step) >= 1e-15; i++) {
        const m = Math.floor(i / 2);
        const num =
            i === 0
                ? 1
                : i % 2 === 0
                  ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
                  : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 + num * d;
        d = Math.abs(d) < tiny ? tiny : d;
        d = 1 / d;
        c = 1 + num / c;
        c = Math.abs(c) < tiny ? tiny : c;
        step = c * d;
        f *= step;
    }
    if (Math.abs(1 - step) >= 1e-15)
        throw new RangeError("incompleteBeta: the continued fraction did not converge");
    return (front * (f - 1)) / a;
}

/** The `q` quantile of Beta(a, b), by bisection on the incomplete beta function. */
export function betaQuantile(q: number, a: number, b: number): number {
    if (!(q >= 0 && q <= 1)) throw new RangeError("betaQuantile: q must lie in [0, 1]");
    if (!(a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)))
        throw new RangeError("betaQuantile: the shapes must be finite and positive");
    if (q === 0 || q === 1) return q;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (incompleteBeta(mid, a, b) < q) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

const ASYMPTOTIC_MIN = 6;

/** The asymptotic expansion of `digamma(x) - log(x)` for `x >= ASYMPTOTIC_MIN`. */
function digammaTail(x: number): number {
    const f = 1 / (x * x);
    return -0.5 / x - f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f / 240)));
}

/** The asymptotic expansion of `logGamma(x) - ((x - 1/2) log x - x + log(2 pi) / 2)`. */
function logGammaTail(x: number): number {
    const f = 1 / (x * x);
    return (1 / x) * (1 / 12 - f * (1 / 360 - f * (1 / 1260 - f / 1680)));
}

export function digamma(x: number): number {
    if (!(x > 0)) throw new RangeError("digamma: the argument must be positive");
    let r = 0;
    let y = x;
    while (y < ASYMPTOTIC_MIN) {
        r -= 1 / y;
        y += 1;
    }
    return r + Math.log(y) + digammaTail(y);
}

const HARMONIC_MAX = 1000;

/**
 * `digamma(t + y) - digamma(t)` for a count `y`, as the finite sum `sum(1 / (t + k))` up to
 * `HARMONIC_MAX` and above it as the difference of asymptotic expansions once `t` reaches
 * `ASYMPTOTIC_MIN`, so the result keeps its digits when `y / t` is small.
 */
export function digammaDiff(t: number, y: number): number {
    if (y <= HARMONIC_MAX) {
        let sum = 0;
        for (let k = 0; k < y; k++) sum += 1 / (t + k);
        return sum;
    }
    if (t < ASYMPTOTIC_MIN) return digamma(y + t) - digamma(t);
    return Math.log1p(y / t) + digammaTail(t + y) - digammaTail(t);
}

/**
 * `logGamma(t + y) - logGamma(t)` for a count `y`, as the finite sum `sum(log(t + k))` up to
 * `HARMONIC_MAX` and above it as the difference of Stirling expansions once `t` reaches
 * `ASYMPTOTIC_MIN`.
 */
export function logGammaDiff(t: number, y: number): number {
    if (y <= HARMONIC_MAX) {
        let sum = 0;
        for (let k = 0; k < y; k++) sum += Math.log(t + k);
        return sum;
    }
    if (t < ASYMPTOTIC_MIN) return logGamma(y + t) - logGamma(t);
    return (
        y * Math.log(t) +
        (t + y - 0.5) * Math.log1p(y / t) -
        y +
        logGammaTail(t + y) -
        logGammaTail(t)
    );
}

/** The upper tail `1 - normalCdf(x)`, computed directly so it keeps precision far out. */
export function normalSf(x: number): number {
    return normalCdf(-x);
}
