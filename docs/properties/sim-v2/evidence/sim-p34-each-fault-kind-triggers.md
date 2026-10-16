# sim-p34-each-fault-kind-triggers

Evidence status: PROPOSED. SIM-P34, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Each fault kind triggers at least once: 429, 5xx, timeout,
`finish_reason=length`, silent cut, empty content, schema-wrong tool call, slow
stream, SIGKILL mid-fold, restart between sessions, ENOSPC, plugin reload, host
upgrade, model switch, two clients on one daemon, and laptop sleep.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

## Failure scenario

A fault kind's recovery path is never tested.

## Timing windows and dependencies

SIGKILL must land inside an in-progress fold.

## What a test must construct

The full fault catalogue scheduled across M, L, and XL.

## Investigation log

### Q: OQ-8
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-8: see SIM-P31 for the mid-fold SIGKILL evidence shape.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
