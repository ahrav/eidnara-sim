# sim-p68-clock-restored-on-resume

Evidence status: PROPOSED. SIM-P68, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

After `ResumeRun`, `scenario_ms` equals the last journaled clock value and
`busy_set` is empty.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) restores each arm's clock from its last journaled `scenario_ms` on
resume; the resume tests check that the first resumed entry carries that value.

## Failure scenario

Resume moves time or holds stale busy entries.

## Timing windows and dependencies

None.

## What a test must construct

An interrupt and resume.

## Investigation log

No open questions.
