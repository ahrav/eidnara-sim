# sim-p51-gate-reads-completed-pairs-only

Evidence status: PROPOSED. SIM-P51, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`EvaluateGate` input set equals `CompletedPairs(tier)` at `journal_seq_at_eval`,
and the verdict carries excluded-pair count and ids.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

A gate passes on a selected subset of pairs.

## Timing windows and dependencies

A gate evaluated while items are in flight.

## What a test must construct

A tier with an in-flight item at evaluation.

## Investigation log

No open questions.
