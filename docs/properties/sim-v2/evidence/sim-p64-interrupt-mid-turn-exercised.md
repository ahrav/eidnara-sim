# sim-p64-interrupt-mid-turn-exercised

Evidence status: PROPOSED. SIM-P64, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A harness kill lands while an item is `issued` at least once per campaign.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) exercises an interrupt mid-turn: a resume test kills the harness
with SIGKILL while a turn is in flight and billed.

## Failure scenario

The in-flight resolution path is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

A scheduled harness kill.

## Investigation log

No open questions.
