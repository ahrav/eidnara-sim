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

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) links a numbered lease file into the run directory before opening
the journal; a takeover links the next number, which exactly one racing
resumer can create. Tests check that a live holder and a holder on another
host are refused, that a dead lease is taken over and a damaged one refuses
the directory, and that
eight processes resuming a dead lease at once produce one holder and seven
refusals. A second fixture harness started once the first holds the lease and has
journaled `StartRun` is refused with `is leased by pid`, and the journal ends
with one `StartRun`, no `ResumeRun`, and the first harness's `EndRun`.

## Failure scenario

Two writers interleave sequence numbers and corrupt the journal.

## Timing windows and dependencies

Two harness processes started near-simultaneously.

## What a test must construct

A live claim and a second process.

## Investigation log

No open questions.
