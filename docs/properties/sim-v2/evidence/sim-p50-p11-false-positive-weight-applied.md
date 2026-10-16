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
`src/prereg/validate.test.ts` shows the validator refuses its removal by name,
so the pre-registration hash binds the weight. The P11 score formula lands in
M5 (#1029); no run exists yet.

## Failure scenario

Wrong-project injection is under-penalised.

## Timing windows and dependencies

None.

## What a test must construct

P11 items.

## Investigation log

No open questions.
