# sim-p08-cue-and-probe-are-lexically-dissimilar

Evidence status: PROPOSED. SIM-P08, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

For every cue and probe pair, the pre-registered BM25 and embedding similarity
are below threshold at compile, and the scores are journaled.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

## Failure scenario

Recall is measured by lexical overlap and `grep` over a flat file wins.

## Timing windows and dependencies

None - compile time.

## What a test must construct

The conveyance plan and probe plan with their texts.

## Investigation log

No open questions.
