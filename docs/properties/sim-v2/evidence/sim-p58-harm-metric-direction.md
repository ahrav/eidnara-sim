# sim-p58-harm-metric-direction

Evidence status: PROPOSED. SIM-P58, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

"Memory made it worse" is set iff some harm metric has `eidnara < host` with the
paired CI excluding zero, and the metric and CI are named.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

Harm is reported in the wrong direction or not at all.

## Timing windows and dependencies

None.

## What a test must construct

Harm family results.

## Investigation log

### Q: Does `eidnara < host` mean harm?
- Sources examined: spec #1007 property index, SIM-P58; `prereg/*.json`
  `stopping_rule.cusum[0]` (kind `harm`, statistic `eidnara minus host`); spec
  #1007 statistics section (harm metrics as noninferiority with a 10 pp margin
  on host minus eidnara).
- Findings: the pre-registration fixes the convention before any run: the harm
  metrics are rates (SIM-P46), the harm CUSUM alarms when `eidnara minus host`
  grows, and the harm gate is noninferiority against a 10 pp margin, so a
  higher value is worse and harm is `eidnara > host`. The spec index writes
  `eidnara < host`, which reads correctly only for a metric that scores higher
  when memory does better.
- Missing evidence: a correction of the spec index text, which lives in the
  eidnara tracker and is outside this tree.
- Conclusion: needs human input
