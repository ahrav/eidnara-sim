# sim-p43-judge-hygiene-on-p7-only

Evidence status: PROPOSED. SIM-P43, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every judge call has `component = judge`, a model family that differs from the
agent model, no arm label in the prompt, both position orders per item, and the
calibration digest recorded.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

## Failure scenario

The P7 judge identifies arms or prefers its own family.

## Timing windows and dependencies

None.

## What a test must construct

P7 items with a calibration set.

## Investigation log

No open questions.
