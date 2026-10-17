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
pairs in the fault-asymmetric stratum; both leave the analysis. The
verdict counts exclusions per compared arm, both arms always named, zero
included, lists the asymmetric stratum, and counts asymmetric pairs per
metric.

A metric with no pre-registration entry is refused by name, and so is a metric
registered in two families, a metric observed twice, an observation whose unit
or cluster key differs from its family's, an observation carrying runs for an
item unit or items for a run unit, a control or treatment value that is not
finite, a binary family's value other than 0 or 1, a negative count, a
fractional event count (a count family whose margin has a scale; the cost
family's amounts are unrestricted), a `pp`-scale graded value outside [0, 1], an
item whose issue order is not a non-negative integer or whose ledger-fact
cluster differs between observations, an item or run identity repeated within an
observation, an issue order shared by two items or an item with two orders, an
exclusion listed twice for one arm (an item both arms failed is excluded once
per arm), an asymmetric id listed twice or also excluded, an exclusion
attributed to an arm other than the two compared, a run-level family whose
metrics come from different run sets, a bootstrap plan below 40 replicates
(eval-core's floor), and a bootstrap interval that is not finite. A metric whose
name ends in `_delta_ms` or names a growth per session arrives as the paired
delta in the treatment value with 0 as control, so a bound on it is a bound on
the delta.
The input names the compared arms, which are `host` against the
pre-registration's default arm (D1), and the journal sequence whose
completed pairs it was built from, a non-negative integer; the verdict
repeats both so the input set can be recomputed. Every registered metric
gets a result: one with no observations is `inconclusive`, and a gate
family with such a metric fails.

| Outcome and unit | Method |
|---|---|
| Binary items | Exact McNemar p on the discordant pairs; the interval is the wider of the Newcombe method 10 interval and a ledger-fact cluster bootstrap, in percentage points; items that all share one ledger-fact cluster are one observation and the result is `inconclusive` |
| Graded runs | Paired BCa bootstrap over runs for `paired-bca-bootstrap` or under ten runs, else percentile; a family on the `pp` scale takes proportions and reports percentage points |
| Count runs | Paired sign test up to eight runs, one-sided for `at-most`; above eight, or for `negative-binomial-glm`, a negative-binomial GLM with an arm term and a term per run over the runs with any events, reporting the rate ratio, with the sign test standing in when an arm has no events or the fit does not converge |
| Bound families | No statistic; each run's treatment value, or a binary metric's treatment rate, is checked against the margin; a failed item rate names the items whose treatment value is 0 |
| `interval_method: none`, paired | The paired mean difference and n, no interval, p, or detectable size; the verdict is `descriptive` (the cost families, XL's latency) |

Each paired metric gets a verdict: `better` or `worse` when the test is
significant at the family's alpha (`p <= alpha`, after Holm over all of a
`holm` family's registered metrics, a missing one at p = 1) in the
direction the metric favours (pass rates and fidelity up, harms, counts,
latency, and resources down), and otherwise
`no-difference-above-X<scale>-detectable-at-n`. Holm governs these
labels, which is where the harm family's "memory made it worse" claim
comes from; the family's noninferiority pass is decided per metric as
described below. X is the detectable
difference at that n: for binary items a normal approximation in Connor's
form, `100 * (z(1 - alpha/2) + z(power)) * sqrt(max(discordant, 1)) / n`
in percentage points, where a Holm
family with a one-sided claim is planned at its first step, `z(1 - alpha/m)`
over its `m` metrics (one-sided 0.01 for the harm family, the level
`docs/eval-core-mapping.md` registers its power at), with the
observed discordant count in place of the planned one and without
Connor's variance correction; for graded runs the same approximation with
the sample standard deviation of the differences; for the sign test the
smallest share of runs that would reach significance (`pp-of-runs`); and
for the GLM the rate ratio. The resolution ratio is X over the
pre-registered MDE, or over the margin for a family whose MDE is zero (the
noninferiority harm family and L's at-most resources family register the
planned true value 0); the sign test has none, and its result says why. A run-level
gate with fewer paired runs than its family's registered floor (six at
least) says `insufficient-runs(k)`. Bound
families say `within-bound` or `failed-gate(metric, ids)`.

A gate component passes as follows: `superiority-two-sided` needs
`better`; `noninferiority` needs the interval's upper end below the
margin, each metric at the family alpha, so five harm metrics form an
intersection-union test whose size is at most that alpha without a
multiplicity adjustment; `at-most` needs the upper end at or below the
margin, or, for the
sign test, no `worse` and the Clopper-Pearson upper limit (at half the
alpha) of the treatment-to-control ratio of event totals at or below a
ratio margin; with treatment events and no control events the limit is
recorded as `unbounded` and the component fails. With no events in either arm there is no ratio to bound and
the component rests on the sign test. At six to eight runs
that limit stays above 1.5 unless the treatment arm has far fewer events:
one control event and none in treatment bounds the ratio near 66, and
five control events and none in treatment near 1.3. The tier passes by
intersection-union:
every gate component passes at its own alpha, which the verdict lists,
every CUSUM rule was evaluated, and none stopped the tier. A noninferiority
or at-most component with an interval decides on its upper end, a
one-sided test at half its alpha; the at-most sign test compares its
one-sided p with the family alpha (the pre-registration's "sign test at
p 0.03" at six paired runs, where six discordant runs give p = 1/64); the
verdict says so.

The CUSUM rules of `stopping_rule` run as harm or futility stops only.
The harm sequence is, per item in issue order, the largest
treatment-minus-control difference over the harm family's metrics; the
futility sequence is control minus treatment on its family's items; each
is divided by the standard deviation the input supplies from the tier's
A/A pairs. The upper tabular CUSUM at the rule's `k` and `h` signals a
stop, recorded with the metric, the signal index, and the item ids since
the sum last stood at zero, and a stop withholds the pass; a benefit,
which moves only the lower sum, stops nothing. The standard deviation is
finite and positive or the input is refused. A rule without an A/A
standard deviation, or with no items for its metric, is listed as
unavailable, and a tier with an unavailable rule gets no pass. The
verdict lists every rule with its registered `sd_source` and the
deviation it used, so the A/A report can be checked against it. The
verdict also carries the
pre-registration digest, the journal sequence it was evaluated at, the
families with their MDE and margin, and the harm metrics whose verdict is
`worse` ("memory made it worse"). An evaluation whose output contains the
word parity is refused.

`falsificationSet(prereg, pairs)` checks the harness falsification set
(in-session repo-readable fact pass rate, gateway 4xx rate with no
scheduled faults, pre-divergence pushback rate, wall time per scripted
idle gap): each check's paired differences get a bootstrap interval, and
a zero effect is an interval that covers zero. With fewer than two pairs
a check has no result. A name outside the set, a value that is not finite
or outside the check's domain (the three rates lie in [0, 1], the idle-gap
wall time is non-negative), a bootstrap plan below 40 replicates, or an
interval that is not finite is refused.
