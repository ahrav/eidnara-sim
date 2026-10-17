# sim-p77-two-hosts-one-store-attributed

Evidence status: PROPOSED. SIM-P77, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

With two host clients on one daemon, every call record and transcript read names
its host pid and arm, and store-level observations are attributed to the writer
pid.

No harness code, test, or run exists yet. The surface lands in M10
(#1036).

## Failure scenario

Effects of one client are attributed to the other.

## Timing windows and dependencies

The instance lock admits one daemon per data directory.

## What a test must construct

Two host clients attached to one daemon.

## Investigation log

### Q: OQ-10
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-10: whether two host clients can attach to one daemon concurrently and
  whether the plugin reconnects after SIGKILL without a host restart.
  Unresolved, observed at L and XL (needs human input).
- Missing evidence: a harness run that exercises the record.
- Conclusion: needs human input
