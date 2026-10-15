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

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

## Failure scenario

Wrong-project injection is under-penalised.

## Timing windows and dependencies

None.

## What a test must construct

P11 items.

## Investigation log

No open questions.
