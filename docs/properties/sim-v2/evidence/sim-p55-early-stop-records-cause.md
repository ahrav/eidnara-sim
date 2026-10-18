# sim-p55-early-stop-records-cause

Evidence status: PROPOSED. SIM-P55, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A CUSUM early stop journals the metric, the item ids in the stopping window, and
`journal_seq_at_eval`, and items already issued continue to terminal state.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

M7 (#1032) records a CUSUM stop with its kind, metric, signal index, and the item ids since the sum last stood at zero, and the evaluation's journal sequence; a stop withholds the pass. Items already issued continuing to terminal state is the scheduler's part and is not exercised here.

## Failure scenario

An early stop hides its cause or abandons issued items.

## Timing windows and dependencies

A stop arrives while items are in flight.

## What a test must construct

A harm or futility signal in a sequence.

## Investigation log

No open questions.
