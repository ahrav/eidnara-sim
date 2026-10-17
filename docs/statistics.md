# Statistics

`src/stats/` holds the paired statistics the tier verdict uses. Each
function is pure and seeded where it resamples, and each reproduces a
published reference within a stated tolerance
(`tests/fixtures/stats/references.json` names every source).

## Library

| Function | Statistic | Reference reproduced |
|---|---|---|
| `mcnemarExact(b, c)` | Exact McNemar test on the discordant counts: two-sided binomial p at one half, odds ratio `b / c`, and central Clopper-Pearson limits mapped to the odds ratio, as R `exact2x2::mcnemar.exact` reports | b = 150, c = 86: p 3.716e-5, interval (1.329228, 2.300979) |
| `signTest(x, n)` | Two-sided exact sign test | Armitage and Berry's media table: 12 against 2, p 0.0129 |
| `newcombe(a, b, c, d)` | Newcombe (1998) method 10 interval for a paired difference of proportions | The same table: (0.056156, 0.329207) |
| `holm(ps)` | Holm step-down adjusted p-values in input order | R `p.adjust(c(0.001, 0.01, 0.04, 0.2, 0.5), "holm")` |
| `cusum(xs, target, k, h, head)` | Tabular two-sided CUSUM with an optional head start; `signal_upper` and `signal_lower` are each side's first index past `h` | Hawkins's homework table: K 1.5, H 7.115, both sums and the signal at observation 18 |
| `bootstrap(xs, stat, o)` | Seeded percentile or BCa bootstrap interval; BCa uses the jackknife acceleration (`acceleration`) and clamps the bias proportion to (0, 1) so one-sided replicates give finite limits | Efron and Tibshirani's spatial-test variance: 171.5, acceleration 0.061, 90% BCa (115.8, 259.6) within 3%; the percentile interval against scipy's within 2%, a cross-check rather than a published table |
| `negativeBinomial(x, y)` | Negative-binomial GLM with log link, fitted as R `MASS::glm.nb` does, with coefficient standard errors; theta is the bracketed root of its score in [1e-8, 1e8] and stops at 1e8 for counts with no overdispersion, and `converged` requires the coefficient iteration to settle and is false when an iteration limit runs out, a number is not finite, or the arms separate | `glm.nb(Days ~ Eth + Sex + Age + Lrn, quine)`: seven coefficients, six standard errors, and theta 1.274892646 |

`src/stats/dist.ts` supplies the normal, binomial, and incomplete beta
functions and the digamma function the GLM's theta score needs. Every
statistic is floating point. Binomial probabilities up to a
thousand trials come from running products rather than log-gamma, which
keeps small cases such as 6 against 0 (p = 2/64) exact; a product whose
power factor would fall below the smallest normal double is taken in log
space instead, so representable tails stay nonzero. eval-core's exact
McNemar (`crates/eval-core/src/stale.rs`) is Rust only and decides
`p <= alpha` in integer arithmetic; the fixture `eval_core_mcnemar` copies
the decisions its tests list (eval-core 0.1.0, eidnara commit
`bb866266c`), and this library decides the same way, continuing past the
123 or so discordant pairs where eval-core refuses.

The cluster bootstrap the gates use resamples ledger facts with this
percentile bootstrap; no published table covers a cluster resample.
