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

M4 (#1028) journals `ItemState failed(interrupted)` and `Event` once for a
`BeginTurn` without `EndTurn` when a run resumes; the resume test checks both
entries.

The live witness (`tests/witness-faults.ts`, `docs/run-command.md`) on 2026-10-16
killed a live Pi run with one model call of `e-000007` recorded; after the
resume, `e-000007` had one `ItemState failed(interrupted)` and one `Event`,
and no later call carried its id.

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
