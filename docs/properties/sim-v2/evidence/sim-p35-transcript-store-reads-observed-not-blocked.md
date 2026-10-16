# sim-p35-transcript-store-reads-observed-not-blocked

Evidence status: PROPOSED. SIM-P35, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A read under `~/.pi/agent/sessions` or `opencode.db` by the `host` arm produces
a read observation, and the read succeeds with command exit and bytes
unaffected.

No harness code, test, or run exists yet. The surface lands in M8
(#1034).

## Failure scenario

The control arm is handicapped or its transcript search goes unattributed.

## Timing windows and dependencies

Host upgrades may move the store; the path table is verified per host version at
run start.

## What a test must construct

A host-arm session that searches its own transcript.

## Investigation log

### Q: OQ-7
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-7: the transcript-store path table per host version. Unresolved, needs
  verification at each run start.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run

### Q: OQ-13
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-13: whether host transcript timestamps persisted under a scenario jump
  affect D2 attribution or session ordering. Unresolved, measured after the
  first S run.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
