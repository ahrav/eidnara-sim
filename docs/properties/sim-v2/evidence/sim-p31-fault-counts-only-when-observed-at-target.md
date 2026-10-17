# sim-p31-fault-counts-only-when-observed-at-target

Evidence status: PROPOSED. SIM-P31, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A fault instance is `triggered` only with evidence: for provider faults, a call
record from the target component carrying `fault_ref`; for infrastructure
faults, the observing oracle's record from the target component.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

M3 (#1027) counts an episode as `fired` only with an injected record and a
host-observed agent call within the window after the injection. Tests run every
provider fault type under every strategy against a host stand-in and check both
witnesses.

## Failure scenario

A fault that never reached its target is counted as survived.

## Timing windows and dependencies

Provider faults enter downstream of the proxy retry; the host SDK must see them.

## What a test must construct

Each fault kind with its target component active.

## Investigation log

### Q: OQ-8
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-8: the evidence shape proving a SIGKILL landed inside an in-progress fold.
  Candidate: a summarizer call record in flight at the kill wall time.
  Unresolved, needs the daemon's fold-start signal (needs human input).
- Missing evidence: a harness run that exercises the record.
- Conclusion: needs human input
