# sim-p75-arm-config-fixed-for-run

Evidence status: PROPOSED. SIM-P75, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The run header records each arm's host, plugin presence, `compaction.enabled`,
agent model, and capture model, and no arm's config changes except by a
scheduled model-switch fault.

No harness code, test, or run exists yet. The surface lands in M8
(#1034).

## Failure scenario

Arms differ in more than the treatment.

## Timing windows and dependencies

A plugin reload may reset config.

## What a test must construct

A run with a model switch.

## Investigation log

### Q: How does a model-switch run meet the fixed-model boundary?
- Sources examined: `docs/claim-boundary.md` ("the agent model is fixed per
  run"); spec #1007 fault catalogue (model switch as a scheduled fault); this
  record's exception for scheduled model switches.
- Findings: the guarantee permits a config change by scheduled model switch; the
  boundary states the agent model is fixed per run; no record or policy says how
  observations across the switch enter a paired gate.
- Missing evidence: a decision on exclusion, stratification, or boundary text.
- Conclusion: needs human input
