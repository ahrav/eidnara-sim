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

The bound starts at `BeginTurn` or `RegisterJob` in wall time.

## What a test must construct

A fault-free window after load, then a poll of open turns and jobs against the
bound.

## Investigation log

### Q: Is the starting value tight enough?
- Sources examined: spec #1007 OQ-6; the v1 baseline runs.
- Findings: the v1 Pi hang held a turn far past 15 minutes.
- Missing evidence: an S run with the v2 scheduler.
- Conclusion: unresolved, needs the S run
