# sim-p67-incomplete-run-refuses-load

Evidence status: PROPOSED. SIM-P67, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`LoadRun` refuses an arm with fewer terminal items than scheduled or without a
done marker, and the error names the arm and counts.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

M5 (#1029) puts the load in `scripts/grade-run.ts`: before it opens the grade log, `gradeRun` requires `EndRun` and, for every arm in the manifest's order, `EndArm` and one terminal `Event` per scheduled event, and the refusal names the arm and both counts (`arm eidnara is incomplete: 1 of 3 events ended, no EndArm`); a test grades a run whose journal stops inside one arm and checks the refusal and that no grade was appended.

## Failure scenario

A partial run is analysed as complete.

## Timing windows and dependencies

None.

## What a test must construct

A run interrupted without resume.

## Investigation log

No open questions.
