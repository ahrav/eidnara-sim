# sim-p60-journal-has-one-writer

Evidence status: PROPOSED. SIM-P60, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A run directory holds one exclusive claim, and a second `StartRun` or
`ResumeRun` on the same directory is refused before any write.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

Two writers interleave sequence numbers and corrupt the journal.

## Timing windows and dependencies

Two harness processes started near-simultaneously.

## What a test must construct

A live claim and a second process.

## Investigation log

No open questions.
