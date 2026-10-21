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

M4 (#1028) provides the per-binary interception test as `preflight`: Pi's Node
runtime and the Bun-compiled OpenCode binary print a jumped clock and keep a
100 ms timer, and the daemon binary's own `clock_gettime` import binds to the
interposer. A binary that fails is recorded `wall_clock_only`. Tests run the
real launcher, a binary that drops the interposer, and a binary whose own code
leaves `clock_gettime` unbound. On this host all three intercept.

The run command (`docs/run-command.md`) calls `preflight` on every
invocation before the scheduler journals its first entry, keeps the first
result in the run manifest, journals a `Preflight` entry with the
per-binary interception results before `StartRun` or `ResumeRun`, and
refuses to resume when an interception result changes. The daemon probe runs the `direct_host_fixture` the hermetic host
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
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files;
  `src/run/time.test.ts`; the `Preflight` journal entries of the 2026-10-16
  live witness runs (`witness-8`, `docs/run-command.md`).
- Findings: OQ-9 asked whether the Bun-compiled OpenCode binary reads time
  through libc. The per-binary interception test launches OpenCode 1.18.22
  under the real sandbox launcher with the interposer and requires a jumped
  clock and a kept 100 ms timer; `src/run/time.test.ts` passes on this host,
  and every `Preflight` entry of the `scheduled`, `rogue`, and `resume`
  journals records `opencode` as intercepted.
- Missing evidence: none for this release; a later OpenCode release is
  re-tested by the same preflight before each `StartRun`.
- Conclusion: resolved, OpenCode reads time through libc and is intercepted.
