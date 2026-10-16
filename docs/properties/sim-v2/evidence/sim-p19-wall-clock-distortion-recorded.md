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

M4 (#1028) records in every preflight result that monotonic clocks stay real,
that provider-side time, cache warmth, and rate limits follow wall time, and
that host clocks lead scenario time between jumps, plus a line for each
wall-clock-only binary; a test checks the list. Call records carry cache read
and write tokens from M3.

## Failure scenario

A reader attributes prompt-cache effects to scenario time.

## Timing windows and dependencies

None.

## What a test must construct

Any run with provider calls.

## Investigation log

No open questions.
