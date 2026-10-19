# sim-p57-leak-verdict-uses-fit-and-bound

Evidence status: PROPOSED. SIM-P57, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The leak verdict reports slope, R squared, and the inequality `RSS(T) < 2 *
RSS(0) + N_sessions * c` with `c` from the pre-registration, and samples every
10 seconds of wall time carry scenario and wall time.

M7 (#1033) `soak` reports the steady-window slope per session, R squared, the
bound `value(T) < 2 * value(0) + sessions(T) * c` at its worst sample, and the
return to baseline; the sampler records RSS, anonymous memory, and store bytes
every pre-registered interval with scenario and wall time. A planted linear-
growth fixture is a leak and a flat one is not.

## Failure scenario

The observed linear RSS growth is missed or misreported.

## Timing windows and dependencies

Warmup and cooldown phases distort a naive slope.

## What a test must construct

A soak run with sampler output.

## Investigation log

### Q: Is the return-to-baseline criterion pre-registered?
- Sources examined: spec #1007 Verification Strategy (soak: "leak verdict by
  fitted slope with an R² threshold plus return-to-baseline, and the bound
  RSS(T) < 2·RSS(0) + N_sessions·c with c pre-registered"); `prereg/*.json`
  `leak_bound`.
- Findings: `leak_bound` carries `c_bytes_per_session`, `r2_threshold`, and
  `sample_interval_ms`. The spec names `c` as the pre-registered value; it gives
  the return-to-baseline check no tolerance, and no tier file registers one.
- Missing evidence: a decision on the tolerance and whether it enters the
  hashed file.
- Conclusion: needs human input

### Q: Is external memory gated or sampled only?
- Sources examined: spec #1007 soak line ("sample daemon RSS, heap, external,
  and store bytes every 10 s"); the resources family in `prereg/*.json`.
- Findings: every tier's resources family gates
  `daemon_rss_growth_bytes_per_session`, `daemon_heap_growth_bytes_per_session`,
  and `store_growth_bytes_per_session` against `c`; the spec's gate is the RSS
  bound, and external bytes appear in its sampling list only.
- Missing evidence: a decision on whether external growth joins the gated
  metrics.
- Conclusion: needs human input
