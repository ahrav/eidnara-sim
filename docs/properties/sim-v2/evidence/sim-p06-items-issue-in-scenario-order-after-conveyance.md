# sim-p06-items-issue-in-scenario-order-after-conveyance

Evidence status: PROPOSED. SIM-P06, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`BeginTurn` for a probe item occurs at `scenario_ms` at or after the item's
scheduled time and after every conveyance event the item depends on has reached
`EndTurn` in that arm.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

M2 (#1026) places every probe turn after each conveyance, update, and diff of
its fact in the compiled event order, and the compiler refuses a scenario where
a probe precedes one. The SIM-P06 test in `src/scenario/compile.test.ts` checks
the order and the scheduled times. The per-arm `BeginTurn` and `EndTurn` check
lands with the scheduler in M4.

## Failure scenario

A probe tests a fact that was never conveyed and is scored as a miss.

## Timing windows and dependencies

A conveyance turn that fails or times out leaves the probe without its fact.

## What a test must construct

A probe item with at least one conveyance dependency; a conveyance turn that
ends `failed`.

## Investigation log

### Q: What happens to a probe whose conveyance failed?
- Sources examined: spec #1007 index (SIM-P06); this record's fault angle ("a
  conveyance turn that fails or times out leaves the probe without its fact");
  SIM-P45 and SIM-P46 on excluded and failed items.
- Findings: the guarantee orders the probe after the conveyance `EndTurn` and
  says nothing about the conveyance outcome; a failed conveyance satisfies it
  and the probe then measures a delivery failure as a recall miss.
- Missing evidence: the M4 scheduler's rule for a dependency that failed.
- Conclusion: needs human input
