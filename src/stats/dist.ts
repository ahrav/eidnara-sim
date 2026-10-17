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
    let sum = 0;
    for (let i = 0; i <= Math.min(k, n); i++) sum += binomialPmf(i, n, p);
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
    return x - u / (1 + (x * u) / 2);
}

/** The regularized incomplete beta function by Lentz's continued fraction. */
export function incompleteBeta(x: number, a: number, b: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
    const front = Math.exp(
        logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
    const tiny = 1e-300;
    let [f, c, d] = [1, 1, 0];
    for (let i = 0; i <= 400; i++) {
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
        const step = c * d;
        f *= step;
        if (Math.abs(1 - step) < 1e-15) break;
    }
    return (front * (f - 1)) / a;
}

/** The `q` quantile of Beta(a, b), by bisection on the incomplete beta function. */
export function betaQuantile(q: number, a: number, b: number): number {
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (incompleteBeta(mid, a, b) < q) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

export function digamma(x: number): number {
    let r = 0;
    let y = x;
    while (y < 6) {
        r -= 1 / y;
        y += 1;
    }
    const f = 1 / (y * y);
    return r + Math.log(y) - 0.5 / y - f * (1 / 12 - f * (1 / 120 - f * (1 / 252 - f / 240)));
}

/** The upper tail `1 - normalCdf(x)`, computed directly so it keeps precision far out. */
export function normalSf(x: number): number {
    return normalCdf(-x);
}
