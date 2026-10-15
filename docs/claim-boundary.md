# Claim boundary: world simulation v2

The v2 harness is the live slice for the `eval-core` contracts. It measures
what a live model does on two real hosts, with and without Eidnara, over a
simulated span of developer work. A report states a result only inside this
boundary, and every report carries this document's version,
`sim-claim-boundary/v1`.

## What the live slice measures

- Behaviour of the live agent model on Pi and OpenCode, graded from artefacts:
  diffs, workspace state, command logs, test results, and proxy call records.
  Agent transcript text and self-report are never grade inputs.
- Paired differences between the arms `host`, `eidnara`, `eidnara-kl`, and at
  L `eidnara-cf`, under the margins, units, clusters, and alpha each tier's
  pre-registration in `prereg/` fixes before its first run.
- Harm from memory: should-not-apply violations, stale values over
  authoritative tool output, scoped-update bleed, anchor leakage, and
  wrong-project injection.
- Dependability, latency, resource growth, intrusiveness, and cost per
  component, each with the unit the pre-registration names.
- Recurrence of the nine baseline failure classes, each through an oracle with
  an activation counter.

## What the live slice excludes

1. **Provider-side wall-clock effects.** Prompt-cache warmth, rate limits, and
   provider latency run in wall time while scenario time jumps. The harness
   records cache read and write tokens per call so warmth is reconstructible,
   and makes no claim about how those effects change under manipulated age.
2. **Live-model nondeterminism as a controlled factor.** The agent model runs
   at production temperature. Divergence between arms is recorded, and A/A
   pairs measure the noise floor, but a result never claims the model would
   repeat its output.
3. **Scheduler-order independence.** Arms run sequentially per seed under one
   scheduler, with order alternating across seeds. A result holds for that
   order; the harness makes no claim that a different interleaving gives the
   same result.
4. **Hosts other than Pi and OpenCode.** Results hold for the pinned versions
   of those two hosts recorded in each run manifest.

## Further limits

- The monotonic clock is left unfaked, so in-host idle timers do not observe
  simulated gaps. A binary whose time interception fails runs wall-clock-only,
  and the report names it.
- A null result is reported as "no difference above X pp detectable at n",
  with the detectable effect size and resolution ratio; the report never
  states equivalence.
- A run-level paired claim (failed turns, hangs, latency delta, RSS slope)
  needs six paired runs. S has four, so its run-level families either stay
  descriptive or gate each run against a fixed bound with no paired claim:
  dependability (zero failed turns and hangs), intrusiveness (zero
  internal-string hits, corrections referencing injected text, and reverted
  memory edits), latency (p95 delta under 300 ms), and resources (per-session
  growth under the leak bound). M pools three seeds on each of two hosts into
  six paired runs; it gates dependability with the paired sign test at alpha
  0.03 and latency with the paired BCa bootstrap at alpha 0.05, and its
  resources and intrusiveness families gate each run against a fixed bound.
  Per-host run-level numbers at M and L hold three runs per host and stay
  descriptive.
- The harm family is Holm-corrected over five metrics. At M's registered n
  it reaches power 0.44 against the 10 pp noninferiority margin, so a passed
  M harm gate is weak evidence; the L re-sizing from M's discordance sets L's
  n for power 0.8.
- Model quality is not evaluated; the agent model is fixed per run, and only
  Eidnara's own side-call model is a factor (M tier).
