# sim-p10-user-sim-event-mix-matches-distribution-bounds

Evidence status: PROPOSED. SIM-P10, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Pushback, interrupt, redirect, and abandon rates over the run fall inside
pre-registered tolerance bands around the fitted targets, and the realised rates
are journaled.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

M1 (#1025) lands the rate inputs. `corpus/distributions.json` carries
pushback and interrupt rates per turn and redirect and abandon rates per
session, each quoted from the SWE-chat paper v2 because the SWE-chat tables
are gated. The abandon rate is a band (0.1 to 0.3) taken from the paper's
sensitivity analysis, since the dataset does not capture abandoned sessions.
The SIM-P10 test in `src/corpus/corpus.test.ts` checks that every rate has a
quote and a value or band in [0, 1]. The user-sim check against these bands
lands in M6.

## Failure scenario

Results generalise to a user population the corpus does not describe.

## Timing windows and dependencies

The live user-sim after divergence may drift outside the band.

## What a test must construct

A full run with user-sim labels on every turn.

## Investigation log

No open questions.
