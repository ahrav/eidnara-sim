# sim-p03-divergence-is-recorded-never-hidden

Evidence status: PROPOSED. SIM-P03, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

If the agent-visible context hash differs at `event_idx` between two arms, a
divergence record with that index and both hashes exists before the next
`IssueUserText` for either arm.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

## Failure scenario

A diverged pair is analysed as paired and the report overstates pairing.

## Timing windows and dependencies

The divergence check runs between `EndTurn` and the next `IssueUserText`; a
crash in that window must not drop the record.

## What a test must construct

Two arms whose agent outputs differ after normalisation.

## Investigation log

### Q: See the record
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: Same as SIM-P02: the hash input is pre-registered in `divergence_policy`; the
  diagnostic full-prefix hash is recorded beside it.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
