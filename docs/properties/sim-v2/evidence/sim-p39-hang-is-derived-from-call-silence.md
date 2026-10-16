# sim-p39-hang-is-derived-from-call-silence

Evidence status: PROPOSED. SIM-P39, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A turn is `hang` iff its wall duration exceeds 5 minutes with no call record
from the agent's component in that window, or a completed model call is followed
by no persistence or tool execution within the bound; the turn ends `failed`
with cause `hang`.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

## Failure scenario

The intermittent Pi hang goes undetected or a slow turn is mislabelled.

## Timing windows and dependencies

The observed Pi hang had a completed model call.

## What a test must construct

A turn with a completed call and no follow-up.

## Investigation log

No open questions.
