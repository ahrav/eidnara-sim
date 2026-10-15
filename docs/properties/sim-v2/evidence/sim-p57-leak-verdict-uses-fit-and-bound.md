# sim-p57-leak-verdict-uses-fit-and-bound

Evidence status: PROPOSED. SIM-P57, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The leak verdict reports slope, R squared, and the inequality `RSS(T) < 2 *
RSS(0) + N_sessions * c` with `c` from the pre-registration, and samples every
10 seconds of wall time carry scenario and wall time.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

## Failure scenario

The observed linear RSS growth is missed or misreported.

## Timing windows and dependencies

Warmup and cooldown phases distort a naive slope.

## What a test must construct

A soak run with sampler output.

## Investigation log

No open questions.
