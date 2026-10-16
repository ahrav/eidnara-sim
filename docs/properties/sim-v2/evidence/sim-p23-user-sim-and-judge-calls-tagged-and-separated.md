# sim-p23-user-sim-and-judge-calls-tagged-and-separated

Evidence status: PROPOSED. SIM-P23, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every user-sim and judge call record has component `user-sim` or `judge`, and
`CostByComponent` excludes them from agent, capture, summarizer, and title cost.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

## Failure scenario

Eidnara's cost ratio includes the harness's own model spend.

## Timing windows and dependencies

None.

## What a test must construct

User-sim and judge calls through the proxy.

## Investigation log

No open questions.
