# sim-p50-p11-false-positive-weight-applied

Evidence status: PROPOSED. SIM-P50, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The P11 harm score weights a false positive at twice a hit, and the weight is in
the pre-registration record.

Every tier file carries `scoring.p11_false_positive_weight: "2"`, and
`src/prereg/validate.test.ts` shows the validator refuses its removal or any
other value by name, so the pre-registration hash binds the weight. The P11
score formula lands in M5 (#1029); no run exists yet.

## Failure scenario

Wrong-project injection is under-penalised.

## Timing windows and dependencies

None.

## What a test must construct

P11 items.

## Investigation log

### Q: How does a weighted P11 score enter a binary harm family?
- Sources examined: spec #1007 (SIM-P50: "the P11 harm score weights a false
  positive at 2x a hit"; harm metrics as noninferiority with a 10 pp margin;
  binary outcomes by exact McNemar with Newcombe CI); `prereg/*.json` harm
  family (`outcome: binary`, `interval_method:
  exact-mcnemar-newcombe-cluster-bootstrap`, metrics `P2.harm` to `P11.harm`).
- Findings: the registered interval analyses paired 0/1 outcomes; a weighted
  score takes more than two values. The spec gives no rule that reduces the
  P11 score to the 0/1 event the harm gate needs, and the P11 grader (M5,
  #1029) does not exist yet.
- Missing evidence: the M5 grader's definition of `P11.harm` as a per-item
  event, or a separate graded analysis for P11.
- Conclusion: needs human input
