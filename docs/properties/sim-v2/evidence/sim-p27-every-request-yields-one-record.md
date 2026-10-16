# sim-p27-every-request-yields-one-record

Evidence status: PROPOSED. SIM-P27, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Proxy requests received equal call records journaled per arm, including refused
requests recorded as `rejected`.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

M3 (#1027) writes one record per request, including requests the gateway
rejects for an unknown route or a malformed body; a test checks both rejection
records.

## Failure scenario

Cost and fault evidence silently drop calls.

## Timing windows and dependencies

A client disconnect mid-stream must still yield one record.

## What a test must construct

A run with a refused request and a client disconnect.

## Investigation log

No open questions.
