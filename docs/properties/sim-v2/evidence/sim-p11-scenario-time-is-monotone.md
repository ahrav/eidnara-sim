# sim-p11-scenario-time-is-monotone

Evidence status: PROPOSED. SIM-P11, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Journal entries in sequence order have non-decreasing `scenario_ms`.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

M4 (#1028) refuses a journal entry whose `scenario_ms` is below the same arm's
previous entry. Scenario time is monotone per arm, because each arm runs its
own clock from 0; the tests check every arm's entries.

## Failure scenario

Age, idle-gap, and staleness metrics are computed on a reordered timeline.

## Timing windows and dependencies

Resume after a crash restores the clock; a stale value would move time
backwards.

## What a test must construct

A run with an interrupt and resume.

## Investigation log

No open questions.
