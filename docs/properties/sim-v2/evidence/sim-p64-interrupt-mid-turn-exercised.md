# sim-p64-interrupt-mid-turn-exercised

Evidence status: PROPOSED. SIM-P64, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A harness kill lands while an item is `issued` at least once per campaign.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

The in-flight resolution path is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

A scheduled harness kill.

## Investigation log

No open questions.
