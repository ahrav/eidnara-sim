# sim-p05-scheduled-events-identical-across-arms

Evidence status: PROPOSED. SIM-P05, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Scheduled event kinds, times, fault schedule, and counterfactual deletion
schedule are identical across all arms for the whole run, independent of
divergence.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

M2 (#1026) compiles the event list into the scenario file once per seed, with
no arm input, so every arm reads the same scheduled events. The fault and
counterfactual deletion schedules join the same file in the second M2 unit, and
the per-arm comparison lands with the scheduler in M4.

## Failure scenario

Fault and recovery metrics compare arms under different conditions.

## Timing windows and dependencies

A fault keyed on an observed event rather than a compiler event would fire at
different times per arm.

## What a test must construct

A compiled scenario with faults and, at L, counterfactual deletions.

## Investigation log

No open questions.
