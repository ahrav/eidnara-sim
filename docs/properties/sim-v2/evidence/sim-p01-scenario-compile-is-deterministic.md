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

## Failure scenario

Arms of one seed see different worlds and every paired comparison is invalid.

## Timing windows and dependencies

None - compilation is offline and single-threaded.

## What a test must construct

Two compiler processes on one input tuple; a corpus manifest with at least one
entry per sampled quantity.

## Investigation log

No open questions.
