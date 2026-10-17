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
| `bootstrap(xs, stat, o)` | Seeded percentile or BCa bootstrap interval; BCa uses the jackknife acceleration (`acceleration`) | Efron and Tibshirani's spatial-test variance: 171.5, acceleration 0.061, 90% BCa (115.8, 259.6) within 3%; the percentile interval against scipy's within 2%, a cross-check rather than a published table |
| `negativeBinomial(x, y)` | Negative-binomial GLM with log link, fitted as R `MASS::glm.nb` does, with coefficient standard errors; theta stops at 1e8 for counts with no overdispersion, and `converged` is false when an iteration limit runs out, a number is not finite, or the arms separate | `glm.nb(Days ~ Eth + Sex + Age + Lrn, quine)`: seven coefficients, six standard errors, and theta 1.274892646 |

`src/stats/dist.ts` supplies the normal, binomial, and incomplete beta
functions and the digamma and trigamma functions the GLM's theta step
needs. Every statistic is floating point. Binomial probabilities up to a
thousand trials come from running products rather than log-gamma, which
keeps small cases such as 6 against 0 (p = 2/64) exact. eval-core's exact
McNemar (`crates/eval-core/src/stale.rs`) is Rust only and decides
`p <= alpha` in integer arithmetic; the fixture `eval_core_mcnemar` copies
the decisions its tests list (eval-core 0.1.0, eidnara commit
`bb866266c`), and this library decides the same way, continuing past the
123 or so discordant pairs where eval-core refuses.

The cluster bootstrap the gates use resamples ledger facts with this
percentile bootstrap; no published table covers a cluster resample.

## Tier gates

`evaluateTier(prereg, input)` (`src/stats/gate.ts`) evaluates every family
of a tier's pre-registration from paired observations. An observation
names its metric, unit (`item` or `run`), and cluster key, and carries
item pairs (control and treatment values with a ledger-fact cluster and
issue order) or run pairs. `pairByItem` joins two arms' values by item id
and orders the pairs by the issue order it is given, so pairing never
depends on the order either arm graded in. The input also lists the ids
the missingness policy excludes (each with its arm and reason) and the
pairs in the fault-asymmetric stratum; both leave the analysis, and the
verdict counts them per arm and per metric.

A metric with no pre-registration entry is refused by name, and so is a
metric observed twice or an observation whose unit or cluster key differs
from its family's. Every registered metric gets a result: one with no
observations is `inconclusive`, and a gate family with such a metric
fails.

| Outcome and unit | Method |
|---|---|
| Binary items | Exact McNemar p on the discordant pairs; the interval is the wider of the Newcombe method 10 interval and a ledger-fact cluster bootstrap, in percentage points |
| Graded runs | Paired BCa bootstrap over runs for `paired-bca-bootstrap` or under ten runs, else percentile |
| Count runs | Paired sign test up to eight runs, one-sided for `at-most`; above eight, or for `negative-binomial-glm`, a negative-binomial GLM with an arm term and a term per run over the runs with any events, reporting the rate ratio, with the sign test standing in when an arm has no events or the fit does not converge |
| Bound families | No statistic; each run's treatment value, or a binary metric's treatment rate, is checked against the margin |

Each paired metric gets a verdict: `better` or `worse` when the test is
significant at the family's alpha (`p <= alpha`, after Holm over all of a
`holm` family's registered metrics, a missing one at p = 1) in the
direction the metric favours (pass rates and fidelity up, harms, counts,
latency, and resources down), and otherwise
`no-difference-above-X<scale>-detectable-at-n`. X is the detectable
difference at that n: for binary items a normal approximation in Connor's
form, `(z(1 - alpha/2) + z(power)) * sqrt(discordant) / n`, with the
observed discordant count in place of the planned one and without
Connor's variance correction; for graded runs the same approximation with
the sample standard deviation of the differences; for the sign test the
smallest share of runs that would reach significance (`pp-of-runs`); and
for the GLM the rate ratio. The resolution ratio is X over the
pre-registered MDE, or over the margin for a noninferiority family whose
MDE is zero; the sign test has none, and its result says why. A run-level
gate with fewer than six paired runs says `insufficient-runs(k)`. Bound
families say `within-bound` or `failed-gate(metric, ids)`.

A gate component passes as follows: `superiority-two-sided` needs
`better`; `noninferiority` needs the interval's upper end below the
margin; `at-most` needs the upper end at or below the margin, or, for the
sign test, no `worse` and the Clopper-Pearson upper limit (at half the
alpha) of the treatment-to-control ratio of event totals at or below a
ratio margin; a treatment arm with no events passes. At six to eight runs
that limit stays above 1.5 unless the treatment arm has far fewer events,
so the sign-test gates at M and L pass with zero or few treatment events. The tier passes by intersection-union:
every gate component passes at its own alpha, which the verdict lists,
no CUSUM rule stopped the tier, and the input's `incomplete` list, the
fixed-N campaign requirements still open, is empty; the verdict carries
that list under `pass.incomplete`. A noninferiority or at-most component
decides on the upper end of a two-sided interval, a one-sided test at
half its alpha, and the verdict says so.

The CUSUM rules of `stopping_rule` run as harm or futility stops only.
The harm sequence is, per item in issue order, the largest
treatment-minus-control difference over the harm family's metrics; the
futility sequence is control minus treatment on its family's items; each
is divided by the standard deviation the input supplies from the tier's
A/A pairs. The upper tabular CUSUM at the rule's `k` and `h` signals a
stop, recorded with the metric, the signal index, and the item ids since
the sum last stood at zero, and a stop withholds the pass; a benefit,
which moves only the lower sum, stops nothing. A rule without an A/A
standard deviation is listed as unavailable. The verdict also carries the
pre-registration digest, the journal sequence it was evaluated at, the
families with their MDE and margin, and the harm metrics whose verdict is
`worse` ("memory made it worse"). An evaluation whose output contains the
word parity is refused.

`falsificationSet(prereg, pairs)` checks the harness falsification set
(in-session repo-readable fact pass rate, gateway 4xx rate with no
scheduled faults, pre-divergence pushback rate, wall time per scripted
idle gap): each check's paired differences get a bootstrap interval, and
a zero effect is an interval that covers zero. With fewer than two pairs
a check has no result. A name outside the set is refused.
