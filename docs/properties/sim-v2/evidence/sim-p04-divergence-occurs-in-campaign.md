# sim-p04-divergence-occurs-in-campaign

Evidence status: PROPOSED. SIM-P04, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

At least one arm pair diverges before the last event of its run.

The live `usersim-1` run diverged in three of its ten sessions, each at the second user turn.

## Failure scenario

The replay-to-live transition is never exercised and its defects stay hidden.

## Timing windows and dependencies

None.

## What a test must construct

Live models at production temperature; a run long enough for outputs to differ.

## Investigation log

No open questions.
