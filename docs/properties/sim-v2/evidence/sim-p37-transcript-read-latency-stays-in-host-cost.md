# sim-p37-transcript-read-latency-stays-in-host-cost

Evidence status: PROPOSED. SIM-P37, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Tokens and latency of turns containing transcript reads are attributed to the
`host` arm's cost and latency metrics, with no exclusion.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

The cost and latency comparison understates the host arm's effort.

## Timing windows and dependencies

None.

## What a test must construct

A host-arm turn with a transcript read.

## Investigation log

No open questions.
