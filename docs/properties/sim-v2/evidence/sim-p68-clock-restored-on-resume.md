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

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

Resume moves time or holds stale busy entries.

## Timing windows and dependencies

None.

## What a test must construct

An interrupt and resume.

## Investigation log

No open questions.
