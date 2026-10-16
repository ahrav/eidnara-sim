# sim-p20-tape-replays-while-context-matches

Evidence status: PROPOSED. SIM-P20, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A sibling arm in `replaying` mode receives the tape's text for `event_idx` when
its context hash equals the tape's recorded hash, and no user-sim model call is
made for that event.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

M6 (#1031) replays a reply from the tape when its key (seed, event, label,
normalised digest) matches, with no model call; tests replay a one-arm and a
two-arm run against their recorded outputs with zero live calls. A reply the
proxy record cut at 32,768 characters is keyed by the digest of the whole text
as well, so two replies that differ only past the cut never pair.

## Failure scenario

Paired arms receive different user text before divergence.

## Timing windows and dependencies

The hash comparison races the agent's final output flush.

## What a test must construct

Two arms of one seed with matching outputs at least once.

## Investigation log

### Q: OQ-3
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-3: see SIM-P02.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
