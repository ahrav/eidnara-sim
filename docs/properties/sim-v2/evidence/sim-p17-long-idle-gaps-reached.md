# sim-p17-long-idle-gaps-reached

Evidence status: PROPOSED. SIM-P17, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

An idle gap longer than 5 minutes and a gap longer than 1 hour occur in scenario
time.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

## Failure scenario

Resume-after-gap behaviour (P6) is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

The fitted idle-gap distribution with its tail.

## Investigation log

No open questions.
