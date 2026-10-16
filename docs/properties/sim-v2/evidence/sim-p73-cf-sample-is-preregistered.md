# sim-p73-cf-sample-is-preregistered

Evidence status: PROPOSED. SIM-P73, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The 20% sample of P1, P3, and P5 items for the counterfactual arm is derived
from the seed at compile and journaled before `StartRun`.

M2 (#1026) draws the sample at compile: `compileScenario` shuffles the P1, P3,
and P5 probes with the seed's own `counterfactual` stream, takes the first 20%
rounded, and writes each deletion's probe, fact, and preceding event to the
scenario file's `cf_deletions` list (`src/scenario/compile.ts:687-693`) when
the tier runs the `eidnara-cf` arm. The scenario file is byte-stable per seed
and precedes any run. Tests check that an L compile samples 20% of the eligible
probes with distinct entries, that two seeds draw different samples, that each
deletion names its probe's fact and event, and that S, M, and XL schedule no
deletions (`src/scenario/compile.test.ts:869-910`). The journal entry before
`StartRun` lands with the runner in M4.

## Failure scenario

The counterfactual sample is chosen after seeing outcomes.

## Timing windows and dependencies

None.

## What a test must construct

An L scenario compile.

## Investigation log

No open questions.
