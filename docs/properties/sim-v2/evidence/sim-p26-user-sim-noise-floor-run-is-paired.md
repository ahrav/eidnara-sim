# sim-p26-user-sim-noise-floor-run-is-paired

Evidence status: PROPOSED. SIM-P26, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The same-config paired run shares `scenario_hash` and arm config and differs
only in user-sim seed, and the report names its disagreement rate.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

## Failure scenario

The user-sim's own noise is read as a treatment effect.

## Timing windows and dependencies

None.

## What a test must construct

An A/A run per tier.

## Investigation log

No open questions.
