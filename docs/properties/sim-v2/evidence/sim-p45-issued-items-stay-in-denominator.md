# sim-p45-issued-items-stay-in-denominator

Evidence status: PROPOSED. SIM-P45, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every item that reached `issued` appears in exactly one of graded, failed, or
excluded with a reason; abstention (P9) and over-application (P2, P10, P11) are
grades, not exclusions.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

## Failure scenario

Denominators shrink to flatter an arm.

## Timing windows and dependencies

An interrupt mid-item must resolve to one class.

## What a test must construct

A run with an interrupt and abstentions.

## Investigation log

No open questions.
