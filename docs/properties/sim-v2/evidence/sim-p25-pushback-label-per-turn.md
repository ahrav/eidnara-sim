# sim-p25-pushback-label-per-turn

Evidence status: PROPOSED. SIM-P25, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every user-sim turn carries a label in task, pushback, interrupt, redirect,
abandon, clarify, or paste, and P14 derives from labels only.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

## Failure scenario

P14 reads transcript text and grades by self-report.

## Timing windows and dependencies

None.

## What a test must construct

A run with user-sim turns.

## Investigation log

No open questions.
