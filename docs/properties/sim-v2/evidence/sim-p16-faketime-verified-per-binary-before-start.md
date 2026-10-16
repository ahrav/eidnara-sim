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

M4 (#1028) provides the per-binary interception test as `preflight`: Pi's Node
runtime and the Bun-compiled OpenCode binary print a jumped clock and keep a
100 ms timer, and the daemon binary's own `clock_gettime` import binds to the
interposer. A binary that fails is recorded `wall_clock_only`. Tests run the
real launcher, a binary that drops the interposer, and a binary whose own code
leaves `clock_gettime` unbound. On this host all three intercept.

The run command (`docs/run-command.md`) calls `preflight` on every
invocation before the scheduler journals its first entry, keeps the first
result in the run manifest, and refuses to resume when an interception result
changes. The daemon probe runs the `direct_host_fixture` the hermetic host
stack launches. The live witness runs on 2026-10-16 recorded Pi's Node
runtime, OpenCode 1.18.22, and the fixture as intercepted.

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
