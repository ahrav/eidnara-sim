# sim-p14-idle-jump-lands-on-next-event

Evidence status: PROPOSED. SIM-P14, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

After `AdvanceClock`, `scenario_ms` equals the earliest scheduled event time
greater than the previous value.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) jumps the clock to the next event's scheduled time; a test checks
that the run journals exactly the expected `AdvanceClock` entries, one per
idle gap in each arm, and that each lands on the earliest scheduled event time
after its `from_ms`.

## Failure scenario

Events are skipped or issued late and the scenario differs from its compiled
plan.

## Timing windows and dependencies

A laptop-sleep fault inserts a jump of its own duration.

## What a test must construct

A scenario with idle gaps between events.

## Investigation log

No open questions.
