# sim-p17-long-idle-gaps-reached

Evidence status: PROPOSED. SIM-P17, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

An idle gap longer than 5 minutes and a gap longer than 1 hour occur in scenario
time.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

M1 (#1025) lands the idle tail. `corpus/distributions.json` holds the fitted
`idle_within_session_s` table (TraceLab v0.0.2, n = 70,163 gaps, p99 about
11.3 h). The SIM-P17 test in `src/corpus/corpus.test.ts` draws 10,000
sessions and finds gaps above the cited p99 band floor and above 11 h. The
scenario-level reachability check lands in M2.

## Failure scenario

Resume-after-gap behaviour (P6) is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

The fitted idle-gap distribution with its tail.

## Investigation log

No open questions.
