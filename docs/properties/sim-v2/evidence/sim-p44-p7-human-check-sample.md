# sim-p44-p7-human-check-sample

Evidence status: PROPOSED. SIM-P44, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A 10% sample of P7 items per tier is journaled as `human_check_pending` before
the tier verdict, and the verdict names the sample.

Before M5 (#1029) no harness code, test, or run existed; the surface landed
with M5.

M5 (#1029) draws a seeded 10% sample of P7 items, rounded up, for
`human_check_pending`; a test checks the count and its reproducibility.
Journaling the sample before the tier verdict lands with the report (M7).

## Failure scenario

Judge calibration drifts with no human anchor.

## Timing windows and dependencies

None.

## What a test must construct

A tier with P7 items.

## Investigation log

### Q: Must the human check complete before the verdict?
- Sources examined: spec #1007 (judge calibration for P7: at least 10% human
  labelled per the eval-core sampling plan); this record; the relationship map
  (P43 and P44 gate P7).
- Findings: the record requires the pending entries to precede the verdict and
  says nothing about their completion, so a verdict with no returned label
  satisfies it.
- Missing evidence: the M5 grader's handling of pending human checks.
- Conclusion: needs human input
