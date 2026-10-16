# sim-p76-kl-arm-has-host-compaction-on

Evidence status: PROPOSED. SIM-P76, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`eidnara-kl` runs with Eidnara's `compaction.enabled=false` and host compaction
enabled, and at least one `native_compaction` call record exists in a p90
session.

No harness code, test, or run exists yet. The surface lands in M8
(#1034).

## Failure scenario

The knowledge-layer comparison arm is not the configuration it claims.

## Timing windows and dependencies

None.

## What a test must construct

A p90 session in the `eidnara-kl` arm.

## Investigation log

No open questions.
