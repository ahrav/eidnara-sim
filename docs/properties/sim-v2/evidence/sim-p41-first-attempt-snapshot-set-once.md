# sim-p41-first-attempt-snapshot-set-once

Evidence status: PROPOSED. SIM-P41, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`SnapshotArtefacts` appears exactly once per item and arm, at the first
`EndTurn` of the probe task, and grades reference that snapshot id.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

M5 (#1029) grades only an item's first snapshot and counts later ones in `later_attempts_logged`; a test shows the grade follows the first snapshot when the order is reversed. The arm driver captures a snapshot at each probe turn, and the scheduler journals `SnapshotArtefacts` once per item and arm after the first `EndTurn`.

## Failure scenario

A later corrected attempt is graded as the first.

## Timing windows and dependencies

A user-sim pushback after the probe turn lets the agent retry.

## What a test must construct

A probe turn followed by pushback.

## Investigation log

No open questions.
