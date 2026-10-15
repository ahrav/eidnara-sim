# sim-p70-cf-deletion-verified

Evidence status: PROPOSED. SIM-P70, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A deletion record carries a verification observation, object absent from the
store or a store API ack; an unknown outcome marks the target item
`excluded(cf-unverified)`.

No harness code, test, or run exists yet. The surface lands in M9
(#1035).

## Failure scenario

A flip is attributed to a deletion that did not happen.

## Timing windows and dependencies

The store may reject or defer the deletion.

## What a test must construct

A deletion against a live daemon.

## Investigation log

No open questions.
