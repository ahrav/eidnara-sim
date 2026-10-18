# sim-p46-failed-turn-item-is-not-a-grade

Evidence status: PROPOSED. SIM-P46, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

An item whose probe turn ended `failed` has no grade version and is counted in
dependability metrics; recall and harm rates name their excluded-failed count.

M5 (#1029) returns no grade for a snapshot whose probe turn failed; a test
checks it.

## Failure scenario

An arm is penalised in recall for provider faults it did not cause, or failures
vanish.

## Timing windows and dependencies

Provider faults fail turns.

## What a test must construct

A provider fault during a probe turn.

## Investigation log

### Q: OQ-5 is resolved in the M0 pre-registration
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-5 is resolved in the M0 pre-registration: failed-turn items are excluded
  from recall denominators with the excluded count named per arm.
- Missing evidence: a harness run that exercises the record.
- Conclusion: resolved with answer
