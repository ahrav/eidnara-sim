# sim-p32-missed-fault-excludes-run-from-fault-metrics

Evidence status: PROPOSED. SIM-P32, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

If any fault instance ends `missed`, `FaultMetricsEligible(run)` is false and
fault metrics in the report omit the run with the fault id listed.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

Recovery is reported for faults that never happened.

## Timing windows and dependencies

None.

## What a test must construct

A scheduled fault whose target never runs.

## Investigation log

No open questions.
