# sim-p58-harm-metric-direction

Evidence status: PROPOSED. SIM-P58, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

"Memory made it worse" is set iff some harm metric has `eidnara < host` with the
paired CI excluding zero, and the metric and CI are named.

No harness code, test, or run exists yet. The surface lands in M7
(#1032).

M7 (#1032) names each harm metric whose verdict is `worse`, meaning the treatment arm's harm rate is higher with the Holm-adjusted exact McNemar significant and the interval excluding zero, in `memory_made_it_worse` with its interval.

## Failure scenario

Harm is reported in the wrong direction or not at all.

## Timing windows and dependencies

None.

## What a test must construct

Harm family results.

## Investigation log

No open questions.
