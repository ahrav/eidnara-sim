# sim-l03-tier-completes-within-wall-budget

Evidence status: PROPOSED. SIM-L03, from OQ-6 in spec
[ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007), resolved
in the M0 pre-registration.

## Discovery trigger

OQ-6 asked for per-event and per-tier liveness bounds. M0 pre-registers them
as `liveness_bounds` in `prereg/<tier>.json`.

## Evidence trail

A tier run completes within its pre-registered wall budget: S 2 hours, M 10
hours, L 30 hours, XL 96 hours.

## Failure scenario

A turn or background job that never ends holds the scenario clock, and the
tier exhausts its wall budget without a verdict.

## Timing windows and dependencies

The bound runs from `StartRun` to the last arm's done marker in wall time, per
tier.

## What a test must construct

A complete tier run, then a comparison of its elapsed wall time against the
tier's `tier_wall_budget_ms`.

## Investigation log

### Q: Is the starting value tight enough?
- Sources examined: spec #1007 OQ-6 and its wall-clock range of 1 hour to 4 days
  per tier; the v1 baseline runs.
- Findings: the four budgets sit inside the spec's range; the v1 Pi hang held a
  turn far past 15 minutes, a large share of the 2 hour S budget.
- Missing evidence: an S run with the v2 scheduler.
- Conclusion: unresolved, needs the S run
