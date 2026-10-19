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

M7 (#1032) names each harm metric whose verdict is `worse` in
`memory_made_it_worse` with its interval. `worse` for a harm metric means the
treatment arm's harm rate is higher: the Holm-adjusted exact McNemar is
significant, the interval excludes zero, and the shift is toward more harm. The
guarantee above states the condition as `eidnara < host` and "the paired CI
excludes zero"; the direction and the Holm correction both disagree with it,
see the investigation log and the catalog's open questions.

## Failure scenario

Harm is reported in the wrong direction or not at all.

## Timing windows and dependencies

None.

## What a test must construct

Harm family results.

## Investigation log

### Q: Is "memory made it worse" set when `eidnara < host` or when `eidnara > host`?

- Sources examined: spec #1007 property index (`SIM-P58`: iff some harm
  metric has `eidnara < host`); `src/grade/probes.ts` (`P2.harm`, `P3.harm`,
  `P4.harm`, `P10.harm`, `P11.harm` are 1 when the harm occurred); the harm
  family in `prereg/M.json` (metrics `P2.harm` to `P11.harm`, direction
  `noninferiority`); `src/stats/gate.ts` (`higherIsBetter` is false for a
  harm metric, so a significant positive treatment-minus-control shift is
  `worse`); `prereg/*.json` `stopping_rule.cusum[0]` (kind `harm`, statistic
  `eidnara minus host`); spec #1007 statistics section (harm metrics as
  noninferiority with a 10 pp margin on host minus eidnara).
- Findings: the registered harm metrics are harm indicators, so more harm in
  `eidnara` reads `eidnara > host`; the harm CUSUM alarms when `eidnara minus
  host` grows, the same convention. The spec's `eidnara < host` fits a pass or
  quality scale, which is how the harm probes are also graded (`P2.pass` is
  the complement of `P2.harm`). The implementation follows the registered
  harm-indicator metrics.
- Missing evidence: a spec statement of which scale `SIM-P58` compares; a
  correction of the spec index text lives in the eidnara tracker, outside
  this tree.
- Conclusion: needs human input. The guarantee wording and the registered
  metric scale disagree in sign; both are recorded here, and the catalog
  record carries the question.
