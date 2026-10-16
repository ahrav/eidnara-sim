# sim-p30-no-unscheduled-fault

Evidence status: PROPOSED. SIM-P30, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every record with `fault_ref` set names a fault instance in state `armed` or
`triggered` at that sequence.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

M3 (#1027) injects only episodes the scheduler arms; an episode never armed
injects nothing, and a test checks that its witness stays `untriggered` with no
injected record.

## Failure scenario

Faults the schedule did not plan corrupt both arms' metrics.

## Timing windows and dependencies

A fault decorator left armed after its window injects into later calls.

## What a test must construct

A fault schedule with windows that close.

## Investigation log

No open questions.
