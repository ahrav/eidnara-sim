# sim-p38-cost-conserves-by-component

Evidence status: PROPOSED. SIM-P38, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Per-arm total tokens equal the sum of per-component tokens, and per-component
cost uses the journaled price table version.

Before M5 (#1030) no harness code, test, or run existed; the token ledger
landed with M5 and pricing lands with the report (M7, #1032).

M5 (#1030) sums input, output, cache-read, and cache-write tokens per
component and per arm in `ledger` (`src/oracle/oracles.ts`), leaving out the
harness's own user-sim, judge, and refused calls; the per-arm total is the
per-component sum. `src/oracle/oracles.test.ts` ("token ledger") asserts the
four fields, the exclusion, and the sum on constructed calls. No tier run has
exercised it yet.

## Failure scenario

Cost ratios are computed on tokens that do not add up.

## Timing windows and dependencies

None.

## What a test must construct

A run with every component active.

## Investigation log

No open questions.
