# sim-p13-background-job-holds-clock

Evidence status: PROPOSED. SIM-P13, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A background job is in `busy_set` while no turn is in `busy_set`.

M4 (#1028) holds the clock while a background job registered after a turn's end
runs; a test registers a job after `EndTurn` and checks that no `AdvanceClock`
or `BeginTurn` appears before its `EndJob`.

The live witness (`tests/witness-faults.ts`, `docs/run-command.md`) on 2026-10-16
recorded six jobs registered with no turn or other job open (two native
compactions and four memory captures), and no clock jump while any of them
ran.

## Failure scenario

The job-holds-clock branch is never exercised and SIM-P12's job half is
untested.

## Timing windows and dependencies

None.

## What a test must construct

A fold or memory-capture job that outlives its triggering turn.

## Investigation log

No open questions.
