# sim-p38-cost-conserves-by-component

Evidence status: PROPOSED. SIM-P38, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Per-arm total tokens equal the sum of per-component tokens, and per-component
cost uses the journaled price table version.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

Cost ratios are computed on tokens that do not add up.

## Timing windows and dependencies

None.

## What a test must construct

A run with every component active.

## Investigation log

No open questions.
