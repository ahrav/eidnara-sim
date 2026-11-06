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

M6 (#1031) journals one `UserTurn` per sent or skipped turn with a label from
task, pushback, interrupt, redirect, abandon, clarify, or paste, ahead of the
turn's `EndTurn`, and lists the delivered turns' labels as `user-sim` entries
in each probe snapshot's call records. Compiled
P14 items have no probe turn; `scripts/grade-run.ts` grades each from a
session view (`sessionSnapshot`) that places the arm's delivered `UserTurn`
labels among the session's `calls.jsonl` records, the placement a capture
uses (`sessionTurns` in `src/usersim/plan.ts`). The `pushback` labels come
from the seeded behaviour plan, so both arms of a seed carry them on the same
turns (c7 S-101: 815 on identical events in each arm).

## Failure scenario

P14 reads transcript text and grades by self-report.

## Timing windows and dependencies

None.

## What a test must construct

A run with user-sim turns.

## Investigation log

No open questions.
