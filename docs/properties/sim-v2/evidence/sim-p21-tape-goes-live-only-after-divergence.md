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

M6 (#1031) keys a reply by the session's chained normalised agent digests, so
a sibling arm's first live reply follows the turn whose digest first differed
from the reference's, which is the turn its `divergedAt` record names; a
replay with one changed agent output records one divergence against the
recorded run and makes live calls after it, and two arms with the same outputs
share replies whatever the run order.

Contract versus code: the catalog indexes the divergence record by a run-wide
`event_idx`; the code records it with the session's turn `index` in
`<run>/pairing.jsonl`, and a sibling arm's first live call in a session
follows its `divergedAt` record for that session: the tape key carries the
session's chained digests (`context_sha256`, built in `UserSim.deliver`), so a
context that left the reference's has no taped reply to find.

## Failure scenario

Paired arms receive different user text before divergence.

## Timing windows and dependencies

None.

## What a test must construct

A sibling arm that diverges.

## Investigation log

No open questions.
