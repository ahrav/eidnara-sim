# sim-p15-proxy-record-carries-both-times

Evidence status: PROPOSED. SIM-P15, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every call record has `scenario_ms` equal to the clock at receipt and a
`wall_ms`, and `wall_ms` is non-decreasing in sequence order.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

## Failure scenario

Latency and age cannot be reconstructed for a call.

## Timing windows and dependencies

A call that arrives during an `AdvanceClock` must take one value consistently.

## What a test must construct

Proxy traffic during and around an idle jump.

## Investigation log

No open questions.
