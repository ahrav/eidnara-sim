# sim-p63-in-flight-item-resolved-once-on-resume

Evidence status: PROPOSED. SIM-P63, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

An item `issued` but not `attempted` at interrupt becomes exactly one of
`failed(interrupted)` or `reissued(marker)`, and its pre-interrupt calls are
billed once.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) journals `ItemState failed(interrupted)` and `Event` once for a
`BeginTurn` without `EndTurn` when a run resumes, and a later resume writes
neither again. One resume test kills after `BeginTurn` and before the fixture
bills the turn, the `issued` state, and checks both entries and that the
interrupted turn is billed nowhere; another kills after the bill.

## Failure scenario

An interrupted item is counted twice or vanishes.

## Timing windows and dependencies

The interrupt lands mid-turn.

## What a test must construct

A harness kill while an item is issued.

## Investigation log

### Q: OQ-1 is resolved in the M0 pre-registration
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-1 is resolved in the M0 pre-registration: an in-flight item at interrupt is
  `failed(interrupted)`, excluded from recall denominators, and counted in
  dependability.
- Missing evidence: a harness run that exercises the record.
- Conclusion: resolved with answer
