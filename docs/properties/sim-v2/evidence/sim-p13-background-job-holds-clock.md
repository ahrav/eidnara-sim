# sim-p13-background-job-holds-clock

Evidence status: PROPOSED. SIM-P13, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A background job is in `busy_set` while no turn is in `busy_set`.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

M4 (#1028) holds the clock while a background job registered after a turn's end
runs; a test registers a job after `EndTurn` and checks that no `AdvanceClock`
or `BeginTurn` appears before its `EndJob`.

## Failure scenario

The job-holds-clock branch is never exercised and SIM-P12's job half is
untested.

## Timing windows and dependencies

None.

## What a test must construct

A fold or memory-capture job that outlives its triggering turn.

## Investigation log

No open questions.
