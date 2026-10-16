# sim-p16-faketime-verified-per-binary-before-start

Evidence status: PROPOSED. SIM-P16, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`StartRun` is preceded by a journaled interception test per host binary (Pi,
OpenCode, daemon) that read a faked time; a failure records the binary
wall-clock-only or refuses the run.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

A binary silently runs on wall time and every scenario-time claim about it is
false.

## Timing windows and dependencies

The setuid sandbox boundary strips `LD_*`, so injection must follow privilege
drop.

## What a test must construct

The real sandbox launcher, the interposer on a kept mount, and each host binary.

## Investigation log

### Q: OQ-9
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-9: whether the Bun-compiled OpenCode binary reads time through libc.
  Unresolved, needs the per-binary interception test at the first S
  `StartRun`.
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
