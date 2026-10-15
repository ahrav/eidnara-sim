# sim-p71-cf-arm-paired-to-eidnara-until-deletion

Evidence status: PROPOSED. SIM-P71, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`eidnara-cf` shares tape and event prefix with `eidnara`, and its divergence
index is at or after the first deletion's event index.

No harness code, test, or run exists yet. The surface lands in M9
(#1035).

## Failure scenario

The counterfactual differs from the treatment for reasons other than the
deletion.

## Timing windows and dependencies

None.

## What a test must construct

An L run with both arms.

## Investigation log

No open questions.
