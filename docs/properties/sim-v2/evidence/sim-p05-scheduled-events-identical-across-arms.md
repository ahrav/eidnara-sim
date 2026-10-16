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

M2 (#1026) compiles the event list, the fault schedule, and the counterfactual
deletion schedule into the scenario file once per seed, with no arm input, so
every arm reads the same schedule. Each fault names a compiler-chosen position:
a session start, the Nth user turn of a session, or, for the mid-fold SIGKILL,
the first summarizer call the scheduler observes in a compiler-chosen forced
p90 session. The spec (#1007, Implementation Decisions) keys that fault on an
observed call so the kill lands inside a fold, so its firing turn can differ
between arms after divergence; a pair where only one arm's kill fires belongs
to the fault-asymmetric stratum (SIM-P31, SIM-P32), and this property covers
the schedule the arms share, not that firing time. `validateFault` refuses any
other trigger, and a test shows the refusal. A test per tier checks that each
scheduled fault names such a position and carries its seam entry. The per-arm
comparison lands with the scheduler in M4.

## Failure scenario

Fault and recovery metrics compare arms under different conditions.

## Timing windows and dependencies

A fault keyed on an observed event rather than a compiler event would fire at
different times per arm.

## What a test must construct

A compiled scenario with faults and, at L, counterfactual deletions.

## Investigation log

No open questions.
