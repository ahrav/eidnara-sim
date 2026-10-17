# sim-p09-tier-has-forced-p90-sessions

Evidence status: PROPOSED. SIM-P09, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A compiled scenario has at least three sessions in the p90 request-count regime.

M1 (#1025) lands the enabling state. `corpus/distributions.json` holds the
fitted `requests_per_session` table (TraceLab v0.0.2, n = 8,058 sessions, p90
= 16). `sampleSession` in `src/corpus/sampler.ts` takes a tail floor, and the
SIM-P09 test in `src/corpus/corpus.test.ts` shows that a 0.9 floor yields only
sessions at or above the fitted p90. The compile-time count of three such
sessions per scenario lands in M2.

M2 (#1026) draws the request count of `forced_p90_sessions` sessions from the
tail above p90, with an equal share per base project spread evenly over that
project's sessions, and then pads each forced session to the P13 turn range
(30 turns per P13 item it hosts). A
test over 100 S seeds checks that each scenario has at least the pre-registered
number of forced sessions and that each holds at least the fitted p90 request
count. That count holds through the padding alone, so the scenario test
witnesses the regime, and the M1 sampler test witnesses the tail draw.

## Failure scenario

Fold and compaction paths are never exercised and P13 and P14 have no items.

## Timing windows and dependencies

None - compile time.

## What a test must construct

The fitted request-count distribution from M1.

## Investigation log

No open questions.
