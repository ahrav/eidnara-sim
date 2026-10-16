# sim-p69-cf-deletion-recorded-with-identity

Evidence status: PROPOSED. SIM-P69, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every `DeleteMemoryObject` journals `object_id`, object kind, `scenario_ms`, and
`target_item_id`, and precedes the target item's `BeginTurn`.

No harness code, test, or run exists yet. The surface lands in M9
(#1035).

## Failure scenario

Attribution cannot name the deleted object.

## Timing windows and dependencies

None.

## What a test must construct

An L run with the `eidnara-cf` arm.

## Investigation log

### Q: OQ-4 is resolved
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-4 is resolved: deletion only in the first scope; alteration is out of
  scope.
- Missing evidence: a harness run that exercises the record.
- Conclusion: resolved with answer
