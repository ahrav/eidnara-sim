# sim-p01-scenario-compile-is-deterministic

Evidence status: PROPOSED. SIM-P01, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Compiling a scenario twice from the same seed, tier, generator version, and
corpus manifest yields byte-identical event lists and an equal `scenario_hash`,
across processes.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

M2 (#1026) lands the compiler in `src/scenario/compile.ts`. Every random draw
comes from a seeded stream per domain, and the scenario is written as canonical
JSON with `scenario_hash` over it. The SIM-P01 tests in
`src/scenario/compile.test.ts` run `scripts/compile-scenario.ts` twice in
separate processes for one seed per tier and compare the bytes and the hash.

## Failure scenario

Arms of one seed see different worlds and every paired comparison is invalid.

## Timing windows and dependencies

None - compilation is offline and single-threaded.

## What a test must construct

Two compiler processes on one input tuple; a corpus manifest with at least one
entry per sampled quantity.

## Investigation log

No open questions.
