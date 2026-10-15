# sim-p56-failed-turn-claim-needs-six-paired-runs

Evidence status: PROPOSED. SIM-P56, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A dependability verdict on failed turns or hangs is emitted only with at least
six paired runs; below that the verdict is `insufficient-runs(k)`.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

A run-level claim is made from one or two runs.

## Timing windows and dependencies

None.

## What a test must construct

A tier with fewer than six paired runs.

## Investigation log

No open questions.
