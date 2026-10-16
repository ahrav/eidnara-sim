# sim-p19-wall-clock-distortion-recorded

Evidence status: PROPOSED. SIM-P19, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The run header records that provider-side time is wall-clock, and each call
record carries cache read and write tokens so prompt-cache warmth is
reconstructible.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

## Failure scenario

A reader attributes prompt-cache effects to scenario time.

## Timing windows and dependencies

None.

## What a test must construct

Any run with provider calls.

## Investigation log

No open questions.
