# sim-p62-resume-does-not-reissue-completed-items

Evidence status: PROPOSED. SIM-P62, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

After `ResumeRun`, no `BeginTurn` appears for an item already terminal, and no
call record repeats a pre-interrupt `call_id`.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) treats an event with an `Event` entry, or a turn with an `EndTurn`,
as complete on resume; resume tests kill mid-turn, after a turn's answer, and
in the second arm, and check that each arm's events appear once and the
fixture's per-event billing log has no duplicate. That covers the `BeginTurn`
half. The `call_id` half waits for a driver that bills through the proxy's call
records; the fixture driver has no provider calls.

The live witness (`tests/witness-faults.ts`, `docs/run-command.md`) on 2026-10-16
sent SIGKILL to a live Pi run after the third session's turn made its first
model call and ran the same command again: every turn recorded before the
kill had the same call count afterwards, and the resumed run delivered only
the events after the interrupted turn.

## Failure scenario

Completed items are re-billed and double-counted.

## Timing windows and dependencies

An interrupt between `EndTurn` and its journal entry.

## What a test must construct

A harness kill at varied points.

## Investigation log

No open questions.
