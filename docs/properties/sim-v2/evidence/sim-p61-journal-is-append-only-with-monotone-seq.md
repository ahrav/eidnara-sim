# sim-p61-journal-is-append-only-with-monotone-seq

Evidence status: PROPOSED. SIM-P61, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Entries have strictly increasing `seq`, no entry is rewritten, and a partial
trailing entry is detected on load.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

Resume reads a corrupt entry as valid.

## Timing windows and dependencies

A kill mid-write leaves a partial line.

## What a test must construct

A harness kill during a journal append.

## Investigation log

No open questions.
