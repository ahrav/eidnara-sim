# sim-p22-each-ledger-fact-conveyed-once-in-assigned-manner

Evidence status: PROPOSED. SIM-P22, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

For every ledger fact, exactly one conveyance event with the compiled manner and
session is journaled as delivered; reversal facts have exactly two, the
statement and the reversal.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

M6 (#1031) delivers every conveyance, update, and reversal turn with its
compiled text; a reply placed in front of one is written from a prompt that
leaves the fact out, and abandon skips only filler turns. `pairing-check.ts`
fails a run that leaves a non-filler turn unsent.

## Failure scenario

Recall is measured on facts conveyed a different number of times than planned.

## Timing windows and dependencies

A conveyance turn that fails is retried by the user-sim and conveys twice.

## What a test must construct

The conveyance plan with every manner, including stated-then-reversed facts.

## Investigation log

No open questions.
