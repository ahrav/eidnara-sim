# sim-p21-tape-goes-live-only-after-divergence

Evidence status: PROPOSED. SIM-P21, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The first user-sim model call for a sibling arm at `event_idx` has a divergence
record with index at most `event_idx`.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

M6 (#1031) keys an arm's replies by the arm only after its `divergedAt` record, so the first live reply of a sibling arm follows that record; a replay with one changed agent output records one divergence against the recorded run and makes live calls after it.

## Failure scenario

Paired arms receive different user text before divergence.

## Timing windows and dependencies

None.

## What a test must construct

A sibling arm that diverges.

## Investigation log

No open questions.
